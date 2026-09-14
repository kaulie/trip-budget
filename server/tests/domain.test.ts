import { describe, expect, it } from 'vitest';
import { materializeShares, validateExpense } from '../src/domain/validation.js';
import { computeMemberBalances, computeStats } from '../src/domain/analytics.js';
import { makeContext, testCategories, TODAY } from './helpers.js';
import type { Expense } from '../src/domain/types.js';

function ctx() {
  return makeContext({ nicknames: ['我', '小王', '小李'] });
}

function base(overrides: Record<string, unknown> = {}) {
  return {
    type: 'expense',
    amountCents: 30000,
    categoryKey: 'food',
    date: TODAY,
    note: '晚饭',
    paidBy: 'u0',
    shares: [
      { userId: 'u0', amountCents: 10000 },
      { userId: 'u1', amountCents: 10000 },
      { userId: 'u2', amountCents: 10000 },
    ],
    ...overrides,
  };
}

describe('business rules', () => {
  it('accepts a well-formed expense', () => {
    expect(validateExpense(base(), ctx()).ok).toBe(true);
  });

  it('requires the shares to sum to the total', () => {
    const result = validateExpense(base({ shares: [{ userId: 'u0', amountCents: 20000 }] }), ctx());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.violations.map((v) => v.rule)).toContain('shares_sum_mismatch');
      expect(result.violations[0]!.details?.diffCents).toBe(10000);
    }
  });

  it('rejects a payer outside the ledger', () => {
    const result = validateExpense(base({ paidBy: 'outsider' }), ctx());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.violations[0]!.rule).toBe('payer_not_member');
  });

  it('rejects a share holder outside the ledger', () => {
    const result = validateExpense(
      base({
        shares: [
          { userId: 'u0', amountCents: 30000 },
          { userId: 'outsider', amountCents: 0 },
        ],
      }),
      ctx(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.violations.map((v) => v.rule)).toContain('share_user_not_member');
    }
  });

  it('rejects negative shares and duplicate participants', () => {
    const negative = validateExpense(
      base({
        shares: [
          { userId: 'u0', amountCents: 40000 },
          { userId: 'u1', amountCents: -10000 },
        ],
      }),
      ctx(),
    );
    expect(negative.ok).toBe(false);

    const duplicated = validateExpense(
      base({
        shares: [
          { userId: 'u0', amountCents: 15000 },
          { userId: 'u0', amountCents: 15000 },
        ],
      }),
      ctx(),
    );
    expect(duplicated.ok).toBe(false);
    if (!duplicated.ok) {
      expect(duplicated.violations.map((v) => v.rule)).toContain('share_user_duplicated');
    }
  });

  it('rejects non-positive and non-integer amounts', () => {
    for (const amountCents of [0, -100, 12.5, Number.NaN, '100']) {
      expect(validateExpense(base({ amountCents }), ctx()).ok).toBe(false);
    }
  });

  it('never lets an unrecognised date or category break a save', () => {
    const result = validateExpense(base({ date: '昨天', categoryKey: '不存在' }), ctx());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.date).toBe(TODAY);
      expect(testCategories().some((c) => c.key === result.value.categoryKey)).toBe(true);
      expect(result.warnings.map((w) => w.rule)).toContain('category_unknown');
    }
  });
});

describe('share materialisation', () => {
  it('computes an exact equal split', () => {
    expect(materializeShares(50000, { mode: 'equal', participants: ['u0', 'u1', 'u2'] })).toEqual([
      { userId: 'u0', amountCents: 16667 },
      { userId: 'u1', amountCents: 16667 },
      { userId: 'u2', amountCents: 16666 },
    ]);
  });

  it('computes a weighted split', () => {
    expect(
      materializeShares(90000, {
        mode: 'weights',
        entries: [
          { userId: 'u0', weight: 2 },
          { userId: 'u1', weight: 1 },
        ],
      }),
    ).toEqual([
      { userId: 'u0', amountCents: 60000 },
      { userId: 'u1', amountCents: 30000 },
    ]);
  });
});

describe('balances', () => {
  const member = (userId: string, nickname: string) => ({
    id: `mem-${userId}`,
    ledgerId: 'ledger-1',
    userId,
    role: 'member' as const,
    joinedAt: TODAY,
    removedAt: null,
    nickname,
  });

  const expense = (overrides: Partial<Expense> = {}): Expense => ({
    id: 'e1',
    ledgerId: 'ledger-1',
    type: 'expense',
    amountCents: 90000,
    currency: 'CNY',
    categoryId: 'cat-food',
    categoryKey: 'food',
    date: TODAY,
    note: '',
    paidBy: 'u0',
    shares: [
      { userId: 'u0', amountCents: 30000 },
      { userId: 'u1', amountCents: 30000 },
      { userId: 'u2', amountCents: 30000 },
    ],
    createdBy: 'u0',
    createdAt: TODAY,
    updatedAt: TODAY,
    deletedAt: null,
    revision: 1,
    source: 'voice',
    rawUtterance: null,
    clientMutationId: null,
    shareMode: 'equal',
    ...overrides,
  });

  it('separates "paid" from "borne" and nets them out', () => {
    const balances = computeMemberBalances(
      [expense()],
      [member('u0', 'A'), member('u1', 'B'), member('u2', 'C')],
    );
    const byId = Object.fromEntries(balances.members.map((m) => [m.userId, m]));

    expect(byId['u0']!.paidCents).toBe(90000);
    expect(byId['u0']!.shareCents).toBe(30000);
    expect(byId['u0']!.netCents).toBe(60000);
    expect(byId['u1']!.netCents).toBe(-30000);

    // B and C each owe A ¥300.
    expect(balances.settlements).toEqual([
      { fromUserId: 'u1', toUserId: 'u0', amountCents: 30000 },
      { fromUserId: 'u2', toUserId: 'u0', amountCents: 30000 },
    ]);
  });

  it('ignores deleted expenses and settles to nothing', () => {
    const balances = computeMemberBalances(
      [expense({ deletedAt: '2026-09-14T00:00:00.000Z' })],
      [member('u0', 'A')],
    );
    expect(balances.members[0]!.netCents).toBe(0);
    expect(balances.settlements).toEqual([]);
  });

  it('treats income as money held on behalf of the group', () => {
    const stats = computeStats({
      expenses: [
        expense({
          type: 'income',
          amountCents: 100000,
          categoryId: 'cat-salary',
          categoryKey: 'salary',
          shares: [
            { userId: 'u0', amountCents: 50000 },
            { userId: 'u1', amountCents: 50000 },
          ],
        }),
      ],
      members: [member('u0', 'A'), member('u1', 'B')],
      categories: testCategories(),
      from: TODAY,
      to: TODAY,
      currency: 'CNY',
    });
    expect(stats.totalIncomeCents).toBe(100000);
    expect(stats.totalExpenseCents).toBe(0);
    expect(stats.byCategory).toHaveLength(0); // income is not a spending category
    // A received ¥1000 and keeps ¥500 of it, so B owes A ¥500.
    const byId = Object.fromEntries(stats.byMember.map((m) => [m.userId, m]));
    expect(byId['u0']!.netCents).toBe(50000);
    expect(byId['u1']!.netCents).toBe(-50000);
  });
});
