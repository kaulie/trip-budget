import type { DatabaseSync } from 'node:sqlite';
import { newId, nowIso } from '../lib/ids.js';
import { generateInviteCode, normalizeInviteCode } from '../lib/ids.js';
import { BUILTIN_CATEGORIES } from '../domain/categories.js';
import { conflict, notFound } from '../lib/errors.js';
import type {
  Category,
  Expense,
  ExpenseShare,
  ExpenseType,
  Ledger,
  LedgerMember,
  MemberRole,
  ShareMode,
  User,
} from '../domain/types.js';
import type { NormalizedExpenseInput } from '../domain/validation.js';

/**
 * All SQL lives here. The domain layer never sees a row, and the HTTP layer
 * never writes SQL — which is what keeps the business rules (validation.ts)
 * reusable and testable without a database.
 */

type Row = Record<string, unknown>;

const str = (value: unknown): string => (typeof value === 'string' ? value : String(value ?? ''));
const num = (value: unknown): number => Number(value ?? 0);
const nullableStr = (value: unknown): string | null =>
  value === null || value === undefined ? null : String(value);

function mapUser(row: Row): User {
  return {
    id: str(row.id),
    nickname: str(row.nickname),
    deviceId: nullableStr(row.device_id),
    createdAt: str(row.created_at),
    updatedAt: str(row.updated_at),
  };
}

function mapLedger(row: Row): Ledger {
  return {
    id: str(row.id),
    name: str(row.name),
    currency: str(row.currency),
    ownerId: str(row.owner_id),
    inviteCode: str(row.invite_code),
    createdAt: str(row.created_at),
    updatedAt: str(row.updated_at),
    deletedAt: nullableStr(row.deleted_at),
    revision: num(row.revision),
  };
}

function mapMember(row: Row): LedgerMember {
  return {
    id: str(row.id),
    ledgerId: str(row.ledger_id),
    userId: str(row.user_id),
    role: str(row.role) as MemberRole,
    joinedAt: str(row.joined_at),
    removedAt: nullableStr(row.removed_at),
    nickname: str(row.nickname ?? row.user_id),
  };
}

function mapCategory(row: Row): Category {
  return {
    id: str(row.id),
    ledgerId: nullableStr(row.ledger_id),
    key: str(row.key),
    name: str(row.name),
    icon: str(row.icon),
    kind: str(row.kind) as Category['kind'],
    sortOrder: num(row.sort_order),
    isArchived: num(row.is_archived) === 1,
  };
}

function mapExpense(row: Row, shares: ExpenseShare[]): Expense {
  return {
    id: str(row.id),
    ledgerId: str(row.ledger_id),
    type: str(row.type) as ExpenseType,
    amountCents: num(row.amount_cents),
    currency: str(row.currency),
    categoryId: str(row.category_id),
    categoryKey: str(row.category_key ?? ''),
    date: str(row.date),
    note: str(row.note),
    paidBy: str(row.paid_by),
    shares,
    createdBy: str(row.created_by),
    createdAt: str(row.created_at),
    updatedAt: str(row.updated_at),
    deletedAt: nullableStr(row.deleted_at),
    revision: num(row.revision),
    source: str(row.source) as Expense['source'],
    rawUtterance: nullableStr(row.raw_utterance),
    clientMutationId: nullableStr(row.client_mutation_id),
    shareMode: str(row.share_mode) as ShareMode,
  };
}

export interface CreateLedgerInput {
  name: string;
  currency?: string;
  ownerId: string;
}

export interface ExpenseListQuery {
  ledgerId: string;
  from?: string | null;
  to?: string | null;
  categoryKey?: string | null;
  userId?: string | null;
  type?: ExpenseType | null;
  limit?: number;
  offset?: number;
  includeDeleted?: boolean;
}

export class Repo {
  constructor(readonly db: DatabaseSync) {}

  /** Run `fn` inside a single immediate transaction. */
  tx<T>(fn: () => T): T {
    this.db.exec('begin immediate');
    try {
      const result = fn();
      this.db.exec('commit');
      return result;
    } catch (error) {
      try {
        this.db.exec('rollback');
      } catch {
        /* already rolled back */
      }
      throw error;
    }
  }

  // -------------------------------------------------------------------------
  // Users
  // -------------------------------------------------------------------------

  findUser(id: string): User | null {
    const row = this.db.prepare('select * from users where id = ?').get(id) as Row | undefined;
    return row ? mapUser(row) : null;
  }

  findUserByDevice(deviceId: string): User | null {
    const row = this.db
      .prepare('select * from users where device_id = ?')
      .get(deviceId) as Row | undefined;
    return row ? mapUser(row) : null;
  }

  createUser(input: { nickname: string; deviceId?: string | null }): User {
    const now = nowIso();
    const user: User = {
      id: newId(),
      nickname: input.nickname.trim() || '记账的人',
      deviceId: input.deviceId ?? null,
      createdAt: now,
      updatedAt: now,
    };
    this.db
      .prepare(
        'insert into users (id, nickname, device_id, created_at, updated_at, revision) values (?, ?, ?, ?, ?, 1)',
      )
      .run(user.id, user.nickname, user.deviceId, user.createdAt, user.updatedAt);
    return user;
  }

  updateNickname(userId: string, nickname: string): User {
    const user = this.findUser(userId);
    if (!user) throw notFound('user not found');
    const now = nowIso();
    this.db
      .prepare('update users set nickname = ?, updated_at = ?, revision = revision + 1 where id = ?')
      .run(nickname.trim() || user.nickname, now, userId);
    // Nicknames are denormalised into member listings, so a rename is a change
    // the other devices have to see.
    const ledgers = this.db
      .prepare('select ledger_id from ledger_members where user_id = ?')
      .all(userId) as Row[];
    for (const row of ledgers) {
      const ledgerId = str(row.ledger_id);
      const revision = this.nextRevision(ledgerId);
      this.db
        .prepare('update ledger_members set revision = ? where ledger_id = ? and user_id = ?')
        .run(revision, ledgerId, userId);
    }
    return this.findUser(userId)!;
  }

  // -------------------------------------------------------------------------
  // Ledgers, members
  // -------------------------------------------------------------------------

  /** Monotonic per-ledger revision; every mutation to a ledger stamps this. */
  nextRevision(ledgerId: string): number {
    this.db
      .prepare(
        'insert into ledger_revisions (ledger_id, revision) values (?, 1) on conflict(ledger_id) do update set revision = revision + 1',
      )
      .run(ledgerId);
    const row = this.db
      .prepare('select revision from ledger_revisions where ledger_id = ?')
      .get(ledgerId) as Row | undefined;
    return num(row?.revision);
  }

  getRevision(ledgerId: string): number {
    const row = this.db
      .prepare('select revision from ledger_revisions where ledger_id = ?')
      .get(ledgerId) as Row | undefined;
    return num(row?.revision);
  }

  createLedger(input: CreateLedgerInput): { ledger: Ledger; member: LedgerMember } {
    return this.tx(() => {
      const now = nowIso();
      const ledger: Ledger = {
        id: newId(),
        name: input.name.trim() || '新账本',
        currency: (input.currency ?? 'CNY').toUpperCase(),
        ownerId: input.ownerId,
        inviteCode: generateInviteCode(input.name),
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
        revision: 1,
      };

      // `ledger_revisions` has a foreign key to `ledgers`, so the ledger row has
      // to exist before the revision counter can be touched. The row is written
      // with a placeholder revision and re-stamped once the ledger is complete,
      // so a client pulling "since 0" receives the whole snapshot.
      this.db
        .prepare(
          `insert into ledgers (id, name, currency, owner_id, invite_code, created_at, updated_at, deleted_at, revision)
           values (?, ?, ?, ?, ?, ?, ?, null, 1)`,
        )
        .run(
          ledger.id,
          ledger.name,
          ledger.currency,
          ledger.ownerId,
          ledger.inviteCode,
          ledger.createdAt,
          ledger.updatedAt,
        );
      this.db
        .prepare('insert into ledger_revisions (ledger_id, revision) values (?, 1)')
        .run(ledger.id);

      const member = this.addMember(ledger.id, input.ownerId, 'owner');

      const revision = this.getRevision(ledger.id);
      this.db
        .prepare('update ledgers set revision = ? where id = ?')
        .run(revision, ledger.id);
      this.db
        .prepare('update ledger_members set revision = ? where ledger_id = ?')
        .run(revision, ledger.id);
      for (const category of BUILTIN_CATEGORIES) {
        this.insertCategory(ledger.id, category, revision);
      }

      ledger.revision = revision;
      return { ledger, member };
    });
  }

  private insertCategory(
    ledgerId: string,
    category: (typeof BUILTIN_CATEGORIES)[number],
    revision: number,
  ): void {
    this.db
      .prepare(
        `insert into categories (id, ledger_id, key, name, icon, kind, sort_order, is_archived, revision)
         values (?, ?, ?, ?, ?, ?, ?, 0, ?)`,
      )
      .run(
        newId(),
        ledgerId,
        category.key,
        category.name,
        category.icon,
        category.kind,
        category.sortOrder,
        revision,
      );
  }

  addMember(ledgerId: string, userId: string, role: MemberRole): LedgerMember {
    const existing = this.db
      .prepare('select * from ledger_members where ledger_id = ? and user_id = ?')
      .get(ledgerId, userId) as Row | undefined;

    if (existing) {
      if (existing.removed_at === null) return this.memberRow(ledgerId, userId);
      // Re-joining a ledger they previously left.
      this.db
        .prepare(
          'update ledger_members set removed_at = null, role = ?, revision = ? where ledger_id = ? and user_id = ?',
        )
        .run(role, this.nextRevision(ledgerId), ledgerId, userId);
      return this.memberRow(ledgerId, userId);
    }

    const revision = this.nextRevision(ledgerId);
    this.db
      .prepare(
        `insert into ledger_members (id, ledger_id, user_id, role, joined_at, removed_at, revision)
         values (?, ?, ?, ?, ?, null, ?)`,
      )
      .run(newId(), ledgerId, userId, role, nowIso(), revision);
    return this.memberRow(ledgerId, userId);
  }

  private memberRow(ledgerId: string, userId: string): LedgerMember {
    const row = this.db
      .prepare(
        `select m.*, u.nickname as nickname from ledger_members m
         join users u on u.id = m.user_id
         where m.ledger_id = ? and m.user_id = ?`,
      )
      .get(ledgerId, userId) as Row;
    return mapMember(row);
  }

  removeMember(ledgerId: string, userId: string): void {
    this.tx(() => {
      const revision = this.nextRevision(ledgerId);
      this.db
        .prepare(
          'update ledger_members set removed_at = ?, revision = ? where ledger_id = ? and user_id = ? and removed_at is null',
        )
        .run(nowIso(), revision, ledgerId, userId);
    });
  }

  listMembers(ledgerId: string, options: { includeRemoved?: boolean } = {}): LedgerMember[] {
    const rows = this.db
      .prepare(
        `select m.*, u.nickname as nickname from ledger_members m
         join users u on u.id = m.user_id
         where m.ledger_id = ? ${options.includeRemoved ? '' : 'and m.removed_at is null'}
         order by case when m.role = 'owner' then 0 else 1 end, m.joined_at, m.id`,
      )
      .all(ledgerId) as Row[];
    return rows.map(mapMember);
  }

  isMember(ledgerId: string, userId: string): boolean {
    const row = this.db
      .prepare(
        'select 1 as ok from ledger_members where ledger_id = ? and user_id = ? and removed_at is null',
      )
      .get(ledgerId, userId) as Row | undefined;
    return row !== undefined;
  }

  findLedger(id: string): Ledger | null {
    const row = this.db.prepare('select * from ledgers where id = ?').get(id) as Row | undefined;
    return row && row.deleted_at === null ? mapLedger(row) : null;
  }

  findLedgerByInviteCode(code: string): Ledger | null {
    const row = this.db
      .prepare('select * from ledgers where invite_code = ? and deleted_at is null')
      .get(normalizeInviteCode(code)) as Row | undefined;
    return row ? mapLedger(row) : null;
  }

  listLedgersForUser(userId: string): Ledger[] {
    const rows = this.db
      .prepare(
        `select l.* from ledgers l
         join ledger_members m on m.ledger_id = l.id
         where m.user_id = ? and m.removed_at is null and l.deleted_at is null
         order by l.updated_at desc`,
      )
      .all(userId) as Row[];
    return rows.map(mapLedger);
  }

  updateLedgerSettings(ledgerId: string, patch: { name?: string; currency?: string }): Ledger {
    this.tx(() => {
      const revision = this.nextRevision(ledgerId);
      if (patch.name !== undefined) {
        this.db
          .prepare('update ledgers set name = ?, updated_at = ?, revision = ? where id = ?')
          .run(patch.name.trim(), nowIso(), revision, ledgerId);
      }
      if (patch.currency !== undefined) {
        this.db
          .prepare('update ledgers set currency = ?, updated_at = ?, revision = ? where id = ?')
          .run(patch.currency.toUpperCase(), nowIso(), revision, ledgerId);
      }
    });
    return this.findLedger(ledgerId)!;
  }

  rotateInviteCode(ledgerId: string): Ledger {
    return this.tx(() => {
      const ledger = this.findLedger(ledgerId);
      if (!ledger) throw notFound('ledger not found');
      let code = generateInviteCode(ledger.name);
      let attempts = 0;
      while (this.findLedgerByInviteCode(code) && attempts < 10) {
        code = generateInviteCode(ledger.name);
        attempts += 1;
      }
      const revision = this.nextRevision(ledgerId);
      this.db
        .prepare('update ledgers set invite_code = ?, updated_at = ?, revision = ? where id = ?')
        .run(code, nowIso(), revision, ledgerId);
      return this.findLedger(ledgerId)!;
    });
  }

  // -------------------------------------------------------------------------
  // Categories
  // -------------------------------------------------------------------------

  listCategories(ledgerId: string): Category[] {
    const rows = this.db
      .prepare(
        'select * from categories where ledger_id = ? and is_archived = 0 order by sort_order, key',
      )
      .all(ledgerId) as Row[];
    return rows.map(mapCategory);
  }

  createCategory(
    ledgerId: string,
    input: { key: string; name: string; icon?: string; kind?: Category['kind']; sortOrder?: number },
  ): Category {
    const existing = this.db
      .prepare('select * from categories where ledger_id = ? and key = ?')
      .get(ledgerId, input.key) as Row | undefined;
    if (existing) throw conflict('category key already exists in this ledger', { key: input.key });

    const revision = this.nextRevision(ledgerId);
    const id = newId();
    this.db
      .prepare(
        `insert into categories (id, ledger_id, key, name, icon, kind, sort_order, is_archived, revision)
         values (?, ?, ?, ?, ?, ?, ?, 0, ?)`,
      )
      .run(
        id,
        ledgerId,
        input.key,
        input.name,
        input.icon ?? 'tag.fill',
        input.kind ?? 'expense',
        input.sortOrder ?? 500,
        revision,
      );
    return mapCategory(this.db.prepare('select * from categories where id = ?').get(id) as Row);
  }

  // -------------------------------------------------------------------------
  // Expenses
  // -------------------------------------------------------------------------

  private expenseSelect(where: string): string {
    return `select e.*, coalesce(c.key, '') as category_key
            from expenses e
            left join categories c on c.id = e.category_id
            where ${where}`;
  }

  private sharesFor(expenseIds: string[]): Map<string, ExpenseShare[]> {
    const map = new Map<string, ExpenseShare[]>();
    if (expenseIds.length === 0) return map;
    const placeholders = expenseIds.map(() => '?').join(',');
    const rows = this.db
      .prepare(
        `select expense_id, user_id, amount_cents from expense_shares
         where expense_id in (${placeholders})
         order by rowid`,
      )
      .all(...expenseIds) as Row[];
    for (const row of rows) {
      const expenseId = str(row.expense_id);
      const list = map.get(expenseId) ?? [];
      list.push({ userId: str(row.user_id), amountCents: num(row.amount_cents) });
      map.set(expenseId, list);
    }
    return map;
  }

  /** Hydrate rows with their shares, preserving share insertion order. */
  private hydrate(rows: Row[]): Expense[] {
    const shares = this.sharesFor(rows.map((row) => str(row.id)));
    return rows.map((row) => mapExpense(row, shares.get(str(row.id)) ?? []));
  }

  findExpenseByMutationId(ledgerId: string, clientMutationId: string): Expense | null {
    const row = this.db
      .prepare(this.expenseSelect('e.ledger_id = ? and e.client_mutation_id = ?'))
      .get(ledgerId, clientMutationId) as Row | undefined;
    return row ? this.hydrate([row])[0]! : null;
  }

  getExpense(ledgerId: string, id: string): Expense | null {
    const row = this.db
      .prepare(this.expenseSelect('e.id = ? and e.ledger_id = ?'))
      .get(id, ledgerId) as Row | undefined;
    return row ? this.hydrate([row])[0]! : null;
  }

  private insertShares(
    ledgerId: string,
    expenseId: string,
    shares: { userId: string; amountCents: number }[],
  ): void {
    const statement = this.db.prepare(
      `insert into expense_shares (id, expense_id, ledger_id, user_id, amount_cents)
       values (?, ?, ?, ?, ?)`,
    );
    for (const share of shares) {
      statement.run(newId(), expenseId, ledgerId, share.userId, share.amountCents);
    }
  }

  createExpense(input: {
    ledgerId: string;
    expense: NormalizedExpenseInput;
    actorId: string;
    clientMutationId?: string | null;
  }): Expense {
    return this.tx(() => {
      if (input.clientMutationId) {
        const existing = this.findExpenseByMutationId(input.ledgerId, input.clientMutationId);
        // Idempotency: a retried upload must not create a second expense.
        if (existing) return existing;
      }

      const id = newId();
      const revision = this.nextRevision(input.ledgerId);
      const now = nowIso();
      const e = input.expense;

      this.db
        .prepare(
          `insert into expenses (
             id, ledger_id, type, amount_cents, currency, category_id, date, note, paid_by,
             share_mode, source, raw_utterance, created_by, created_at, updated_at, deleted_at,
             revision, client_mutation_id
           ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, null, ?, ?)`,
        )
        .run(
          id,
          input.ledgerId,
          e.type,
          e.amountCents,
          e.currency,
          e.categoryId,
          e.date,
          e.note,
          e.paidBy,
          e.shareMode,
          e.source,
          e.rawUtterance,
          input.actorId,
          now,
          now,
          revision,
          input.clientMutationId ?? null,
        );

      this.insertShares(input.ledgerId, id, e.shares);
      this.touchLedger(input.ledgerId, revision);
      return this.getExpense(input.ledgerId, id)!;
    });
  }

  updateExpense(input: {
    ledgerId: string;
    id: string;
    expense: NormalizedExpenseInput;
    /** Optimistic concurrency: reject when the client edited a stale copy. */
    expectedRevision?: number | null;
  }): Expense {
    return this.tx(() => {
      const existing = this.getExpense(input.ledgerId, input.id);
      if (!existing) throw notFound('expense not found');
      this.assertRevision(input.id, existing.revision, input.expectedRevision);

      const revision = this.nextRevision(input.ledgerId);
      const e = input.expense;
      this.db
        .prepare(
          `update expenses set type = ?, amount_cents = ?, currency = ?, category_id = ?, date = ?,
             note = ?, paid_by = ?, share_mode = ?, source = ?, raw_utterance = ?,
             updated_at = ?, revision = ?, deleted_at = null
           where id = ? and ledger_id = ?`,
        )
        .run(
          e.type,
          e.amountCents,
          e.currency,
          e.categoryId,
          e.date,
          e.note,
          e.paidBy,
          e.shareMode,
          e.source,
          e.rawUtterance,
          nowIso(),
          revision,
          input.id,
          input.ledgerId,
        );

      this.db.prepare('delete from expense_shares where expense_id = ?').run(input.id);
      this.insertShares(input.ledgerId, input.id, e.shares);

      this.touchLedger(input.ledgerId, revision);
      return this.getExpense(input.ledgerId, input.id)!;
    });
  }

  /** Soft delete: the tombstone must reach other devices through sync. */
  deleteExpense(input: { ledgerId: string; id: string; expectedRevision?: number | null }): Expense {
    return this.tx(() => {
      const existing = this.getExpense(input.ledgerId, input.id);
      if (!existing) throw notFound('expense not found');
      this.assertRevision(input.id, existing.revision, input.expectedRevision);

      const revision = this.nextRevision(input.ledgerId);
      this.db
        .prepare('update expenses set deleted_at = ?, updated_at = ?, revision = ? where id = ?')
        .run(nowIso(), nowIso(), revision, input.id);
      this.touchLedger(input.ledgerId, revision);
      return this.getExpense(input.ledgerId, input.id)!;
    });
  }

  private assertRevision(id: string, actual: number, expected?: number | null): void {
    if (expected === undefined || expected === null) return;
    if (actual !== expected) {
      throw conflict('someone else changed this record first', { id, expected, actual });
    }
  }

  private touchLedger(ledgerId: string, revision: number): void {
    this.db
      .prepare('update ledgers set updated_at = ?, revision = ? where id = ?')
      .run(nowIso(), revision, ledgerId);
  }

  listExpenses(query: ExpenseListQuery): Expense[] {
    const clauses = ['e.ledger_id = ?'];
    const params: (string | number)[] = [query.ledgerId];

    if (!query.includeDeleted) clauses.push('e.deleted_at is null');
    if (query.from) {
      clauses.push('e.date >= ?');
      params.push(query.from);
    }
    if (query.to) {
      clauses.push('e.date <= ?');
      params.push(query.to);
    }
    if (query.type) {
      clauses.push('e.type = ?');
      params.push(query.type);
    }
    if (query.categoryKey) {
      clauses.push("coalesce(c.key, '') = ?");
      params.push(query.categoryKey);
    }
    if (query.userId) {
      clauses.push(
        '(e.paid_by = ? or exists (select 1 from expense_shares s where s.expense_id = e.id and s.user_id = ?))',
      );
      params.push(query.userId, query.userId);
    }

    const limit = Math.min(Math.max(query.limit ?? 100, 1), 500);
    const offset = Math.max(query.offset ?? 0, 0);

    const rows = this.db
      .prepare(
        `${this.expenseSelect(clauses.join(' and '))}
         order by e.date desc, e.created_at desc, e.id desc
         limit ? offset ?`,
      )
      .all(...params, limit, offset) as Row[];
    return this.hydrate(rows);
  }

  countExpenses(ledgerId: string): number {
    const row = this.db
      .prepare('select count(*) as n from expenses where ledger_id = ? and deleted_at is null')
      .get(ledgerId) as Row;
    return num(row.n);
  }

  // -------------------------------------------------------------------------
  // Incremental sync
  // -------------------------------------------------------------------------

  /**
   * Everything that changed in this ledger after `since`, plus the new cursor.
   *
   * Rows carry the ledger revision they were written at, so there is no separate
   * change-log to keep consistent; soft deletes keep tombstones visible to
   * clients that have not caught up yet.
   */
  changesSince(ledgerId: string, since: number, options: { limit?: number } = {}) {
    const limit = Math.min(Math.max(options.limit ?? 500, 1), 1000);
    const revision = this.getRevision(ledgerId);

    const ledgerRow = this.db
      .prepare('select * from ledgers where id = ? and revision > ?')
      .get(ledgerId, since) as Row | undefined;

    const memberRows = this.db
      .prepare(
        `select m.*, u.nickname as nickname from ledger_members m
         join users u on u.id = m.user_id
         where m.ledger_id = ? and m.revision > ?
         order by m.revision limit ?`,
      )
      .all(ledgerId, since, limit) as Row[];

    const categoryRows = this.db
      .prepare('select * from categories where ledger_id = ? and revision > ? order by revision limit ?')
      .all(ledgerId, since, limit) as Row[];

    const expenseRows = this.db
      .prepare(
        `${this.expenseSelect('e.ledger_id = ? and e.revision > ?')}
         order by e.revision limit ?`,
      )
      .all(ledgerId, since, limit) as Row[];

    const revisions = [
      ...(ledgerRow ? [num(ledgerRow.revision)] : []),
      ...memberRows.map((r) => num(r.revision)),
      ...categoryRows.map((r) => num(r.revision)),
      ...expenseRows.map((r) => num(r.revision)),
    ];
    const cursor = revisions.length > 0 ? Math.max(...revisions) : revision;
    const hasMore =
      memberRows.length >= limit || categoryRows.length >= limit || expenseRows.length >= limit;

    return {
      cursor,
      serverRevision: revision,
      hasMore,
      ledger: ledgerRow ? mapLedger(ledgerRow) : null,
      members: memberRows.map(mapMember),
      categories: categoryRows.map(mapCategory),
      expenses: this.hydrate(expenseRows),
    };
  }
}
