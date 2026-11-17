/**
 * Whether a failed read means the record is not there: a 404 message, or an
 * id the API refused as malformed (an invalid id is not found, too).
 */
export function isNotFoundMessage(message: string | null | undefined): boolean {
  if (!message) return false;
  return /\bnot found\b|\bdoes not exist\b|\bmust be a valid uuid\b|\binvalid\b.*\bid\b|\bno such\b/i.test(message);
}
