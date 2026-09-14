/**
 * Date helpers. Expenses carry a *local calendar date* (`YYYY-MM-DD`), not an
 * instant, so all arithmetic here is done on the date string.
 */

export function toDateString(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function parseDateString(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const [, y, m, d] = match;
  const year = Number(y);
  const month = Number(m);
  const day = Number(d);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    return null;
  }
  return date;
}

export function isValidDateString(value: unknown): value is string {
  return typeof value === 'string' && parseDateString(value) !== null;
}

export function addDays(dateString: string, days: number): string {
  const date = parseDateString(dateString);
  if (!date) throw new Error(`invalid date: ${dateString}`);
  date.setDate(date.getDate() + days);
  return toDateString(date);
}

export function diffInDays(from: string, to: string): number {
  const a = parseDateString(from);
  const b = parseDateString(to);
  if (!a || !b) throw new Error('invalid date');
  return Math.round((b.getTime() - a.getTime()) / 86_400_000);
}

/** Monday-based start of week. */
export function startOfWeek(dateString: string): string {
  const date = parseDateString(dateString);
  if (!date) throw new Error(`invalid date: ${dateString}`);
  const day = (date.getDay() + 6) % 7;
  date.setDate(date.getDate() - day);
  return toDateString(date);
}

export function startOfMonth(dateString: string): string {
  const date = parseDateString(dateString);
  if (!date) throw new Error(`invalid date: ${dateString}`);
  return `${dateString.slice(0, 7)}-01`;
}

export function endOfMonth(dateString: string): string {
  const date = parseDateString(dateString);
  if (!date) throw new Error(`invalid date: ${dateString}`);
  const last = new Date(date.getFullYear(), date.getMonth() + 1, 0);
  return toDateString(last);
}

export function eachDayInclusive(from: string, to: string, maxDays = 400): string[] {
  const out: string[] = [];
  let cursor = from;
  let guard = 0;
  while (cursor <= to && guard < maxDays) {
    out.push(cursor);
    cursor = addDays(cursor, 1);
    guard += 1;
  }
  return out;
}
