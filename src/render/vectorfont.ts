/**
 * A stroke font for the dash instruments (#54): every glyph is a few straight polylines
 * on a 4-wide, 6-tall cell, the way a vector display of the Asteroids era drew text — no
 * curves, no fill, nothing a beam could not trace. Upper case, digits and the punctuation
 * a readout needs; lower case is drawn as upper. An unknown character draws nothing but
 * still advances, so a typo shows as a gap rather than a crash.
 *
 * Coordinates are cell units: x 0..4, y 0 on the baseline to 6 at the cap line.
 */
export const CELL_W = 4;
export const CELL_H = 6;
/** cell units from one glyph's origin to the next: the cell plus one of space */
export const ADVANCE = 5;

/** a polyline as flat x,y pairs */
type Stroke = readonly number[];

const GLYPHS: Readonly<Record<string, readonly Stroke[]>> = {
  '0': [[0, 1, 1, 0, 3, 0, 4, 1, 4, 5, 3, 6, 1, 6, 0, 5, 0, 1]],
  '1': [[1, 5, 2, 6, 2, 0], [1, 0, 3, 0]],
  '2': [[0, 5, 1, 6, 3, 6, 4, 5, 4, 4, 0, 1, 0, 0, 4, 0]],
  '3': [[0, 5, 1, 6, 3, 6, 4, 5, 4, 4, 3, 3, 1, 3], [3, 3, 4, 2, 4, 1, 3, 0, 1, 0, 0, 1]],
  '4': [[3, 0, 3, 6, 0, 2, 4, 2]],
  '5': [[4, 6, 0, 6, 0, 3, 3, 3, 4, 2, 4, 1, 3, 0, 1, 0, 0, 1]],
  '6': [[3, 6, 1, 6, 0, 5, 0, 1, 1, 0, 3, 0, 4, 1, 4, 2, 3, 3, 0, 3]],
  '7': [[0, 6, 4, 6, 1, 0]],
  '8': [[1, 3, 0, 4, 0, 5, 1, 6, 3, 6, 4, 5, 4, 4, 3, 3, 1, 3, 0, 2, 0, 1, 1, 0, 3, 0, 4, 1, 4, 2, 3, 3]],
  '9': [[4, 3, 1, 3, 0, 4, 0, 5, 1, 6, 3, 6, 4, 5, 4, 1, 3, 0, 1, 0]],
  A: [[0, 0, 0, 4, 2, 6, 4, 4, 4, 0], [0, 2, 4, 2]],
  B: [[0, 0, 0, 6, 3, 6, 4, 5, 4, 4, 3, 3, 0, 3], [3, 3, 4, 2, 4, 1, 3, 0, 0, 0]],
  C: [[4, 5, 3, 6, 1, 6, 0, 5, 0, 1, 1, 0, 3, 0, 4, 1]],
  D: [[0, 0, 0, 6, 3, 6, 4, 5, 4, 1, 3, 0, 0, 0]],
  E: [[4, 0, 0, 0, 0, 6, 4, 6], [0, 3, 3, 3]],
  F: [[0, 0, 0, 6, 4, 6], [0, 3, 3, 3]],
  G: [[4, 5, 3, 6, 1, 6, 0, 5, 0, 1, 1, 0, 3, 0, 4, 1, 4, 3, 2, 3]],
  H: [[0, 0, 0, 6], [4, 0, 4, 6], [0, 3, 4, 3]],
  I: [[1, 6, 3, 6], [2, 6, 2, 0], [1, 0, 3, 0]],
  J: [[4, 6, 4, 1, 3, 0, 1, 0, 0, 1]],
  K: [[0, 0, 0, 6], [4, 6, 0, 2], [1.5, 3.5, 4, 0]],
  L: [[0, 6, 0, 0, 4, 0]],
  M: [[0, 0, 0, 6, 2, 3, 4, 6, 4, 0]],
  N: [[0, 0, 0, 6, 4, 0, 4, 6]],
  O: [[0, 1, 1, 0, 3, 0, 4, 1, 4, 5, 3, 6, 1, 6, 0, 5, 0, 1]],
  P: [[0, 0, 0, 6, 3, 6, 4, 5, 4, 4, 3, 3, 0, 3]],
  Q: [[0, 1, 1, 0, 3, 0, 4, 1, 4, 5, 3, 6, 1, 6, 0, 5, 0, 1], [2.5, 1.5, 4, 0]],
  R: [[0, 0, 0, 6, 3, 6, 4, 5, 4, 4, 3, 3, 0, 3], [2, 3, 4, 0]],
  S: [[4, 5, 3, 6, 1, 6, 0, 5, 0, 4, 1, 3, 3, 3, 4, 2, 4, 1, 3, 0, 1, 0, 0, 1]],
  T: [[0, 6, 4, 6], [2, 6, 2, 0]],
  U: [[0, 6, 0, 1, 1, 0, 3, 0, 4, 1, 4, 6]],
  V: [[0, 6, 2, 0, 4, 6]],
  W: [[0, 6, 1, 0, 2, 3, 3, 0, 4, 6]],
  X: [[0, 0, 4, 6], [0, 6, 4, 0]],
  Y: [[0, 6, 2, 3, 4, 6], [2, 3, 2, 0]],
  Z: [[0, 6, 4, 6, 0, 0, 4, 0]],
  '.': [[2, 0, 2, 0.8]],
  ',': [[2, 0.8, 2, 0, 1.4, -0.7]],
  '-': [[1, 3, 3, 3]],
  '+': [[1, 3, 3, 3], [2, 2, 2, 4]],
  '/': [[0, 0, 4, 6]],
  ':': [[2, 1, 2, 1.8], [2, 4, 2, 4.8]],
  '%': [[0, 0, 4, 6], [0, 6, 1, 6, 1, 5, 0, 5, 0, 6], [3, 1, 4, 1, 4, 0, 3, 0, 3, 1]],
  '(': [[2, 6, 1, 5, 1, 1, 2, 0]],
  ')': [[2, 6, 3, 5, 3, 1, 2, 0]],
  '<': [[3, 6, 1, 3, 3, 0]],
  '>': [[1, 6, 3, 3, 1, 0]],
  '=': [[1, 2, 3, 2], [1, 4, 3, 4]],
  '°': [[1.5, 6, 2.5, 6, 2.5, 5, 1.5, 5, 1.5, 6]],
  ' ': [],
};

/** Every character the font draws. */
export const CHARSET: readonly string[] = Object.keys(GLYPHS);

/** The glyph for a character, upper-cased; undefined for one the font lacks. */
export function glyph(ch: string): readonly Stroke[] | undefined {
  return GLYPHS[ch.toUpperCase()];
}

/** Width of `text` at cap height `size`, in the same units as `size`. */
export function textWidth(text: string, size: number): number {
  if (text.length === 0) return 0;
  return ((text.length * ADVANCE - (ADVANCE - CELL_W)) * size) / CELL_H;
}

/**
 * Append the segments that draw `text` with its left edge at `x`, its baseline at `y`
 * and its cap height `size`, as flat x0,y0,x1,y1 quads onto `out`. Returns the number
 * of segments appended. Pure and allocation-free beyond `out`'s own growth.
 */
export function textStrokes(text: string, x: number, y: number, size: number, out: number[]): number {
  const k = size / CELL_H;
  let segments = 0;
  let cx = x;
  for (const ch of text) {
    const strokes = glyph(ch);
    if (strokes) {
      for (const s of strokes) {
        for (let i = 0; i + 3 < s.length; i += 2) {
          out.push(cx + s[i]! * k, y + s[i + 1]! * k, cx + s[i + 2]! * k, y + s[i + 3]! * k);
          segments++;
        }
      }
    }
    cx += ADVANCE * k;
  }
  return segments;
}
