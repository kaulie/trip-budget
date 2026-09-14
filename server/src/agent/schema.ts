import type { ExpenseType, ShareMode } from '../domain/types.js';

/**
 * The wire format between "language understanding" and "business rules".
 *
 * This is the *only* thing the agent is allowed to produce. It is deliberately
 * provider-agnostic: the LLM parser, the offline rule parser and any future
 * model all emit exactly this shape, so swapping the model never touches the
 * business system. Note that it is intentionally *not* the persisted expense
 * shape — refs are still natural-language ("me", "小王") and the amount is in
 * currency units, not cents. Resolution + validation happen afterwards.
 */

export type AgentAction = 'create_expense' | 'update_draft' | 'ask' | 'unknown';

/** A reference to a person, in whatever form the user said it. */
export interface AgentPersonRef {
  /** `me` / `我` / a nickname / a user id. */
  ref: string;
}

export type AgentDate =
  | { kind: 'absolute'; value: string }
  | { kind: 'relative'; days: number }
  | { kind: 'preset'; value: 'today' | 'yesterday' | 'tomorrow' | 'day_after_tomorrow' };

export interface AgentSharing {
  mode?: ShareMode;
  /** People who bear (part of) the cost — replaces the current participant list. */
  participants?: AgentPersonRef[];
  /** People explicitly removed from the split ("小李不算"). */
  exclude?: AgentPersonRef[];
  /** Every member of the ledger ("大家平摊"). */
  includeAllMembers?: boolean;
  /** "我们四个人" — how many people the user said. Used to validate, never to guess. */
  expectedParticipantCount?: number;
  /** Relative weights, e.g. "我出两份" -> weight 2. */
  weights?: { ref: string; weight: number }[];
  /** Absolute per-person amounts, e.g. "小王承担 200". */
  amounts?: { ref: string; amount: number }[];
  /** "剩下我自己承担" — give the remainder to this person. */
  remainderTo?: AgentPersonRef;
}

export interface AgentPatch {
  action: AgentAction;
  type?: ExpenseType;
  /** In currency units (e.g. 128.5), not cents. */
  amount?: number | null;
  currency?: string;
  /** Category key, category name, or free text; resolved server-side. */
  category?: string | null;
  date?: AgentDate | null;
  note?: string | null;
  paidBy?: AgentPersonRef | null;
  sharing?: AgentSharing | null;
  /** Questions the agent wants the user to answer before anything is saved. */
  questions?: string[];
  /** Short, human-facing reply shown above the draft card. */
  assistantMessage?: string;
  confidence?: number;
}

const PERSON_ROLE_WORDS = new Set([
  'me', 'i', 'myself', '我', '自己', '本人', '我们', '大家', '所有人', '全部人', '全员',
  '朋友', '我的朋友', '同事', '同事们', '同学', '家人', '家里人', '大家伙', '伙计',
  '对方', '其他人', '别人', '旁人',
]);

/** Words that describe a *role*, not a specific person — they never trigger a question. */
export function isRoleWord(ref: string): boolean {
  const cleaned = ref.trim().toLowerCase().replace(/[的了们啊吧呢，,。.\s]/g, '');
  if (cleaned === '') return true;
  return PERSON_ROLE_WORDS.has(cleaned);
}

export function isSelfRef(ref: string): boolean {
  const cleaned = ref.trim().toLowerCase().replace(/[的了啊吧呢，,。.\s]/g, '');
  return (
    cleaned === 'me' ||
    cleaned === 'i' ||
    cleaned === 'myself' ||
    cleaned === 'self' ||
    cleaned === '我' ||
    cleaned === '自己' ||
    cleaned === '本人' ||
    cleaned === 'current_user'
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asRefs(raw: unknown): AgentPersonRef[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: AgentPersonRef[] = [];
  for (const entry of raw) {
    const ref = asRef(entry);
    if (ref) out.push(ref);
  }
  return out.length > 0 ? out : undefined;
}

function asRef(raw: unknown): AgentPersonRef | undefined {
  if (typeof raw === 'string' && raw.trim() !== '') return { ref: raw.trim() };
  if (isRecord(raw)) {
    if (typeof raw.ref === 'string' && raw.ref.trim() !== '') return { ref: raw.ref.trim() };
    if (typeof raw.name === 'string' && raw.name.trim() !== '') return { ref: raw.name.trim() };
    if (typeof raw.userId === 'string' && raw.userId.trim() !== '') {
      return { ref: raw.userId.trim() };
    }
    if (typeof raw.user_id === 'string' && raw.user_id.trim() !== '') {
      return { ref: raw.user_id.trim() };
    }
  }
  return undefined;
}

function asNumber(raw: unknown): number | undefined {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'string') {
    const cleaned = raw.replace(/[,\s¥￥$元块钱]/g, '');
    if (cleaned === '') return undefined;
    const n = Number(cleaned);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

const PRESETS = new Set(['today', 'yesterday', 'tomorrow', 'day_after_tomorrow']);

function asDate(raw: unknown): AgentDate | undefined {
  if (typeof raw === 'string') {
    const value = raw.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return { kind: 'absolute', value };
    const lower = value.toLowerCase();
    if (lower === 'today' || lower === '今天') return { kind: 'preset', value: 'today' };
    if (lower === 'yesterday' || lower === '昨天') return { kind: 'preset', value: 'yesterday' };
    if (lower === 'tomorrow' || lower === '明天') return { kind: 'preset', value: 'tomorrow' };
    return undefined;
  }
  if (isRecord(raw)) {
    if (raw.kind === 'absolute' && typeof raw.value === 'string') {
      const value = raw.value.trim();
      if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return { kind: 'absolute', value };
      return undefined;
    }
    if (raw.kind === 'relative') {
      const days = asNumber(raw.days);
      if (days !== undefined) return { kind: 'relative', days: Math.round(days) };
      return undefined;
    }
    if (raw.kind === 'preset' && typeof raw.value === 'string' && PRESETS.has(raw.value)) {
      return {
        kind: 'preset',
        value: raw.value as 'today' | 'yesterday' | 'tomorrow' | 'day_after_tomorrow',
      };
    }
  }
  return undefined;
}

/**
 * Defensive normalization of whatever a model returned. Anything unrecognised is
 * dropped rather than guessed — the agent's output is untrusted input.
 */
export function normalizeAgentPatch(raw: unknown): AgentPatch {
  if (!isRecord(raw)) return { action: 'unknown' };

  const actionRaw = typeof raw.action === 'string' ? raw.action : '';
  const action: AgentAction =
    actionRaw === 'create_expense' || actionRaw === 'update_draft' || actionRaw === 'ask'
      ? actionRaw
      : 'unknown';

  const patch: AgentPatch = { action };

  if (raw.type === 'expense' || raw.type === 'income') patch.type = raw.type;

  const amount = asNumber(raw.amount ?? raw.total ?? raw.totalAmount);
  if (amount !== undefined) patch.amount = amount;

  if (typeof raw.currency === 'string' && raw.currency.trim() !== '') {
    patch.currency = raw.currency.trim().toUpperCase();
  }
  if (typeof raw.category === 'string' && raw.category.trim() !== '') {
    patch.category = raw.category.trim();
  }

  const date = asDate(raw.date);
  if (date) patch.date = date;

  if (typeof raw.note === 'string') patch.note = raw.note.trim();
  else if (typeof raw.description === 'string') patch.note = raw.description.trim();

  const paidBy = asRef(raw.paidBy ?? raw.paid_by ?? raw.payer);
  if (paidBy) patch.paidBy = paidBy;

  const sharingRaw = isRecord(raw.sharing) ? raw.sharing : isRecord(raw.split) ? raw.split : null;
  const sharing = sharingRaw ? normalizeSharing(sharingRaw) : undefined;
  if (sharing) patch.sharing = sharing;

  if (Array.isArray(raw.questions)) {
    const questions = raw.questions.filter(
      (q): q is string => typeof q === 'string' && q.trim() !== '',
    );
    if (questions.length > 0) patch.questions = questions;
  }

  const message = raw.assistantMessage ?? raw.assistant_message ?? raw.message ?? raw.reply;
  if (typeof message === 'string' && message.trim() !== '') patch.assistantMessage = message.trim();

  const confidence = asNumber(raw.confidence);
  if (confidence !== undefined) patch.confidence = confidence;

  return patch;
}

function normalizeSharing(sharingRaw: Record<string, unknown>): AgentSharing | undefined {
  const sharing: AgentSharing = {};

  const mode = sharingRaw.mode ?? sharingRaw.shareMode;
  if (mode === 'equal' || mode === 'weights' || mode === 'amounts') sharing.mode = mode;

  const participants = asRefs(sharingRaw.participants ?? sharingRaw.members);
  if (participants) sharing.participants = participants;

  const exclude = asRefs(
    sharingRaw.exclude ?? sharingRaw.excluded ?? sharingRaw.excludeParticipants,
  );
  if (exclude) sharing.exclude = exclude;

  if (sharingRaw.includeAllMembers === true || sharingRaw.allMembers === true) {
    sharing.includeAllMembers = true;
  }

  const expected = asNumber(
    sharingRaw.expectedParticipantCount ?? sharingRaw.participantCount ?? sharingRaw.peopleCount,
  );
  if (expected !== undefined && expected > 0) {
    sharing.expectedParticipantCount = Math.round(expected);
  }

  if (Array.isArray(sharingRaw.weights)) {
    const weights: { ref: string; weight: number }[] = [];
    for (const entry of sharingRaw.weights) {
      if (!isRecord(entry)) continue;
      const ref = asRef(entry.ref ?? entry.userId ?? entry.name);
      const weight = asNumber(entry.weight ?? entry.shares ?? entry.count);
      if (ref && weight !== undefined && weight >= 0) weights.push({ ref: ref.ref, weight });
    }
    if (weights.length > 0) sharing.weights = weights;
  }

  if (Array.isArray(sharingRaw.amounts)) {
    const amounts: { ref: string; amount: number }[] = [];
    for (const entry of sharingRaw.amounts) {
      if (!isRecord(entry)) continue;
      const ref = asRef(entry.ref ?? entry.userId ?? entry.name);
      const value = asNumber(entry.amount ?? entry.value);
      if (ref && value !== undefined) amounts.push({ ref: ref.ref, amount: value });
    }
    if (amounts.length > 0) sharing.amounts = amounts;
  }

  const remainderTo = asRef(sharingRaw.remainderTo ?? sharingRaw.remainder_to);
  if (remainderTo) sharing.remainderTo = remainderTo;

  return Object.keys(sharing).length > 0 ? sharing : undefined;
}

