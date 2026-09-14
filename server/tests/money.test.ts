import { describe, expect, it } from 'vitest';
import { allocate, allocateEqual, formatCents, toCents, fromCents } from '../src/domain/money.js';

describe('money', () => {
  it('parses the shapes people actually say', () => {
    expect(toCents(128)).toBe(12800);
    expect(toCents('1,200')).toBe(120000);
    expect(toCents('128.5')).toBe(12850);
    expect(toCents('¥300')).toBe(30000);
    expect(toCents('12万')).toBe(null); // multipliers are handled by the parser, not here
    expect(toCents('abc')).toBe(null);
    expect(toCents('')).toBe(null);
  });

  it('formats cents without floating point drift', () => {
    expect(formatCents(0)).toBe('0.00');
    expect(formatCents(5)).toBe('0.05');
    expect(formatCents(16667)).toBe('166.67');
    expect(formatCents(16666)).toBe('166.66');
    expect(formatCents(123457)).toBe('1234.57');
    expect(formatCents(-250)).toBe('-2.50');
    expect(fromCents(50000)).toBe(500);
  });

  it('splits ¥500 three ways exactly', () => {
    expect(allocate(50000, [1, 1, 1])).toEqual([16667, 16667, 16666]);
    expect(allocateEqual(50000, 3).reduce((a, b) => a + b, 0)).toBe(50000);
  });

  it('never loses or invents a cent', () => {
    for (let total = 1; total <= 2000; total += 7) {
      for (let people = 1; people <= 11; people += 1) {
        const parts = allocateEqual(total, people);
        expect(parts).toHaveLength(people);
        expect(parts.reduce((a, b) => a + b, 0)).toBe(total);
        expect(parts.every((p) => Number.isInteger(p) && p >= 0)).toBe(true);
        // Nobody is more than one cent away from an exact share.
        expect(Math.max(...parts) - Math.min(...parts)).toBeLessThanOrEqual(1);
      }
    }
  });

  it('honours weights', () => {
    expect(allocate(10000, [2, 1, 1])).toEqual([5000, 2500, 2500]);
    expect(allocate(100, [1, 1, 1])).toEqual([34, 33, 33]);
    // A zero weight means "not participating", not "gets a cent".
    expect(allocate(10000, [1, 1, 0])).toEqual([5000, 5000, 0]);
  });

  it('falls back to an equal split when every weight is zero', () => {
    expect(allocateEqual(9, 3)).toEqual([3, 3, 3]);
    expect(allocate(3, [0, 0, 0])).toEqual([1, 1, 1]);
  });
});
