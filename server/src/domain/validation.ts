import { BusinessRuleError, type RuleViolation } from '../lib/errors.js';
import { isValidDateString, parseDateString, toDateString, addDays } from '../lib/dates.js';
import { allocate, allocateEqual, isInteger } from './money.js';
import type { Category, ExpenseShare, ExpenseType, Ledger, LedgerMember, ShareMode } from './types.js';
import { DEFAULT_CATEGORY_KEY } from './categories.js';

/**
 * Deterministic business rules.
 *
 * The agent is allowed to be creative about *language*; it is never trusted
 * about *money*. Everything below runs on the server, in one place, before any
 * row is written — and the exact same function is used to preview a draft for
 * the confirmation screen and to persist it.
 */

export const MAX_AMOUNT_CENTS = 100_000_000_000; // ¥1,000,000,000
export const MAX_NOTE_LENGTH = 200;

export interface ValidationContext {
  ledger: Ledger;
  /** Active (non-removed) members of the ledger. */
  members: LedgerMember[];
  categories: Category[];
}

/** The raw, possibly-untrusted shape of an expense coming from a client or the agent. */
export interface RawExpenseInput {
  type?: unknown;
  amountCents?: unknown;
  currency?: unknown;
  categoryKey?: unknown;
  date?: unknown;
  note?: unknown;
  paidBy?: unknown;
  shares?: unknown;
  shareMode?: unknown;
  source?: unknown;
  rawUtterance?: unknown;
}

export interface NormalizedExpenseInput {
  type: ExpenseType;
  amountCents: number;
  currency: string;
  categoryKey: string;
  categoryId: string;
  date: string;
  note: string;
  paidBy: string;
  shareMode: ShareMode;
  shares: ExpenseShare[];
  source: 'voice' | 'text' | 'manual' | 'agent';
  rawUtterance: string | null;
}

export type ValidationResult =
  | { ok: true; value: NormalizedExpenseInput; warnings: RuleViolation[] }
  | { ok: false; violations: RuleViolation[] };

/** How the caller describes who owes what, before we turn it into concrete shares. */
export type ShareSpec =
  | { mode: 'equal'; participants: string[] }
  | { mode: 'weights'; entries: { userId: string; weight: number }[] }
  | { mode: 'amounts'; entries: { userId: string; amountCents: number }[] };

/**
 * Turn a share spec into concrete integer shares summing exactly to `amountCents`.
 * `equal` and `weights` use largest-remainder allocation; `amounts` must already
 * sum to the total (checked by `validateExpense`).
 */
export function materializeShares(amountCents: number, spec: ShareSpec): ExpenseShare[] {
  switch (spec.mode) {
    case 'equal': {
      const parts = allocateEqual(amountCents, spec.participants.length);
      return spec.participants.map((userId, index) => ({
        userId,
        amountCents: parts[index] ?? 0,
      }));
    }
    case 'weights': {
      const parts = allocate(
        amountCents,
        spec.entries.map((e) => e.weight),
      );
      return spec.entries.map((entry, index) => ({
        userId: entry.userId,
        amountCents: parts[index] ?? 0,
      }));
    }
    case 'amounts':
      return spec.entries.map((entry) => ({
        userId: entry.userId,
        amountCents: entry.amountCents,
      }));
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readShareArray(raw: unknown): ExpenseShare[] | null {
  if (!Array.isArray(raw)) return null;
  const out: ExpenseShare[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) return null;
    const userId = entry.userId ?? entry.user_id;
    const amountCents = entry.amountCents ?? entry.amount_cents;
    if (typeof userId !== 'string' || userId.trim() === '') return null;
    if (!isInteger(amountCents)) return null;
    out.push({ userId: userId.trim(), amountCents });
  }
  return out;
}

function normalizeCategory(
  raw: unknown,
  ctx: ValidationContext,
): { categoryKey: string; categoryId: string; warning?: RuleViolation } {
  if (typeof raw === 'string') {
    const byId = ctx.categories.find((c) => c.id === raw);
    if (byId) return { categoryKey: byId.key, categoryId: byId.id };
    const byKey = ctx.categories.find((c) => c.key === raw);
    if (byKey) return { categoryKey: byKey.key, categoryId: byKey.id };
    // Accept a category *name* (e.g. the agent echoing "吃饭").
    const byName = ctx.categories.find((c) => c.name === raw);
    if (byName) return { categoryKey: byName.key, categoryId: byName.id };
  }

  const fallback = ctx.categories.find((c) => c.key === DEFAULT_CATEGORY_KEY) ?? ctx.categories[0];
  if (!fallback) {
    // Should be impossible: every ledger gets the built-in categories on create.
    return { categoryKey: DEFAULT_CATEGORY_KEY, categoryId: DEFAULT_CATEGORY_KEY };
  }
  // Only complain when the caller actually asked for something we could not map.
  const requested = typeof raw === 'string' ? raw.trim() : '';
  if (requested === '') {
    return { categoryKey: fallback.key, categoryId: fallback.id };
  }
  return {
    categoryKey: fallback.key,
    categoryId: fallback.id,
    warning: {
      rule: 'category_unknown',
      message: `分类“${requested}”无法识别，已归入「${fallback.name}」。`,
      details: { requested, fallback: fallback.key },
    },
  };
}

function normalizeShareMode(raw: unknown): ShareMode {
  return raw === 'equal' || raw === 'weights' || raw === 'amounts' ? raw : 'amounts';
}


/**
 * Validate + normalize an expense. Never throws for *content* problems: it
 * returns the violations so they can be shown to the user — and, when the agent
 * produced them, fed back to the agent so it can correct itself.
 */
export function validateExpense(input: RawExpenseInput, ctx: ValidationContext): ValidationResult {
  const violations: RuleViolation[] = [];
  const warnings: RuleViolation[] = [];
  const memberIds = new Set(ctx.members.map((m) => m.userId));
  const nicknameOf = (userId: string) =>
    ctx.members.find((m) => m.userId === userId)?.nickname ?? userId;

  // ---- type -------------------------------------------------------------
  const rawType = input.type ?? 'expense';
  if (rawType !== 'expense' && rawType !== 'income') {
    violations.push({
      rule: 'type_invalid',
      message: `账目类型只能是 expense 或 income，收到“${String(rawType)}”。`,
    });
  }
  const type: ExpenseType = rawType === 'income' ? 'income' : 'expense';

  // ---- amount -----------------------------------------------------------
  const amountCents = input.amountCents;
  if (!isInteger(amountCents)) {
    violations.push({
      rule: 'amount_invalid',
      message: '金额必须是整数（单位：分）。',
      details: { received: amountCents ?? null },
    });
  } else if (amountCents <= 0) {
    violations.push({
      rule: 'amount_not_positive',
      message: '金额必须大于 0。',
      details: { amountCents },
    });
  } else if (amountCents > MAX_AMOUNT_CENTS) {
    violations.push({
      rule: 'amount_too_large',
      message: '金额超出允许范围。',
      details: { amountCents, max: MAX_AMOUNT_CENTS },
    });
  }

  // ---- date -------------------------------------------------------------
  let date: string;
  if (typeof input.date !== 'string' || !isValidDateString(input.date)) {
    date = toDateString(new Date());
    if (input.date !== undefined && input.date !== null && input.date !== '') {
      warnings.push({
        rule: 'date_unrecognized',
        message: '日期无法识别，已记为今天。',
        details: { received: input.date },
      });
    }
  } else {
    date = input.date;
  }
  if (parseDateString(date)) {
    const today = toDateString(new Date());
    const upper = addDays(today, 366);
    const lower = addDays(today, -365 * 20);
    if (date > upper || date < lower) {
      violations.push({
        rule: 'date_out_of_range',
        message: '日期超出允许范围。',
        details: { date, min: lower, max: upper },
      });
    }
  }

  // ---- currency ---------------------------------------------------------
  const requestedCurrency =
    typeof input.currency === 'string' && input.currency.trim() !== ''
      ? input.currency.trim().toUpperCase()
      : ctx.ledger.currency;
  if (requestedCurrency !== ctx.ledger.currency) {
    warnings.push({
      rule: 'currency_forced',
      message: `账本货币为 ${ctx.ledger.currency}，已按账本货币记录。`,
      details: { requested: requestedCurrency, ledger: ctx.ledger.currency },
    });
  }

  // ---- note -------------------------------------------------------------
  const rawNote = typeof input.note === 'string' ? input.note.trim() : '';
  const note = rawNote.length > MAX_NOTE_LENGTH ? rawNote.slice(0, MAX_NOTE_LENGTH) : rawNote;
  if (rawNote.length > MAX_NOTE_LENGTH) {
    warnings.push({
      rule: 'note_truncated',
      message: `备注过长，已截断到 ${MAX_NOTE_LENGTH} 字。`,
    });
  }

  // ---- category ---------------------------------------------------------
  const category = normalizeCategory(input.categoryKey, ctx);
  if (category.warning) warnings.push(category.warning);

  // ---- payer ------------------------------------------------------------
  const paidBy = typeof input.paidBy === 'string' ? input.paidBy.trim() : '';
  if (paidBy === '') {
    violations.push({ rule: 'payer_missing', message: '缺少付款人。' });
  } else if (!memberIds.has(paidBy)) {
    violations.push({
      rule: 'payer_not_member',
      message: `付款人“${nicknameOf(paidBy)}”不在当前账本中。`,
      details: { paidBy },
    });
  }

  // ---- shares -----------------------------------------------------------
  const shares = readShareArray(input.shares);
  if (shares === null) {
    violations.push({
      rule: 'shares_invalid',
      message: '分摊数据格式不正确（需要 [{userId, amountCents}]）。',
    });
  } else if (shares.length === 0) {
    violations.push({ rule: 'shares_empty', message: '至少需要一位费用承担人。' });
  } else {
    const seen = new Set<string>();
    for (const share of shares) {
      if (!memberIds.has(share.userId)) {
        violations.push({
          rule: 'share_user_not_member',
          message: `承担人“${nicknameOf(share.userId)}”不在当前账本中。`,
          details: { userId: share.userId },
        });
      }
      if (seen.has(share.userId)) {
        violations.push({
          rule: 'share_user_duplicated',
          message: `承担人“${nicknameOf(share.userId)}”重复出现。`,
          details: { userId: share.userId },
        });
      }
      seen.add(share.userId);
      if (share.amountCents < 0) {
        violations.push({
          rule: 'share_amount_negative',
          message: `承担人“${nicknameOf(share.userId)}”的分摊金额不能为负。`,
          details: { userId: share.userId, amountCents: share.amountCents },
        });
      }
    }

    if (isInteger(amountCents) && amountCents > 0) {
      const sum = shares.reduce((acc, s) => acc + s.amountCents, 0);
      if (sum !== amountCents) {
        violations.push({
          rule: 'shares_sum_mismatch',
          message: `分摊合计与账目总额不一致（合计 ${sum} 分，总额 ${amountCents} 分，差 ${amountCents - sum} 分）。`,
          details: { sumCents: sum, amountCents, diffCents: amountCents - sum },
        });
      }
    }
  }

  if (violations.length > 0) return { ok: false, violations };

  const rawSource = input.source;
  const source: NormalizedExpenseInput['source'] =
    rawSource === 'voice' || rawSource === 'text' || rawSource === 'manual' || rawSource === 'agent'
      ? rawSource
      : 'manual';

  return {
    ok: true,
    warnings,
    value: {
      type,
      amountCents: amountCents as number,
      currency: ctx.ledger.currency,
      categoryKey: category.categoryKey,
      categoryId: category.categoryId,
      date,
      note,
      paidBy,
      shareMode: normalizeShareMode(input.shareMode),
      shares: shares as ExpenseShare[],
      source,
      rawUtterance: typeof input.rawUtterance === 'string' ? input.rawUtterance : null,
    },
  };
}

/** Same as `validateExpense` but throws `BusinessRuleError` when invalid. */
export function assertValidExpense(
  input: RawExpenseInput,
  ctx: ValidationContext,
): NormalizedExpenseInput {
  const result = validateExpense(input, ctx);
  if (!result.ok) throw new BusinessRuleError(result.violations);
  return result.value;
}

