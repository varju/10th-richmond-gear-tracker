/** ULIDs, the same shape as src/gear_tracker/ulid.py: 10 chars of time, 16 of randomness, Crockford base32. */

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const PATTERN = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

export function newUlid(nowMs: number = Date.now()): string {
  let time = "";
  let t = nowMs;
  for (let i = 0; i < 10; i++) {
    time = ALPHABET[t % 32] + time;
    t = Math.floor(t / 32);
  }
  const random = crypto.getRandomValues(new Uint8Array(16));
  let tail = "";
  for (const byte of random) tail += ALPHABET[byte % 32];
  return time + tail;
}

export function isUlid(value: unknown): value is string {
  return typeof value === "string" && PATTERN.test(value);
}
