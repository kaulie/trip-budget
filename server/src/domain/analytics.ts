import type {
  BalanceEdge,
  Category,
  Expense,
  LedgerMember,
  MemberBalance,
} from './types.js';
import { eachDayInclusive, diffInDays } from '../lib/dates.js';

/**
 * Everything here is *derived* from the two first-class fields on an expense:
 * `paidBy` (who handed over the money) and `shares` (who bears the cost).
 *
 * Keeping those apart is what makes "A paid ¥1000 but only bears ¥300" expressible.
 */

export interface MemberAggregate {
  userId: string;
  nickname: string;
  /** Money this member actually handed over (or received, for income). */
  paidCents: number;
  /** Money this member ultimately bears. */
  shareCents: number;
  /** paid - share. Positive => the group owes this member. */
  netCents: number;
  expenseCents: number;
  incomeCents: number;
}

export function computeMemberBalances(
  expenses: Expense[],
  members: LedgerMember[],
): { members: MemberAggregate[]; settlements: BalanceEdge[] } {
  const order = new Map(members.map((m, index) => [m.userId, index]));
  const acc = new Map<string, MemberAggregate>();

  const ensure = (userId: string): MemberAggregate => {
    let entry = acc.get(userId);
    if (!entry) {
      entry = {
        userId,
        nickname: members.find((m) => m.userId === userId)?.nickname ?? userId,
        paidCents: 0,
        shareCents: 0,
        netCents: 0,
        expenseCents: 0,
        incomeCents: 0,
      };
      acc.set(userId, entry);
    }
    return entry;
  };

  for (const member of members) ensure(member.userId);

  for (const expense of expenses) {
    if (expense.deletedAt) continue;
    const payer = ensure(expense.paidBy);
    payer.paidCents += expense.amountCents;
    if (expense.type === 'expense') payer.expenseCents += expense.amountCents;
    else payer.incomeCents += expense.amountCents;

    for (const share of expense.shares) {
      ensure(share.userId).shareCents += share.amountCents;
    }
  }

  const list = [...acc.values()].map((entry) => ({
    ...entry,
    netCents: entry.paidCents - entry.shareCents,
  }));

  list.sort((a, b) => {
    const ai = order.get(a.userId) ?? Number.MAX_SAFE_INTEGER;
    const bi = order.get(b.userId) ?? Number.MAX_SAFE_INTEGER;
    if (ai !== bi) return ai - bi;
    return a.userId < b.userId ? -1 : 1;
  });

  return { members: list, settlements: computeSettlements(list) };
}

/**
 * Greedy transfer list ("小王还应该给我 ¥100"). Deterministic: debtors and
 * creditors are ordered by amount, then by user id.
 */
export function computeSettlements(balances: MemberBalance[]): BalanceEdge[] {
  const creditors = balances
    .filter((m) => m.netCents > 0)
    .map((m) => ({ userId: m.userId, remaining: m.netCents }))
    .sort((a, b) => b.remaining - a.remaining || (a.userId < b.userId ? -1 : 1));
  const debtors = balances
    .filter((m) => m.netCents < 0)
    .map((m) => ({ userId: m.userId, remaining: -m.netCents }))
    .sort((a, b) => b.remaining - a.remaining || (a.userId < b.userId ? -1 : 1));

  const edges: BalanceEdge[] = [];
  let ci = 0;
  let di = 0;
  while (ci < creditors.length && di < debtors.length) {
    const creditor = creditors[ci]!;
    const debtor = debtors[di]!;
    const amount = Math.min(creditor.remaining, debtor.remaining);
    if (amount > 0) {
      edges.push({ fromUserId: debtor.userId, toUserId: creditor.userId, amountCents: amount });
    }
    creditor.remaining -= amount;
    debtor.remaining -= amount;
    if (creditor.remaining === 0) ci += 1;
    if (debtor.remaining === 0) di += 1;
  }
  return edges;
}

export interface CategoryTotal {
  categoryId: string;
  categoryKey: string;
  name: string;
  icon: string;
  amountCents: number;
  count: number;
  /** 0..1 */
  ratio: number;
}

export interface DailyTotal {
  date: string;
  expenseCents: number;
  incomeCents: number;
}

export interface LedgerStats {
  from: string;
  to: string;
  currency: string;
  totalExpenseCents: number;
  totalIncomeCents: number;
  netCents: number;
  expenseCount: number;
  incomeCount: number;
  byCategory: CategoryTotal[];
  byMember: MemberAggregate[];
  daily: DailyTotal[];
}

export function computeStats(options: {
  expenses: Expense[];
  members: LedgerMember[];
  categories: Category[];
  from: string;
  to: string;
  currency: string;
}): LedgerStats {
  const { expenses, members, categories, from, to, currency } = options;
  const active = expenses.filter((e) => !e.deletedAt && e.date >= from && e.date <= to);

  let totalExpenseCents = 0;
  let totalIncomeCents = 0;
  let expenseCount = 0;
  let incomeCount = 0;

  const categoryTotals = new Map<string, CategoryTotal>();
  const dailyTotals = new Map<string, DailyTotal>();

  for (const expense of active) {
    const category = categories.find((c) => c.id === expense.categoryId);
    const key = category?.key ?? expense.categoryKey;
    // `byCategory` is *spending* by category, so income never lands here.
    let day = dailyTotals.get(expense.date);
    if (!day) {
      day = { date: expense.date, expenseCents: 0, incomeCents: 0 };
      dailyTotals.set(expense.date, day);
    }

    if (expense.type === 'expense') {
      totalExpenseCents += expense.amountCents;
      expenseCount += 1;
      day.expenseCents += expense.amountCents;

      let bucket = categoryTotals.get(key);
      if (!bucket) {
        bucket = {
          categoryId: category?.id ?? expense.categoryId,
          categoryKey: key,
          name: category?.name ?? key,
          icon: category?.icon ?? 'tag.fill',
          amountCents: 0,
          count: 0,
          ratio: 0,
        };
        categoryTotals.set(key, bucket);
      }
      bucket.amountCents += expense.amountCents;
      bucket.count += 1;
    } else {
      totalIncomeCents += expense.amountCents;
      incomeCount += 1;
      day.incomeCents += expense.amountCents;
    }
  }

  const byCategory = [...categoryTotals.values()]
    .map((bucket) => ({
      ...bucket,
      ratio: totalExpenseCents > 0 ? bucket.amountCents / totalExpenseCents : 0,
    }))
    .sort((a, b) => b.amountCents - a.amountCents);

  // Member figures cover both directions: an "income" row means the payer
  // received money that the shares say belongs to the group.
  const balances = computeMemberBalances(active, members);

  // A dense day-by-day series is only useful (and cheap) for a bounded window;
  // for "all time" we return just the days that actually have activity.
  const span = diffInDays(from, to);
  const daily: DailyTotal[] =
    span >= 0 && span <= 366
      ? eachDayInclusive(from, to).map(
          (date) => dailyTotals.get(date) ?? { date, expenseCents: 0, incomeCents: 0 },
        )
      : [...dailyTotals.values()].sort((a, b) => (a.date < b.date ? -1 : 1));

  return {
    from,
    to,
    currency,
    totalExpenseCents,
    totalIncomeCents,
    netCents: totalIncomeCents - totalExpenseCents,
    expenseCount,
    incomeCount,
    byCategory,
    byMember: balances.members,
    daily,
  };
}
