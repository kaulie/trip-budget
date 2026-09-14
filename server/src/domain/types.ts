/**
 * Domain types shared by the HTTP layer, the persistence layer and the agent.
 *
 * The two first-class concepts of this product live here:
 *   - `Expense.paidBy`  — who actually handed over the money (a single person)
 *   - `ExpenseShare[]`  — who ultimately bears the cost, and how much each
 *
 * Everything else (balances, statistics, settlements) is derived from those two.
 */

export type ExpenseType = 'expense' | 'income';

export type ShareMode = 'equal' | 'weights' | 'amounts';

export interface User {
  id: string;
  nickname: string;
  deviceId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Ledger {
  id: string;
  name: string;
  currency: string;
  ownerId: string;
  inviteCode: string;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  /** Bumped on every mutation; the client uses it to order its local cache. */
  revision: number;
}

export type MemberRole = 'owner' | 'member';

export interface LedgerMember {
  id: string;
  ledgerId: string;
  userId: string;
  role: MemberRole;
  joinedAt: string;
  removedAt: string | null;
  /** Denormalised for the client's member picker. */
  nickname: string;
}

export interface Category {
  id: string;
  /** null => built-in category available to every ledger. */
  ledgerId: string | null;
  key: string;
  name: string;
  icon: string;
  kind: 'expense' | 'income' | 'both';
  sortOrder: number;
  isArchived: boolean;
}

export interface ExpenseShare {
  userId: string;
  amountCents: number;
}

export interface Expense {
  id: string;
  ledgerId: string;
  type: ExpenseType;
  /** Always positive; `type` carries the sign. */
  amountCents: number;
  currency: string;
  categoryId: string;
  categoryKey: string;
  /** Local calendar date, `YYYY-MM-DD`. */
  date: string;
  note: string;
  /** Who actually paid. Must be a member of the ledger. */
  paidBy: string;
  /** Who bore the cost. Sum of `amountCents` MUST equal `amountCents` above. */
  shares: ExpenseShare[];
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  revision: number;
  source: 'voice' | 'text' | 'manual' | 'agent';
  rawUtterance: string | null;
  /** Idempotency key supplied by the client. */
  clientMutationId: string | null;
  shareMode: ShareMode;
}

/** A share before it has been persisted (no ids yet). */
export interface DraftShare {
  userId: string;
  amountCents: number;
}

/**
 * A fully resolved, server-validated expense candidate. This is what the agent
 * produces (after resolution + validation) and what the client shows on the
 * confirmation screen.
 */
export interface ExpenseDraft {
  type: ExpenseType;
  amountCents: number;
  currency: string;
  categoryKey: string;
  categoryId: string;
  date: string;
  note: string;
  paidBy: string;
  shareMode: ShareMode;
  shares: DraftShare[];
  source: 'voice' | 'text' | 'manual' | 'agent';
  rawUtterance: string | null;
}

export interface BalanceEdge {
  fromUserId: string;
  toUserId: string;
  amountCents: number;
}

export interface MemberBalance {
  userId: string;
  nickname: string;
  paidCents: number;
  shareCents: number;
  /** paid - share. Positive => the ledger owes this member money. */
  netCents: number;
}

export interface LedgerBalances {
  members: MemberBalance[];
  /** Minimal set of transfers that settles the ledger (greedy, deterministic). */
  settlements: BalanceEdge[];
}
