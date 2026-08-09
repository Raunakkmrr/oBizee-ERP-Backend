import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";

/**
 * Where the refresh token lives once it leaves here.
 *
 * It used to be handed to the browser in a JSON body, and the web app kept it
 * in `localStorage` — which any injected script can read, and thirty days is a
 * long time to hold a key somebody can pick up. An httpOnly cookie cannot be
 * read by script at all.
 *
 * **What makes this possible now.** The app and the API will sit on different
 * subdomains of one domain, so they are *same-site* even though they are
 * cross-origin. `SameSite=Lax` therefore lets the cookie ride, and CORS with
 * credentials handles the cross-origin part. On a genuinely different domain
 * this would need `SameSite=None`, which is a weaker thing to have to say.
 *
 * `Path=/auth` is deliberate: the token is only ever exchanged or revoked, both
 * of which live under `/auth`. Every ordinary API request goes without it, so
 * the credential is not sprayed across four hundred calls that have no use for
 * it. The one exception sets it from elsewhere — a password change reissues
 * tokens — and a server may set any path it likes regardless of the request's.
 */
const NAME = "obizee_refresh";

/** Thirty days, matching REFRESH_TOKEN_TTL. A shorter cookie than token would sign people out early. */
const MAX_AGE = 30 * 24 * 60 * 60;

/**
 * Native clients do not have a cookie jar worth relying on.
 *
 * The React Native app will ask for the token in the response body with this
 * header. Browsers send nothing and get the cookie only — so the default is the
 * safe one, and the unsafe path is something a caller has to name.
 */
export function wantsTokenInBody(c: Context): boolean {
  return c.req.header("x-token-delivery") === "body";
}

function options() {
  /*
    `Secure` is dropped in development because the dev servers speak http, and
    a Secure cookie over http is silently discarded — which would look exactly
    like sign-in being broken. Keyed on NODE_ENV rather than on the domain, so
    a production deploy that forgets COOKIE_DOMAIN still gets the flag.
  */
  const production = process.env.NODE_ENV === "production";
  const domain = process.env.COOKIE_DOMAIN;

  return {
    httpOnly: true,
    /*
      Lax, not Strict. Strict withholds the cookie on any navigation that
      arrives from elsewhere — following a link in an email to a job, for
      instance — and the person then lands signed out for no reason they can
      see. Lax still refuses cross-site POSTs, which is what CSRF needs.
    */
    sameSite: "Lax" as const,
    secure: production,
    path: "/auth",
    maxAge: MAX_AGE,
    ...(domain ? { domain } : {}),
  };
}

export function setRefreshCookie(c: Context, token: string): void {
  setCookie(c, NAME, token, options());
}

/**
 * The token this request carries, cookie first.
 *
 * The body is still read, for two reasons: a native client that asked for the
 * token in the body has to send it back somehow, and a browser holding an old
 * `localStorage` token from before this change can still refresh once — after
 * which it has a cookie and the old token is rotated away.
 */
export function readRefreshToken(c: Context, fromBody?: string): string | null {
  return getCookie(c, NAME) ?? fromBody ?? null;
}

export function clearRefreshCookie(c: Context): void {
  // Same path and domain, or the browser keeps a second cookie and the session
  // outlives the sign-out that was supposed to end it.
  const { path, domain } = options();
  deleteCookie(c, NAME, { path, ...(domain ? { domain } : {}) });
}
