// text.ts — shared byte-safe text helpers. Extracted so report.ts (rendering)
// and github.ts (error snippet) don't each carry a duplicate clip implementation.
//
// The clipping algorithm mirrors Go's `clip` (report.go:43) byte-for-byte:
// encode → slice → back up over UTF-8 continuation bytes → decode.

/** Maximum body length before clipping (matches Go MAX_BODY_LEN). */
export const MAX_BODY_LEN = 4000

/**
 * Clip a string to at most `max` bytes, backing up over UTF-8 continuation
 * bytes (where `(byte & 0xC0) === 0x80`) to avoid splitting a multi-byte
 * character. Indexed access returns `number | undefined` under
 * `noUncheckedIndexedAccess` — narrowed with `b === undefined` before the
 * bitmask test.
 */
export function clip(s: string, max: number): string {
  const enc = new TextEncoder().encode(s)
  if (enc.length <= max) return s
  let end = max
  // Walk back over UTF-8 continuation bytes (0x80–0xBF) so we don't slice
  // mid-rune.
  while (end > 0) {
    const b = enc[end]
    if (b === undefined || (b & 0xc0) !== 0x80) break
    end--
  }
  return new TextDecoder().decode(enc.subarray(0, end))
}
