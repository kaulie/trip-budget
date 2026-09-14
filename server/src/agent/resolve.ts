import { allocate, allocateEqual, toCents } from '../domain/money.js';
import { guessCategoryFromText } from '../domain/categories.js';
import { addDays, isValidDateString } from '../lib/dates.js';
import type { ExpenseType, Ledger, LedgerMember, Category, ShareMode } from '../domain/types.js';
import { isRoleWord, isSelfRef, type AgentDate, type AgentPatch } from './schema.js';

/**
 * Patch resolution: the bridge from "the agent said 小王" to "user id 7f3a…".
 *
 * This is intentionally *not* part of the agent — matching names against the
 * ledger roster, refusing to guess between two candidates, and enforcing money
 * invariants are business concerns.
 */

export interface ParticipantState {
  userId: string;
  weight?: number;
  amountCents?: number;
}

/** The pending, editable draft the user is looking at on the confirmation card. */
export interface DraftState {
  type: ExpenseType;
  amountCents: number | null;
  currency: string;
  categoryKey: string | null;
  date: string | null;
  note: string;
  paidBy: string | null;
  shareMode: ShareMode;
  participants: ParticipantState[];
  source: 'voice' | 'text' | 'manual' | 'agent';
  rawUtterance: string | null;
}

export interface AgentContext {
  ledger: Ledger;
  members: LedgerMember[];
  categories: Category[];
  currentUserId: string;
  /** Local "today" as YYYY-MM-DD — injected so tests are deterministic. */
  today: string;
  /** The draft currently awaiting confirmation, for follow-up refinements. */
  pendingDraft?: DraftState | null;
}

export type PersonResolution =
  | { kind: 'user'; userId: string; nickname: string }
  | { kind: 'ambiguous'; candidates: { userId: string; nickname: string }[] }
  | { kind: 'unknown' };

export interface ResolutionIssue {
  kind:
    | 'unknown_person'
    | 'ambiguous_person'
    | 'participant_count_mismatch'
    | 'amount_missing'
    | 'shares_incomplete';
  /** Chinese question / explanation shown to the user. */
  message: string;
  ref?: string;
  candidates?: { userId: string; nickname: string }[];
}

const NICKNAME_PREFIXES = ['小', '老', '阿', '大', '胖', '瘦'];

function normalizeName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s`'’"“”·．.。，,、]/g, '');
}

function stripPrefix(value: string): string {
  for (const prefix of NICKNAME_PREFIXES) {
    if (value.length > prefix.length && value.startsWith(prefix)) return value.slice(prefix.length);
  }
  return value;
}

/**
 * Resolve a spoken reference against the ledger roster.
 *
 * Tiered, and it refuses to guess: if the best tier has more than one hit, the
 * caller must ask the user — a rule explicitly required by the product spec
 * ("如果存在重名或无法确定具体成员，不要猜测，需要用户确认").
 */
export function resolvePerson(ref: string, ctx: AgentContext): PersonResolution {
  const raw = ref.trim();
  if (raw === '') return { kind: 'unknown' };

  if (isSelfRef(raw)) {
    const me = ctx.members.find((m) => m.userId === ctx.currentUserId);
    if (me) return { kind: 'user', userId: me.userId, nickname: me.nickname };
  }

  const byId = ctx.members.find((m) => m.userId === raw);
  if (byId) return { kind: 'user', userId: byId.userId, nickname: byId.nickname };

  const needle = normalizeName(raw);
  if (needle === '') return { kind: 'unknown' };

  const tiers: LedgerMember[][] = [
    // tier 2: exact nickname
    ctx.members.filter((m) => normalizeName(m.nickname) === needle),
    // tier 3: containment, either direction
    ctx.members.filter((m) => {
      const name = normalizeName(m.nickname);
      return name !== '' && (name.includes(needle) || needle.includes(name));
    }),
    // tier 4: ignore familiar prefixes ("小王" -> "王", "王小明" -> "王小明")
    ctx.members.filter((m) => {
      const a = stripPrefix(needle);
      const b = stripPrefix(normalizeName(m.nickname));
      return a !== '' && b !== '' && (a === b || b.includes(a) || a.includes(b));
    }),
  ];

  for (const tier of tiers) {
    if (tier.length === 1) {
      const member = tier[0]!;
      return { kind: 'user', userId: member.userId, nickname: member.nickname };
    }
    if (tier.length > 1) {
      return {
        kind: 'ambiguous',
        candidates: tier.map((m) => ({ userId: m.userId, nickname: m.nickname })),
      };
    }
  }

  return { kind: 'unknown' };
}

export function emptyDraft(ctx: AgentContext): DraftState {
  return {
    type: 'expense',
    amountCents: null,
    currency: ctx.ledger.currency,
    categoryKey: null,
    date: ctx.today,
    note: '',
    paidBy: ctx.currentUserId,
    shareMode: 'equal',
    participants: [{ userId: ctx.currentUserId }],
    source: 'text',
    rawUtterance: null,
  };
}

function resolveDate(date: AgentDate, ctx: AgentContext, base: DraftState): string | null {
  switch (date.kind) {
    case 'absolute':
      return isValidDateString(date.value) ? date.value : null;
    case 'relative':
      return addDays(base.date ?? ctx.today, date.days);
    case 'preset':
      switch (date.value) {
        case 'today':
          return ctx.today;
        case 'yesterday':
          return addDays(ctx.today, -1);
        case 'tomorrow':
          return addDays(ctx.today, 1);
        case 'day_after_tomorrow':
          return addDays(ctx.today, 2);
        default:
          return null;
      }
  }
}

function resolveCategory(raw: string, ctx: AgentContext): string | null {
  const value = raw.trim();
  if (value === '') return null;
  const byKey = ctx.categories.find((c) => c.key === value);
  if (byKey) return byKey.key;
  const byName = ctx.categories.find((c) => c.name === value);
  if (byName) return byName.key;
  const byId = ctx.categories.find((c) => c.id === value);
  if (byId) return byId.key;
  return guessCategoryFromText(value);
}

export interface AppliedPatch {
  draft: DraftState;
  issues: ResolutionIssue[];
  /** Things that happened but that the user should still see ("已排除小李"). */
  notes: string[];
}

/**
 * Merge an agent patch into a draft.
 *
 * `create_expense` starts from a clean draft (defaults: today / me / me-only);
 * `update_draft` merges onto the draft the user is already confirming, which is
 * what makes "小李不算，改成我和小王平摊" work without re-describing everything.
 */
export function applyPatch(base: DraftState, patch: AgentPatch, ctx: AgentContext): AppliedPatch {
  const issues: ResolutionIssue[] = [];
  const notes: string[] = [];
  const fresh = patch.action === 'create_expense';
  const draft: DraftState = fresh
    ? emptyDraft(ctx)
    : { ...base, participants: [...base.participants] };

  if (patch.type) draft.type = patch.type;

  if (patch.amount !== undefined && patch.amount !== null) {
    const cents = toCents(patch.amount, draft.currency);
    if (cents !== null && cents > 0) draft.amountCents = cents;
  }

  if (patch.date) {
    const resolved = resolveDate(patch.date, ctx, base);
    if (resolved) draft.date = resolved;
  }

  if (typeof patch.category === 'string') {
    const key = resolveCategory(patch.category, ctx);
    if (key) draft.categoryKey = key;
  }

  if (typeof patch.note === 'string' && patch.note.trim() !== '') {
    draft.note = patch.note.trim();
  }

  if (patch.paidBy) {
    const resolved = resolvePerson(patch.paidBy.ref, ctx);
    if (resolved.kind === 'user') {
      draft.paidBy = resolved.userId;
    } else if (resolved.kind === 'ambiguous') {
      issues.push({
        kind: 'ambiguous_person',
        ref: patch.paidBy.ref,
        candidates: resolved.candidates,
        message: `“${patch.paidBy.ref}”匹配到多位成员（${resolved.candidates
          .map((c) => c.nickname)
          .join('、')}），请问付款人是哪一位？`,
      });
    } else if (!isRoleWord(patch.paidBy.ref)) {
      issues.push({
        kind: 'unknown_person',
        ref: patch.paidBy.ref,
        message: `账本里找不到成员“${patch.paidBy.ref}”，请问这笔钱是谁付的？`,
      });
    }
  }

  applySharing(draft, patch, ctx, issues, notes, fresh);

  if (patch.action !== 'unknown') draft.source = 'agent';
  return { draft, issues, notes };
}

function dedupeParticipants(list: ParticipantState[]): ParticipantState[] {
  const seen = new Set<string>();
  const out: ParticipantState[] = [];
  for (const entry of list) {
    if (seen.has(entry.userId)) {
      const existing = out.find((p) => p.userId === entry.userId)!;
      if (entry.weight !== undefined) existing.weight = entry.weight;
      if (entry.amountCents !== undefined) existing.amountCents = entry.amountCents;
      continue;
    }
    seen.add(entry.userId);
    out.push({ ...entry });
  }
  return out;
}

function namesOf(members: LedgerMember[]): string {
  return members.map((m) => m.nickname).join('、');
}

function applySharing(
  draft: DraftState,
  patch: AgentPatch,
  ctx: AgentContext,
  issues: ResolutionIssue[],
  notes: string[],
  fresh: boolean,
): void {
  const sharing = patch.sharing;

  if (!sharing) {
    // No split information at all: on a brand new expense the person who paid is
    // the person who bears it; when refining, keep whatever the user already had.
    if (fresh) {
      draft.shareMode = 'equal';
      draft.participants = [{ userId: draft.paidBy ?? ctx.currentUserId }];
    }
    return;
  }

  const collect = (refs: { ref: string }[], label: string): ParticipantState[] => {
    const out: ParticipantState[] = [];
    for (const item of refs) {
      const resolved = resolvePerson(item.ref, ctx);
      if (resolved.kind === 'user') {
        out.push({ userId: resolved.userId });
        continue;
      }
      if (resolved.kind === 'ambiguous') {
        issues.push({
          kind: 'ambiguous_person',
          ref: item.ref,
          candidates: resolved.candidates,
          message: `“${item.ref}”匹配到多位成员（${resolved.candidates
            .map((c) => c.nickname)
            .join('、')}），请问${label}是哪一位？`,
        });
        continue;
      }
      // Role words ("朋友", "大家") are not identities; a real name that is not in
      // the ledger, however, must be surfaced instead of silently dropped.
      if (!isRoleWord(item.ref)) {
        issues.push({
          kind: 'unknown_person',
          ref: item.ref,
          message: `账本里找不到成员“${item.ref}”，请问${label}具体是谁？`,
        });
      }
    }
    return dedupeParticipants(out);
  };

  let participants: ParticipantState[] | null = null;

  if (sharing.includeAllMembers) {
    participants = ctx.members.map((m) => ({ userId: m.userId }));
    const expected = sharing.expectedParticipantCount;
    if (expected !== undefined && expected !== ctx.members.length) {
      issues.push({
        kind: 'participant_count_mismatch',
        message: `你说的是 ${expected} 个人，但当前账本有 ${ctx.members.length} 位成员（${namesOf(
          ctx.members,
        )}）。请确认要一起分摊的成员。`,
      });
    } else if (expected !== undefined) {
      notes.push(`已按 ${expected} 位成员分摊`);
    }
  }

  if (sharing.participants && sharing.participants.length > 0) {
    const resolved = collect(sharing.participants, '分摊人');
    const previous = new Map(draft.participants.map((p) => [p.userId, p]));
    participants = resolved.map((entry) => {
      const prev = previous.get(entry.userId);
      return prev ? { ...entry, weight: prev.weight, amountCents: prev.amountCents } : entry;
    });

    const expected = sharing.expectedParticipantCount;
    if (expected !== undefined && expected !== participants.length) {
      issues.push({
        kind: 'participant_count_mismatch',
        message: `你说的是 ${expected} 个人，但只识别出 ${participants.length} 位（账本共 ${
          ctx.members.length
        } 位成员：${namesOf(ctx.members)}）。请确认还有谁要分摊。`,
      });
    }
  }

  if (participants === null) participants = draft.participants.map((p) => ({ ...p }));
  const list = participants;

  if (sharing.exclude && sharing.exclude.length > 0) {
    for (const item of sharing.exclude) {
      const resolved = resolvePerson(item.ref, ctx);
      if (resolved.kind === 'user') {
        const before = list.length;
        const kept = list.filter((p) => p.userId !== resolved.userId);
        if (kept.length < before) notes.push(`已排除 ${resolved.nickname}`);
        list.length = 0;
        list.push(...kept);
      } else if (resolved.kind === 'ambiguous') {
        issues.push({
          kind: 'ambiguous_person',
          ref: item.ref,
          candidates: resolved.candidates,
          message: `“${item.ref}”匹配到多位成员（${resolved.candidates
            .map((c) => c.nickname)
            .join('、')}），请问要排除的是哪一位？`,
        });
      }
    }
  }

  draft.participants = dedupeParticipants(list);
  applyWeightsAndAmounts(draft, sharing, ctx, issues);
}

function applyWeightsAndAmounts(
  draft: DraftState,
  sharing: NonNullable<AgentPatch['sharing']>,
  ctx: AgentContext,
  issues: ResolutionIssue[],
): void {
  const participants = draft.participants;
  const ensure = (userId: string): ParticipantState => {
    let target = participants.find((p) => p.userId === userId);
    if (!target) {
      target = { userId };
      participants.push(target);
    }
    return target;
  };

  const unresolvedIssue = (ref: string, label: string) => {
    const resolved = resolvePerson(ref, ctx);
    if (resolved.kind === 'ambiguous') {
      issues.push({
        kind: 'ambiguous_person',
        ref,
        candidates: resolved.candidates,
        message: `“${ref}”匹配到多位成员（${resolved.candidates
          .map((c) => c.nickname)
          .join('、')}），请问${label}是哪一位？`,
      });
    } else if (resolved.kind === 'unknown' && !isRoleWord(ref)) {
      issues.push({
        kind: 'unknown_person',
        ref,
        message: `账本里找不到成员“${ref}”，请问${label}是谁？`,
      });
    }
    return null;
  };

  if (sharing.weights && sharing.weights.length > 0) {
    draft.shareMode = 'weights';
    for (const entry of sharing.weights) {
      const resolved = resolvePerson(entry.ref, ctx);
      if (resolved.kind !== 'user') {
        unresolvedIssue(entry.ref, '这一位');
        continue;
      }
      ensure(resolved.userId).weight = entry.weight;
    }
  }

  if (sharing.amounts && sharing.amounts.length > 0) {
    draft.shareMode = 'amounts';
    for (const entry of sharing.amounts) {
      const resolved = resolvePerson(entry.ref, ctx);
      if (resolved.kind !== 'user') {
        unresolvedIssue(entry.ref, '这一位');
        continue;
      }
      const cents = toCents(entry.amount, draft.currency);
      if (cents !== null) ensure(resolved.userId).amountCents = cents;
    }
  }

  if (sharing.remainderTo) {
    const resolved = resolvePerson(sharing.remainderTo.ref, ctx);
    if (resolved.kind === 'user') {
      const target = participants.find((p) => p.userId === resolved.userId);
      if (sharing.amounts && sharing.amounts.length > 0) {
        draft.shareMode = 'amounts';
        // "剩下我自己承担": leave this participant open so materialisation
        // assigns the exact remainder.
        if (target) delete target.amountCents;
        else participants.push({ userId: resolved.userId });
      } else if (!target) {
        participants.push({ userId: resolved.userId });
      }
    } else {
      unresolvedIssue(sharing.remainderTo.ref, '剩下的部分由谁承担');
    }
  }

  draft.participants = dedupeParticipants(participants);
}

export type MaterializeResult =
  | { ok: true; shares: { userId: string; amountCents: number }[] }
  | { ok: false; reason: 'amount_missing' | 'participants_empty'; message: string };

/**
 * Turn the draft into concrete integer shares. Everything that can be computed
 * is computed here (including the "remainder to me" case) so the confirmation
 * screen can show the exact per-person numbers before anything is saved.
 */
export function materializeDraft(draft: DraftState): MaterializeResult {
  const amount = draft.amountCents;
  if (amount === null || !Number.isInteger(amount) || amount <= 0) {
    return { ok: false, reason: 'amount_missing', message: '这笔账是多少钱？' };
  }

  const participants = dedupeParticipants(draft.participants);
  if (participants.length === 0) {
    return { ok: false, reason: 'participants_empty', message: '这笔钱最终由谁承担？' };
  }

  if (draft.shareMode === 'weights') {
    const weights = participants.map((p) => Math.max(0, p.weight ?? 1));
    if (weights.every((w) => w === 0)) {
      return {
        ok: true,
        shares: participants.map((p, index) => ({
          userId: p.userId,
          amountCents: allocateEqual(amount, participants.length)[index] ?? 0,
        })),
      };
    }
    const parts = allocate(amount, weights);
    return {
      ok: true,
      shares: participants.map((p, index) => ({
        userId: p.userId,
        amountCents: parts[index] ?? 0,
      })),
    };
  }

  if (draft.shareMode === 'amounts') {
    const fixedSum = participants.reduce((acc, p) => acc + (p.amountCents ?? 0), 0);
    const open = participants.filter((p) => p.amountCents === undefined);
    if (open.length === 0) {
      // Fully specified: pass through unchanged so the validator can compare the
      // sum against the total and report a precise violation.
      return {
        ok: true,
        shares: participants.map((p) => ({ userId: p.userId, amountCents: p.amountCents ?? 0 })),
      };
    }
    const remaining = amount - fixedSum;
    const parts = remaining >= 0 ? allocateEqual(remaining, open.length) : open.map(() => 0);
    let cursor = 0;
    return {
      ok: true,
      shares: participants.map((p) => {
        if (p.amountCents !== undefined) return { userId: p.userId, amountCents: p.amountCents };
        const value = parts[cursor] ?? 0;
        cursor += 1;
        return { userId: p.userId, amountCents: value };
      }),
    };
  }

  const parts = allocateEqual(amount, participants.length);
  return {
    ok: true,
    shares: participants.map((p, index) => ({
      userId: p.userId,
      amountCents: parts[index] ?? 0,
    })),
  };
}

