import { BUILTIN_CATEGORIES } from '../src/domain/categories.js';
import type { AgentContext } from '../src/agent/resolve.js';
import type { Category, Ledger, LedgerMember } from '../src/domain/types.js';

export const TODAY = '2026-09-14';

export function testCategories(): Category[] {
  return BUILTIN_CATEGORIES.map((category) => ({
    id: `cat-${category.key}`,
    ledgerId: null,
    key: category.key,
    name: category.name,
    icon: category.icon,
    kind: category.kind,
    sortOrder: category.sortOrder,
    isArchived: false,
  }));
}

export interface ContextOptions {
  nicknames?: string[];
  /** Index into `nicknames` that is the current user. Defaults to 0. */
  selfIndex?: number;
  today?: string;
  currency?: string;
  ledgerName?: string;
}

export function makeContext(options: ContextOptions = {}): AgentContext {
  const nicknames = options.nicknames ?? ['我', '小王', '小李'];
  const selfIndex = options.selfIndex ?? 0;
  const today = options.today ?? TODAY;

  const members: LedgerMember[] = nicknames.map((nickname, index) => ({
    id: `mem-${index}`,
    ledgerId: 'ledger-1',
    userId: `u${index}`,
    role: index === 0 ? 'owner' : 'member',
    joinedAt: '2026-09-01T00:00:00.000Z',
    removedAt: null,
    nickname,
  }));

  const ledger: Ledger = {
    id: 'ledger-1',
    name: options.ledgerName ?? '日本旅行',
    currency: options.currency ?? 'CNY',
    ownerId: 'u0',
    inviteCode: 'TRIP-8F3K2',
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    deletedAt: null,
    revision: 1,
  };

  return {
    ledger,
    members,
    categories: testCategories(),
    currentUserId: `u${selfIndex}`,
    today,
  };
}

export const userIdOf = (index: number) => `u${index}`;
