// ══════════════════════════════════════════════════════════════════════
// anchor.js — content-addressing and identifier generation
//
//   • Sync 64-bit hash (cyrb-style) for frame-independent entity identity
//   • UUIDv7 for event identifiers (time-sortable)
//   • canonicalize() for stable string forms before hashing
//
// Deliberately not cryptographic — local content-addressing doesn't need
// collision resistance against adversaries, only stable deterministic
// identity for reasonable canonical forms. Keeping this sync means the
// whole intake pipeline stays sync up to the IndexedDB write, which is
// the only truly async step.
// ══════════════════════════════════════════════════════════════════════

/**
 * Canonicalize a target string before hashing.
 * Stable canonicalization is what makes anchors reproducible across
 * sessions and minor typographic variation.
 */
export function canonicalize(str) {
  if (str == null) return '';
  return String(str)
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[''`´]/g, "'")
    .replace(/[""«»]/g, '"')
    .replace(/[–—−]/g, '-')
    .replace(/[.,;:!?]+$/, ''); // trailing punctuation
}

/**
 * Fast 64-bit string hash. Two 32-bit lanes mixed with Math.imul,
 * combined into a 16-char hex string. Orders of magnitude faster than
 * SubtleCrypto for small inputs, synchronous, no Web Crypto dependency.
 *
 * Collision probability ≈ 1 in 2^32 at ~4 billion keys (birthday bound).
 * Fine for local anchor use; not suitable for security.
 */
export function hash(str) {
  const s = String(str);
  let h1 = 0xdeadbeef | 0;
  let h2 = 0x41c6ce57 | 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(16).padStart(8, '0') +
         (h1 >>> 0).toString(16).padStart(8, '0');
}

/** Make an anchor from a target string. Synchronous. Returns { hash, form, original }. */
export function makeAnchor(target) {
  const form = canonicalize(target);
  return { hash: hash(form), form, original: String(target) };
}

/**
 * UUIDv7 — time-ordered UUID.
 * First 48 bits = unix timestamp in ms, remainder = random (version 7).
 * Lexicographic sort = chronological sort, which makes event-store scans cheap.
 * Uses crypto.getRandomValues (sync, universally available — not SubtleCrypto).
 */
export function uuidv7() {
  const ts = Date.now();
  const tsHex = ts.toString(16).padStart(12, '0');
  const rand = crypto.getRandomValues(new Uint8Array(10));
  rand[0] = (rand[0] & 0x0f) | 0x70; // version 7
  rand[2] = (rand[2] & 0x3f) | 0x80; // variant
  let hex = tsHex;
  for (const b of rand) hex += b.toString(16).padStart(2, '0');
  return (
    hex.slice(0, 8) + '-' +
    hex.slice(8, 12) + '-' +
    hex.slice(12, 16) + '-' +
    hex.slice(16, 20) + '-' +
    hex.slice(20, 32)
  );
}

/** Short hash — 8-char prefix useful for display. */
export function shortHash(h) { return h ? String(h).slice(0, 8) : ''; }
