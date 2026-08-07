import {
  randomBytes,
  scrypt as scryptCb,
  timingSafeEqual,
  type ScryptOptions,
} from "node:crypto";

/**
 * `promisify` picks the three-argument overload, which has no options
 * parameter — and the options are where the cost lives. Wrapped by hand so the
 * cost is actually applied rather than silently defaulting to N=16384.
 */
function scrypt(
  password: string,
  salt: Buffer,
  keylen: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCb(password, salt, keylen, options, (err, key) =>
      err ? reject(err) : resolve(key),
    );
  });
}

/**
 * Password hashing with scrypt from Node's own crypto.
 *
 * **Why not argon2.** argon2id is the better algorithm and was the first
 * choice. It ships as a native binary, and this repo lives on an exFAT volume
 * where macOS writes an AppleDouble sibling next to every file — so
 * `node-gyp-build` globbed the prebuilds directory, found
 * `._argon2.armv8.glibc.node` before the real one, and `dlopen` failed on a
 * file that is not a Mach-O binary at all.
 *
 * Deleting the siblings fixes it until the next `pnpm install`. A password
 * hasher that breaks on reinstall is not a password hasher. scrypt is in Node
 * core, needs no binary, and is memory-hard — OWASP lists it as an acceptable
 * choice where argon2id is not available. This is a deliberate downgrade of
 * algorithm in exchange for one that actually runs.
 *
 * **Parameters are stored with the hash**, so raising them later is a
 * migration on next sign-in rather than a flag day: verify with whatever the
 * stored record says, re-hash with the current cost.
 */

/** N=2^17 · r=8 · p=1 — roughly 128 MB and ~100 ms on modern hardware. */
const COST = { N: 1 << 17, r: 8, p: 1, keyLength: 64 } as const;

export async function hashPassword(plain: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(plain.normalize("NFKC"), salt, COST.keyLength, {
    N: COST.N,
    r: COST.r,
    p: COST.p,
    // Node's default cap is 32 MB; N=2^17 needs more than that.
    maxmem: 256 * 1024 * 1024,
  });

  return [
    "scrypt",
    COST.N,
    COST.r,
    COST.p,
    salt.toString("base64url"),
    key.toString("base64url"),
  ].join("$");
}

/**
 * Verify, in constant time, against whatever parameters the record was made
 * with. Returns false rather than throwing on a malformed record — a corrupt
 * hash is a failed sign-in, not a 500.
 */
export async function verifyPassword(
  stored: string,
  plain: string,
): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;

  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) {
    return false;
  }

  try {
    const salt = Buffer.from(parts[4]!, "base64url");
    const expected = Buffer.from(parts[5]!, "base64url");
    const actual = await scrypt(plain.normalize("NFKC"), salt, expected.length, {
      N,
      r,
      p,
      maxmem: 256 * 1024 * 1024,
    });
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}
