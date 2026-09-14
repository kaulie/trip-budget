import { Router, type RequestContext, type RouteResult } from './router.js';
import { badRequest, forbidden, notFound, unauthorized } from '../lib/errors.js';
import { computeMemberBalances, computeStats } from '../domain/analytics.js';
import { assertValidExpense, validateExpense } from '../domain/validation.js';
import { formatCents } from '../domain/money.js';
import { toDateString, startOfWeek, startOfMonth, endOfMonth } from '../lib/dates.js';
import { interpret } from '../agent/interpret.js';
import { decodeDraftState } from '../agent/draftCodec.js';
import { llmConfigFromEnv } from '../agent/llmParser.js';
import type { AgentContext } from '../agent/resolve.js';
import type { Ledger, User } from '../domain/types.js';
import type { AppDeps } from '../app.js';

/**
 * HTTP surface. Every handler is thin by design:
 *   parse input → call the domain → return the domain's answer.
 * Business rules live in `domain/validation.ts`, never here.
 */

function requireUser(ctx: RequestContext): User {
  if (!ctx.user) throw unauthorized();
  return ctx.user;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw badRequest('expected a JSON object body');
  }
  return value as Record<string, unknown>;
}

function requireString(
  source: Record<string, unknown>,
  key: string,
  options: { max?: number } = {},
): string {
  const value = source[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw badRequest(`\`${key}\` is required`, { key });
  }
  const trimmed = value.trim();
  if (options.max && trimmed.length > options.max) {
    throw badRequest(`\`${key}\` is too long`, { key, max: options.max });
  }
  return trimmed;
}

function optionalString(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw badRequest(`\`${key}\` must be a string`, { key });
  return value.trim();
}

function optionalNumber(source: Record<string, unknown>, key: string): number | undefined {
  const value = source[key];
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && Number.isFinite(Number(value))) return Number(value);
  throw badRequest(`\`${key}\` must be a number`, { key });
}

/** Load a ledger and assert the caller is an active member. */
function requireMembership(ctx: RequestContext, ledgerId: string): { ledger: Ledger; user: User } {
  const user = requireUser(ctx);
  const ledger = ctx.deps.repo.findLedger(ledgerId);
  if (!ledger) throw notFound('ledger not found', { ledgerId });
  if (!ctx.deps.repo.isMember(ledgerId, user.id)) {
    throw forbidden('you are not a member of this ledger');
  }
  return { ledger, user };
}

/**
 * "Today" comes from the client when it says so: someone recording a Tokyo
 * dinner at 9am Beijing time should still get Tokyo's date.
 */
function clientToday(ctx: RequestContext, body?: Record<string, unknown>): string {
  const fromBody = body?.today;
  if (typeof fromBody === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(fromBody)) return fromBody;
  const header = ctx.req.headers['x-client-date'];
  if (typeof header === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(header)) return header;
  return toDateString(new Date());
}

function patchFromQuery(ctx: RequestContext): number | null {
  const raw = ctx.query.get('expectedRevision');
  if (raw === null) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

/** The expense payload as it comes off the wire (untrusted input). */
function expensePayload(body: Record<string, unknown>): unknown {
  return body.expense ?? body;
}

export function buildRouter(deps: AppDeps): Router {
  const router = new Router();
  const { repo } = deps;

  // -------------------------------------------------------------------------
  // Health & identity
  // -------------------------------------------------------------------------

  router.get('/health', () => ({
    body: {
      ok: true,
      service: 'trip-budget',
      llm: llmConfigFromEnv().enabled ? 'configured' : 'rule-fallback',
      time: new Date().toISOString(),
    },
  }));

  /**
   * Anonymous identity bootstrap: the device id is the credential.
   * Deliberately not an account system — the model leaves room for one later
   * (`users.id` is stable), but the MVP has to work with zero signup.
   */
  router.post('/auth/anonymous', (ctx) => {
    const body = asRecord(ctx.body ?? {});
    const deviceId = requireString(body, 'deviceId', { max: 200 });
    const nickname = optionalString(body, 'nickname');

    const existing = repo.findUserByDevice(deviceId);
    if (existing) {
      if (nickname && nickname !== existing.nickname) {
        const updated = repo.tx(() => repo.updateNickname(existing.id, nickname));
        return { body: { token: updated.id, user: updated, created: false } };
      }
      return { body: { token: existing.id, user: existing, created: false } };
    }

    const user = repo.createUser({ nickname: nickname ?? '记账的人', deviceId });
    return { status: 201, body: { token: user.id, user, created: true } };
  });

  router.get('/me', (ctx) => {
    const user = requireUser(ctx);
    return { body: { user, ledgers: repo.listLedgersForUser(user.id) } };
  });

  router.patch('/me', (ctx) => {
    const user = requireUser(ctx);
    const body = asRecord(ctx.body ?? {});
    const nickname = requireString(body, 'nickname', { max: 40 });
    return { body: { user: repo.tx(() => repo.updateNickname(user.id, nickname)) } };
  });

  // -------------------------------------------------------------------------
  // Ledgers
  // -------------------------------------------------------------------------

  router.get('/ledgers', (ctx) => {
    const user = requireUser(ctx);
    return { body: { ledgers: repo.listLedgersForUser(user.id) } };
  });

  router.post('/ledgers', (ctx) => {
    const user = requireUser(ctx);
    const body = asRecord(ctx.body ?? {});
    const name = requireString(body, 'name', { max: 60 });
    const currency = optionalString(body, 'currency');
    const { ledger, member } = repo.createLedger({ name, currency, ownerId: user.id });
    return {
      status: 201,
      body: {
        ledger,
        member,
        categories: repo.listCategories(ledger.id),
        shareText: `来一起记账吧！账本「${ledger.name}」，邀请码 ${ledger.inviteCode}`,
      },
    };
  });

  /** Join by invite code — the whole multi-device onboarding flow in one call. */
  router.post('/ledgers/join', (ctx) => {
    const user = requireUser(ctx);
    const body = asRecord(ctx.body ?? {});
    const code = requireString(body, 'inviteCode', { max: 40 });
    const ledger = repo.findLedgerByInviteCode(code);
    if (!ledger) throw notFound('邀请码无效', { inviteCode: code });
    const member = repo.tx(() => repo.addMember(ledger.id, user.id, 'member'));
    return { body: { ledger, member, categories: repo.listCategories(ledger.id) } };
  });

  router.get('/ledgers/:ledgerId', (ctx) => {
    const { ledger } = requireMembership(ctx, ctx.params.ledgerId!);
    return {
      body: {
        ledger,
        members: repo.listMembers(ledger.id),
        categories: repo.listCategories(ledger.id),
        revision: repo.getRevision(ledger.id),
        expenseCount: repo.countExpenses(ledger.id),
      },
    };
  });

  router.patch('/ledgers/:ledgerId', (ctx) => {
    requireMembership(ctx, ctx.params.ledgerId!);
    const body = asRecord(ctx.body ?? {});
    const name = optionalString(body, 'name');
    const currency = optionalString(body, 'currency');
    if (name === undefined && currency === undefined) throw badRequest('nothing to update');
    const ledger = repo.tx(() =>
      repo.updateLedgerSettings(ctx.params.ledgerId!, { name, currency }),
    );
    return { body: { ledger } };
  });

  router.post('/ledgers/:ledgerId/invite-code/rotate', (ctx) => {
    const { ledger } = requireMembership(ctx, ctx.params.ledgerId!);
    const rotated = repo.tx(() => repo.rotateInviteCode(ledger.id));
    return {
      body: {
        ledger: rotated,
        shareText: `来一起记账吧！账本「${rotated.name}」，邀请码 ${rotated.inviteCode}`,
      },
    };
  });

  router.get('/ledgers/:ledgerId/members', (ctx) => {
    const { ledger } = requireMembership(ctx, ctx.params.ledgerId!);
    return { body: { members: repo.listMembers(ledger.id) } };
  });

  /** Leaving is always allowed; removing someone else requires being the owner. */
  router.delete('/ledgers/:ledgerId/members/:userId', (ctx) => {
    const { ledger, user } = requireMembership(ctx, ctx.params.ledgerId!);
    const targetId = ctx.params.userId!;
    if (targetId !== user.id && ledger.ownerId !== user.id) {
      throw forbidden('只有账本创建者可以移除其他成员');
    }
    if (targetId === ledger.ownerId) throw forbidden('账本创建者不能被移除');
    repo.tx(() => repo.removeMember(ledger.id, targetId));
    return { body: { ok: true, members: repo.listMembers(ledger.id) } };
  });

  // -------------------------------------------------------------------------
  // Categories
  // -------------------------------------------------------------------------

  router.get('/ledgers/:ledgerId/categories', (ctx) => {
    const { ledger } = requireMembership(ctx, ctx.params.ledgerId!);
    return { body: { categories: repo.listCategories(ledger.id) } };
  });

  router.post('/ledgers/:ledgerId/categories', (ctx) => {
    const { ledger } = requireMembership(ctx, ctx.params.ledgerId!);
    const body = asRecord(ctx.body ?? {});
    const name = requireString(body, 'name', { max: 20 });
    const key = optionalString(body, 'key') ?? `custom_${Date.now().toString(36)}`;
    const icon = optionalString(body, 'icon');
    const kind = body.kind === 'income' || body.kind === 'both' ? body.kind : 'expense';
    const category = repo.tx(() => repo.createCategory(ledger.id, { key, name, icon, kind }));
    return { status: 201, body: { category } };
  });

  // -------------------------------------------------------------------------
  // Expenses
  // -------------------------------------------------------------------------

  router.get('/ledgers/:ledgerId/expenses', (ctx) => {
    const { ledger } = requireMembership(ctx, ctx.params.ledgerId!);
    const typeParam = ctx.query.get('type');
    const expenses = repo.listExpenses({
      ledgerId: ledger.id,
      from: ctx.query.get('from'),
      to: ctx.query.get('to'),
      categoryKey: ctx.query.get('category'),
      userId: ctx.query.get('user'),
      type: typeParam === 'income' || typeParam === 'expense' ? typeParam : null,
      limit: Number(ctx.query.get('limit') ?? 100) || 100,
      offset: Number(ctx.query.get('offset') ?? 0) || 0,
    });
    return {
      body: { expenses, total: repo.countExpenses(ledger.id), currency: ledger.currency },
    };
  });

  /**
   * Validate a draft without saving it.
   *
   * The confirmation screen uses this, and it is the *same* function the write
   * path uses — so what the user approved is exactly what gets checked again
   * before it lands in the database.
   */
  router.post('/ledgers/:ledgerId/expenses/preview', (ctx) => {
    const { ledger } = requireMembership(ctx, ctx.params.ledgerId!);
    const body = asRecord(ctx.body ?? {});
    const result = validateExpense(expensePayload(body) as Record<string, unknown>, {
      ledger,
      members: repo.listMembers(ledger.id),
      categories: repo.listCategories(ledger.id),
    });
    if (!result.ok) {
      return { status: 200, body: { valid: false, violations: result.violations } };
    }
    return { body: { valid: true, warnings: result.warnings, expense: result.value } };
  });

  router.post('/ledgers/:ledgerId/expenses', (ctx) => {
    const { ledger, user } = requireMembership(ctx, ctx.params.ledgerId!);
    const body = asRecord(ctx.body ?? {});
    const expense = assertValidExpense(expensePayload(body) as Record<string, unknown>, {
      ledger,
      members: repo.listMembers(ledger.id),
      categories: repo.listCategories(ledger.id),
    });
    const clientMutationId = optionalString(body, 'clientMutationId') ?? null;

    const created = repo.createExpense({
      ledgerId: ledger.id,
      expense,
      actorId: user.id,
      clientMutationId,
    });
    return { status: 201, body: { expense: created, ledgerRevision: repo.getRevision(ledger.id) } };
  });

  router.get('/ledgers/:ledgerId/expenses/:expenseId', (ctx) => {
    const { ledger } = requireMembership(ctx, ctx.params.ledgerId!);
    const expense = repo.getExpense(ledger.id, ctx.params.expenseId!);
    if (!expense) throw notFound('expense not found');
    return { body: { expense } };
  });

  router.patch('/ledgers/:ledgerId/expenses/:expenseId', (ctx) => {
    const { ledger } = requireMembership(ctx, ctx.params.ledgerId!);
    const body = asRecord(ctx.body ?? {});
    const expense = assertValidExpense(expensePayload(body) as Record<string, unknown>, {
      ledger,
      members: repo.listMembers(ledger.id),
      categories: repo.listCategories(ledger.id),
    });
    const updated = repo.updateExpense({
      ledgerId: ledger.id,
      id: ctx.params.expenseId!,
      expense,
      expectedRevision: optionalNumber(body, 'expectedRevision') ?? patchFromQuery(ctx),
    });
    return { body: { expense: updated, ledgerRevision: repo.getRevision(ledger.id) } };
  });

  router.delete('/ledgers/:ledgerId/expenses/:expenseId', (ctx) => {
    const { ledger } = requireMembership(ctx, ctx.params.ledgerId!);
    const deleted = repo.deleteExpense({
      ledgerId: ledger.id,
      id: ctx.params.expenseId!,
      expectedRevision: patchFromQuery(ctx),
    });
    return { body: { expense: deleted, ledgerRevision: repo.getRevision(ledger.id) } };
  });

  // -------------------------------------------------------------------------
  // Statistics & balances
  // -------------------------------------------------------------------------

  router.get('/ledgers/:ledgerId/stats', (ctx) => {
    const { ledger } = requireMembership(ctx, ctx.params.ledgerId!);
    const today = clientToday(ctx);
    const range = resolveRange(ctx, today);
    const expenses = listAllInRange(ctx, ledger.id, range);
    const stats = computeStats({
      expenses,
      members: repo.listMembers(ledger.id),
      categories: repo.listCategories(ledger.id),
      from: range.from,
      to: range.to,
      currency: ledger.currency,
    });
    return { body: { stats, range } };
  });

  /**
   * Member balances: "who paid" vs "who bore the cost", plus the transfers that
   * would settle the ledger. Both come straight from `paidBy` + `shares`.
   */
  router.get('/ledgers/:ledgerId/balances', (ctx) => {
    const { ledger } = requireMembership(ctx, ctx.params.ledgerId!);
    const today = clientToday(ctx);
    const range = resolveRange(ctx, today);
    const expenses = listAllInRange(ctx, ledger.id, range);
    const balances = computeMemberBalances(expenses, repo.listMembers(ledger.id));
    return { body: { balances, range } };
  });

  // -------------------------------------------------------------------------
  // Agent
  // -------------------------------------------------------------------------

  /**
   * Natural language → a validated draft the user can confirm.
   *
   * The agent never writes. The response carries an `expense` payload that the
   * client posts back to `POST /expenses`, where it is validated a second time.
   */
  router.post('/ledgers/:ledgerId/agent/interpret', async (ctx) => {
    const { ledger, user } = requireMembership(ctx, ctx.params.ledgerId!);
    const body = asRecord(ctx.body ?? {});
    const text = requireString(body, 'text', { max: 500 });
    const source = body.source === 'voice' ? 'voice' : 'text';

    const recent = repo.listExpenses({ ledgerId: ledger.id, limit: 5 });
    const recentNotes = recent.map(
      (expense) =>
        `${expense.date} ${expense.categoryKey} ${formatCents(expense.amountCents)}${
          expense.note ? ` ${expense.note}` : ''
        }`,
    );

    const agentContext: AgentContext = {
      ledger,
      members: repo.listMembers(ledger.id),
      categories: repo.listCategories(ledger.id),
      currentUserId: user.id,
      today: clientToday(ctx, body),
      pendingDraft: decodeDraftState(body.pendingDraft),
    };

    const interpretation = await interpret({
      text,
      ctx: agentContext,
      pendingDraft: agentContext.pendingDraft ?? null,
      source,
      recentNotes,
    });

    return {
      body: {
        ...interpretation,
        // Echo the roster so the client can render names without a second call.
        members: agentContext.members,
      },
    };
  });

  // -------------------------------------------------------------------------
  // Sync
  // -------------------------------------------------------------------------

  /**
   * Incremental pull: everything changed in this ledger since `since`.
   * Together with `clientMutationId` on writes this gives at-least-once,
   * idempotent synchronisation across devices.
   */
  router.get('/ledgers/:ledgerId/sync', (ctx) => {
    const { ledger } = requireMembership(ctx, ctx.params.ledgerId!);
    const since = Number(ctx.query.get('since') ?? 0);
    const result = repo.changesSince(ledger.id, Number.isFinite(since) ? since : 0, {
      limit: Number(ctx.query.get('limit') ?? 500) || 500,
    });
    return { body: result };
  });

  return router;
}

/** Statistics and balances must cover the whole window, not just one page. */
function listAllInRange(
  ctx: RequestContext,
  ledgerId: string,
  range: { from: string; to: string },
): import('../domain/types.js').Expense[] {
  const pageSize = 500;
  const all: import('../domain/types.js').Expense[] = [];
  for (let offset = 0; offset < 5000; offset += pageSize) {
    const page = ctx.deps.repo.listExpenses({
      ledgerId,
      from: range.from,
      to: range.to,
      limit: pageSize,
      offset,
    });
    all.push(...page);
    if (page.length < pageSize) break;
  }
  return all;
}

function resolveRange(
  ctx: RequestContext,
  today: string,
): { from: string; to: string; preset: string } {
  const preset = ctx.query.get('range') ?? 'month';
  const customFrom = ctx.query.get('from');
  const customTo = ctx.query.get('to');

  if (customFrom && customTo) return { from: customFrom, to: customTo, preset: 'custom' };

  switch (preset) {
    case 'today':
      return { from: today, to: today, preset };
    case 'week':
      return { from: startOfWeek(today), to: today, preset };
    case 'month':
      return { from: startOfMonth(today), to: endOfMonth(today), preset };
    case 'year':
      return { from: `${today.slice(0, 4)}-01-01`, to: `${today.slice(0, 4)}-12-31`, preset };
    default:
      return { from: '1970-01-01', to: '2999-12-31', preset: 'all' };
  }
}
