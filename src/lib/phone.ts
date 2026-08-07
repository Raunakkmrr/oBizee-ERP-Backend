/**
 * Normalise an Indian phone number to E.164 digits.
 *
 * Copied from `obez-erp-web/src/lib/contact.ts` so the API and the browser
 * agree on what a phone number is. If they disagree, a number the form accepts
 * fails to match a user row at sign-in — and the reader is told their own
 * number is wrong.
 *
 * The link builders are not copied: `tel:` and `wa.me` are a browser concern.
 */

export function e164(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const trimmed = phone.trim();
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length === 0) return null;

  // Already international, in either notation.
  if (trimmed.startsWith("+")) return digits;
  if (digits.length === 12 && digits.startsWith("91")) return digits;
  // A leading 0 is the domestic trunk prefix and is not dialled internationally.
  if (digits.length === 11 && digits.startsWith("0")) return `91${digits.slice(1)}`;
  if (digits.length === 10) return `91${digits}`;

  // Something we do not recognise. Returning a guess would dial a stranger.
  return null;
}
