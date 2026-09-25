import { describe, it, expect } from 'vitest';
import { CHARSET, CELL_W, CELL_H, ADVANCE, glyph, textWidth, textStrokes } from '../src/render/vectorfont';

describe('vector font (#54)', () => {
  it('draws every digit, every capital letter and the readout punctuation', () => {
    for (const ch of '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ.-+/:%()<>=') expect(glyph(ch), ch).toBeDefined();
    expect(CHARSET).toContain(' ');
  });

  it('keeps every stroke inside the cell, with each glyph made of straight segments only', () => {
    for (const ch of CHARSET) {
      for (const stroke of glyph(ch)!) {
        expect(stroke.length % 2).toBe(0);
        for (let i = 0; i < stroke.length; i += 2) {
          expect(stroke[i]).toBeGreaterThanOrEqual(0);
          expect(stroke[i]).toBeLessThanOrEqual(CELL_W);
          expect(stroke[i + 1]).toBeGreaterThanOrEqual(-1); // a comma hangs a little below the line
          expect(stroke[i + 1]).toBeLessThanOrEqual(CELL_H);
        }
      }
    }
  });

  it('is upper case: lower-case letters draw as their capitals', () => {
    expect(glyph('k')).toBe(glyph('K'));
    expect(glyph('m/s')).toBeUndefined(); // one character at a time
  });

  it('advances a fixed pitch, so columns of numbers line up', () => {
    expect(textWidth('', 6)).toBe(0);
    expect(textWidth('1', 6)).toBe(CELL_W);
    expect(textWidth('11', 6)).toBe(CELL_W + ADVANCE);
    expect(textWidth('ABC', 12)).toBe((CELL_W + 2 * ADVANCE) * 2);
  });

  it('lays text out from a left edge and baseline at a cap height, and skips what it cannot draw', () => {
    const out: number[] = [];
    const n = textStrokes('7', 10, 20, 12, out);
    expect(n).toBe(2); // two segments: the top bar and the diagonal
    expect(out).toEqual([10, 32, 18, 32, 18, 32, 12, 20]);
    out.length = 0;
    expect(textStrokes(' ', 0, 0, 6, out)).toBe(0);
    expect(out.length).toBe(0);
    // an unknown character draws nothing but still takes its space
    expect(textStrokes('~1', 0, 0, 6, out)).toBe(textStrokes('1', 0, 0, 6, [])); 
    expect(out[0]).toBeCloseTo(ADVANCE + 1, 9); // the 1's first stroke starts one cell over
  });
});
