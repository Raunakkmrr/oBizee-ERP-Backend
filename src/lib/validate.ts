/**
 * Validation that refuses in the same shape as everything else.
 *
 * `zValidator`'s default hook answers a bad body with a serialised `ZodError`:
 * a `{ success, error: { name, message, issues } }` object where every other
 * refusal in this API is `{ error: "a sentence" }`. A client reading
 * `body.error` therefore gets a string almost everywhere and an object here —
 * the web client renders it as `[object Object]`, which tells the reader
 * nothing about which field was wrong.
 *
 * So the shape is unified and the message is built from the issues: the field
 * that failed, and what was expected of it. `field` travels separately so a
 * form can put the message next to the input rather than at the top of the
 * page.
 */
import type { ValidationTargets } from "hono";
import { zValidator } from "@hono/zod-validator";
import type { ZodSchema } from "zod";

/** `site.pincode` — the path a form field is actually named by. */
function pathOf(issue: { path: PropertyKey[] }): string {
  return issue.path.length > 0 ? issue.path.join(".") : "request";
}

/**
 * One sentence naming the first failure, and a count of the rest.
 *
 * Not every issue: a reader fixes one field at a time, and a wall of nine
 * messages reads as "this form is broken" rather than "this box is wrong".
 */
function sentence(error: { issues: { path: PropertyKey[]; message: string }[] }): string {
  const [first, ...rest] = error.issues;
  if (!first) return "That request was not in a form this system can read.";

  const where = pathOf(first);
  const head = where === "request" ? first.message : `${where}: ${first.message}`;
  return rest.length > 0 ? `${head} (and ${rest.length} more)` : head;
}

function validator<T extends keyof ValidationTargets, S extends ZodSchema>(
  target: T,
  schema: S,
) {
  return zValidator(target, schema, (result, c) => {
    if (!result.success) {
      return c.json(
        {
          error: sentence(result.error),
          field: pathOf(result.error.issues[0]!),
          // The full list, for a client that wants to mark several inputs at
          // once. Named `issues` rather than `error` so nothing has to guess
          // which of the two it is holding.
          issues: result.error.issues.map((issue) => ({
            field: pathOf(issue),
            message: issue.message,
          })),
        },
        400,
      );
    }
    return undefined;
  });
}

export const zBody = <S extends ZodSchema>(schema: S) => validator("json", schema);
export const zParam = <S extends ZodSchema>(schema: S) => validator("param", schema);
export const zQuery = <S extends ZodSchema>(schema: S) => validator("query", schema);
