import { validateExpense } from '../domain/validation.js';
import type { ExpenseShare, ShareMode } from '../domain/types.js';
import type { RuleViolation } from '../lib/errors.js';
import { parseWithRules } from './ruleParser.js';
import { llmConfigFromEnv, parseWithLlm, type LlmConfig } from './llmParser.js';
import {
  applyPatch,
  emptyDraft,
  materializeDraft,
  type AgentContext,
  type DraftState,
  type ResolutionIssue,
} from './resolve.js';
import type { AgentAction, AgentPatch } from './schema.js';

/**
 * The orchestrator: language → patch → resolved draft → validated expense.
 *
 * The boundary matters. Everything above `validateExpense` is *interpretation*
 * and can be wrong; everything below is *deterministic business rules*. The agent
 * never writes to the database — it only produces a candidate, which the same
 * validator that guards the write path has already checked.
 */

export interface InterpretOptions {
  text: string;
  ctx: AgentContext;
  pendingDraft?: DraftState | null;
  source?: 'voice' | 'text' | 'manual';
  llm?: LlmConfig;
  recentNotes?: string[];
}

export interface PreviewShare {
  userId: string;
  nickname: string;
  amountCents: number;
}

export interface AgentPreview {
  type: 'expense' | 'income';
  amountCents: number;
  currency: string;
  categoryKey: string;
  categoryName: string;
  categoryIcon: string;
  date: string;
  note: string;
  paidBy: { userId: string; nickname: string };
  shareMode: ShareMode;
  shares: PreviewShare[];
  source: 'voice' | 'text' | 'manual' | 'agent';
  rawUtterance: string | null;
}

/** Fully validated payload, suitable for `POST /ledgers/:id/expenses`. */
export interface InterpretedExpense {
  type: 'expense' | 'income';
  amountCents: number;
  currency: string;
  categoryKey: string;
  date: string;
  note: string;
  paidBy: string;
  shareMode: ShareMode;
  shares: ExpenseShare[];
  source: 'voice' | 'text' | 'manual' | 'agent';
  rawUtterance: string | null;
}

export interface Interpretation {
  /** What the agent decided to do with the utterance. */
  action: AgentAction;
  parser: 'llm' | 'rule';
  llmError: string | null;
  /** True when the draft passed every business rule and can be saved as-is. */
  ready: boolean;
  patch: AgentPatch;
  draft: DraftState;
  preview: AgentPreview | null;
  expense: InterpretedExpense | null;
  issues: ResolutionIssue[];
  warnings: RuleViolation[];
  violations: RuleViolation[];
  questions: string[];
  assistantMessage: string;
  notes: string[];
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function interpret(options: InterpretOptions): Promise<Interpretation> {
  const { text, ctx } = options;
  const llm = options.llm ?? llmConfigFromEnv();
  const source = options.source ?? 'text';
  const pendingDraft = options.pendingDraft ?? null;

  const rulePatch = parseWithRules(text, {
    today: ctx.today,
    roster: ctx.members.map((m) => ({ userId: m.userId, nickname: m.nickname })),
    currentUserId: ctx.currentUserId,
    context: pendingDraft ? draftToRuleContext(pendingDraft) : { hasDraft: false },
  });

  let patch = rulePatch;
  let parser: 'llm' | 'rule' = 'rule';
  let llmError: string | null = null;

  if (llm.enabled) {
    const result = await parseWithLlm(text, ctx, {
      config: llm,
      pendingDraft,
      recentNotes: options.recentNotes,
    });
    if (result.patch) {
      parser = 'llm';
      patch = mergePatches(result.patch, rulePatch);
    } else {
      llmError = result.error;
    }
  }

  const base = patch.action === 'create_expense' || !pendingDraft ? emptyDraft(ctx) : pendingDraft;
  return interpretPatch({ patch, base, parser, llmError, text, ctx, source });
}

function draftToRuleContext(draft: DraftState) {
  return {
    date: draft.date,
    amountCents: draft.amountCents,
    categoryKey: draft.categoryKey,
    note: draft.note,
    participants: draft.participants.map((p) => p.userId),
    paidBy: draft.paidBy,
    hasDraft: true,
  };
}

function interpretPatch(args: {
  patch: AgentPatch;
  base: DraftState;
  parser: 'llm' | 'rule';
  llmError: string | null;
  text: string;
  ctx: AgentContext;
  source: 'voice' | 'text' | 'manual';
}): Interpretation {
  const { patch, ctx, text, source } = args;
  const applied = applyPatch(args.base, patch, ctx);
  const draft: DraftState = { ...applied.draft, source: 'agent', rawUtterance: text };

  const notes = [...applied.notes];
  const issues = [...applied.issues];
  const baseQuestions = [...(patch.questions ?? []), ...issues.map((i) => i.message)];
  const assistantMessage = patch.assistantMessage ?? '';

  const fail = (extra: {
    violations?: RuleViolation[];
    warnings?: RuleViolation[];
    questions?: string[];
    assistantMessage?: string;
  }): Interpretation => ({
    action: patch.action,
    parser: args.parser,
    llmError: args.llmError,
    ready: false,
    patch,
    draft,
    preview: null,
    expense: null,
    issues,
    warnings: extra.warnings ?? [],
    violations: extra.violations ?? [],
    questions: [...baseQuestions, ...(extra.questions ?? [])].filter(
      (q, index, all) => q.trim() !== '' && all.indexOf(q) === index,
    ),
    assistantMessage: extra.assistantMessage ?? assistantMessage,
    notes,
  });

  if (issues.length > 0) {
    return fail({ assistantMessage: assistantMessage || '我需要先确认几个信息。' });
  }

  const materialized = materializeDraft(draft);
  if (!materialized.ok) {
    return fail({
      questions: [materialized.message],
      assistantMessage: assistantMessage || materialized.message,
    });
  }

  const validation = validateExpense(
    {
      type: draft.type,
      amountCents: draft.amountCents,
      currency: draft.currency,
      categoryKey: draft.categoryKey ?? undefined,
      date: draft.date ?? undefined,
      note: draft.note,
      paidBy: draft.paidBy ?? '',
      shares: materialized.shares,
      shareMode: draft.shareMode,
      source,
      rawUtterance: text,
    },
    ctx,
  );

  if (!validation.ok) {
    return fail({
      violations: validation.violations,
      questions: validation.violations.map((v) => v.message),
      assistantMessage: assistantMessage || '这笔账的数据有问题，请改一下。',
    });
  }

  const value = validation.value;
  return {
    action: patch.action,
    parser: args.parser,
    llmError: args.llmError,
    ready: true,
    patch,
    draft,
    preview: buildPreview(value, ctx),
    expense: {
      type: value.type,
      amountCents: value.amountCents,
      currency: value.currency,
      categoryKey: value.categoryKey,
      date: value.date,
      note: value.note,
      paidBy: value.paidBy,
      shareMode: value.shareMode,
      shares: value.shares,
      source: value.source,
      rawUtterance: text,
    },
    issues,
    warnings: validation.warnings,
    violations: [],
    questions: baseQuestions,
    assistantMessage: assistantMessage || defaultMessage(value.type, value.amountCents),
    notes,
  };
}

function defaultMessage(type: 'expense' | 'income', amountCents: number): string {
  const label = type === 'income' ? '收入' : '支出';
  return `好的，${label} ¥${(amountCents / 100).toFixed(2)}，请确认。`;
}

function buildPreview(
  value: {
    type: 'expense' | 'income';
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
  },
  ctx: AgentContext,
): AgentPreview {
  const category =
    ctx.categories.find((c) => c.id === value.categoryId) ??
    ctx.categories.find((c) => c.key === value.categoryKey);
  const nicknameOf = (userId: string) =>
    ctx.members.find((m) => m.userId === userId)?.nickname ?? userId;

  return {
    type: value.type,
    amountCents: value.amountCents,
    currency: value.currency,
    categoryKey: value.categoryKey,
    categoryName: category?.name ?? value.categoryKey,
    categoryIcon: category?.icon ?? 'tag.fill',
    date: value.date,
    note: value.note,
    paidBy: { userId: value.paidBy, nickname: nicknameOf(value.paidBy) },
    shareMode: value.shareMode,
    shares: value.shares.map((share) => ({
      userId: share.userId,
      nickname: nicknameOf(share.userId),
      amountCents: share.amountCents,
    })),
    source: value.source,
    rawUtterance: value.rawUtterance,
  };
}

/**
 * The model is better at language, the rule parser is better at digits. Fill any
 * field the model left out from the deterministic parse — never the other way
 * round, so a confident model still owns the phrasing.
 */
export function mergePatches(primary: AgentPatch, fallback: AgentPatch): AgentPatch {
  const merged: AgentPatch = { ...primary };
  if (merged.amount === undefined || merged.amount === null) {
    if (fallback.amount !== undefined && fallback.amount !== null) merged.amount = fallback.amount;
  }
  if (merged.date === undefined || merged.date === null) {
    if (fallback.date) merged.date = fallback.date;
  }
  if (merged.category === undefined || merged.category === null) {
    if (fallback.category) merged.category = fallback.category;
  }
  if (!merged.paidBy && fallback.paidBy) merged.paidBy = fallback.paidBy;
  if (!merged.type && fallback.type) merged.type = fallback.type;
  if (!merged.note && fallback.note) merged.note = fallback.note;
  if (!merged.sharing && fallback.sharing) merged.sharing = fallback.sharing;
  return merged;
}
