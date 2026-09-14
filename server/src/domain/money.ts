/**
 * Money helpers.
 *
 * Money is ALWAYS stored and computed as an integer number of minor units
 * (cents / 分). Floating point is only used at the edges (parsing an utterance,
 * rendering for display). This is what makes "500 split three ways" exactly
 * 167 + 167 + 166 instead of 166.66666666666666 * 3.
 */

const CURRENCY_MINOR_UNITS: Record<string, number> = {
  CNY: 2,
  USD: 2,
  EUR: 2,
  JPY: 0,
  KRW: 0,
};

export function minorUnitsFor(currency: string): number {
  return CURRENCY_MINOR_UNITS[currency.toUpperCase()] ?? 2;
}

export function centsPerUnit(currency: string): number {
  return 10 ** minorUnitsFor(currency);
}

const MAX_SAFE_CENTS = Number.MAX_SAFE_INTEGER;

export function isInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value);
}

/** Convert a user/LLM supplied amount (e.g. `128`, `"128.5"`, `"1,200"`) into cents. */
export function toCents(value: number | string, currency = 'CNY'): number | null {
  const per = centsPerUnit(currency);
  let n: number;
  if (typeof value === 'number') {
    n = value;
  } else {
    const cleaned = value.replace(/[,\s¥￥$元块钱]/g, '');
    if (cleaned === '' || cleaned === '-') return null;
    n = Number(cleaned);
  }
  if (!Number.isFinite(n)) return null;
  const cents = Math.round(n * per);
  if (!Number.isSafeInteger(cents) || Math.abs(cents) > MAX_SAFE_CENTS) return null;
  return cents;
}

export function fromCents(cents: number, currency = 'CNY'): number {
  return cents / centsPerUnit(currency);
}

/** `12800` -> `"128.00"`, `16667` -> `"166.67"`. */
export function formatCents(cents: number, currency = 'CNY'): string {
  const per = centsPerUnit(currency);
  if (minorUnitsFor(currency) === 0) return String(cents);
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  const whole = Math.floor(abs / per);
  const frac = abs % per;
  return `${sign}${whole}.${String(frac).padStart(minorUnitsFor(currency), '0')}`;
}

export function formatMoney(cents: number, currency = 'CNY'): string {
  const symbol = currency.toUpperCase() === 'CNY' ? '¥' : '';
  return `${symbol}${formatCents(cents, currency)}`;
}

/**
 * Split `total` (in cents) into `weights.length` integer parts that sum to
 * exactly `total`, using the largest-remainder (Hamilton) method.
 *
 * Ties on the fractional remainder are broken by larger weight first, then by
 * original index — this makes the result deterministic and stable, and it puts
 * the extra cent on the earliest-listed participant.
 *
 * Classic case: ¥500 split 3 ways, in the order 我/小王/小李.
 * 50000 cents / 3 = 16666.66… -> floors are 16666 each (sum 49998), remainder 2,
 * so the first two participants take one extra cent each:
 * 16667 / 16667 / 16666 cents = ¥166.67 / ¥166.67 / ¥166.66, summing to exactly ¥500.
 */
export function allocate(total: number, weights: number[]): number[] {
  if (weights.length === 0) throw new Error('allocate() requires at least one weight');
  if (!isInteger(total)) throw new Error('allocate() requires an integer cent total');
  for (const w of weights) {
    if (!Number.isFinite(w) || w < 0) throw new Error('allocate() requires non-negative weights');
  }

  const sign = total < 0 ? -1 : 1;
  const absTotal = Math.abs(total);
  const weightSum = weights.reduce((a, b) => a + b, 0);

  // Degenerate case: all weights zero -> treat as an equal split.
  const effective = weightSum > 0 ? weights : weights.map(() => 1);
  const effectiveSum = weightSum > 0 ? weightSum : weights.length;

  const raw = effective.map((w) => (absTotal * w) / effectiveSum);
  const floors = raw.map((v) => Math.floor(v));
  let assigned = floors.reduce((a, b) => a + b, 0);
  let remainder = absTotal - assigned;

  const order = raw
    .map((value, index) => ({
      index,
      frac: value - Math.floor(value),
      weight: effective[index] ?? 0,
    }))
    .sort((a, b) => {
      if (b.frac !== a.frac) return b.frac - a.frac;
      if (b.weight !== a.weight) return b.weight - a.weight;
      return a.index - b.index;
    });

  const result = [...floors];
  let cursor = 0;
  while (remainder > 0) {
    const slot = order[cursor % order.length]!;
    result[slot.index] = (result[slot.index] ?? 0) + 1;
    remainder -= 1;
    cursor += 1;
    if (cursor > order.length * (absTotal + 1)) break; // defensive, unreachable
  }

  return result.map((v) => v * sign);
}

/** Equal split shortcut; extra cents go to the earliest participants. */
export function allocateEqual(total: number, count: number): number[] {
  if (count <= 0) throw new Error('allocateEqual() requires count > 0');
  return allocate(total, new Array(count).fill(1));
}
