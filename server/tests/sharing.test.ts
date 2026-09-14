import { describe, expect, it } from 'vitest';
import { interpret } from '../src/agent/interpret.js';
import { makeContext, TODAY } from './helpers.js';
import type { AgentContext, DraftState } from '../src/agent/resolve.js';

/**
 * The split scenarios from the product spec, end to end through the real
 * pipeline (interpret → resolve → materialise → validate).
 *
 * These are the behaviours that decide whether this app can express
 * "我付了 500，小王承担 200，剩下我自己承担" without a data-model rewrite later.
 */

const NO_LLM = { enabled: false, apiKey: '', baseUrl: '', model: '', timeoutMs: 1000 };

async function parse(
  text: string,
  options: { nicknames?: string[]; pending?: DraftState; today?: string } = {},
): Promise<{ result: Awaited<ReturnType<typeof interpret>>; ctx: AgentContext }> {
  const context = makeContext({
    nicknames: options.nicknames ?? ['我', '小王', '小李'],
    today: options.today ?? TODAY,
  });
  const result = await interpret({
    text,
    ctx: context,
    source: 'text',
    llm: NO_LLM,
    pendingDraft: options.pending ?? null,
  });
  return { result, ctx: context };
}

function sharesByName(ctx: AgentContext, result: Awaited<ReturnType<typeof interpret>>) {
  const out: Record<string, number> = {};
  for (const share of result.preview?.shares ?? []) {
    const member = ctx.members.find((m) => m.userId === share.userId);
    out[member?.nickname ?? share.userId] = share.amountCents;
  }
  return out;
}

function payerName(ctx: AgentContext, result: Awaited<ReturnType<typeof interpret>>) {
  const id = result.preview?.paidBy.userId;
  return ctx.members.find((m) => m.userId === id)?.nickname ?? null;
}

describe('scenario 1 — equal split among the whole ledger', () => {
  it('"这顿饭我付的，一共 300，我们三个人平摊。"', async () => {
    const { result, ctx } = await parse('这顿饭我付的，一共 300，我们三个人平摊。');

    expect(result.ready).toBe(true);
    expect(result.preview?.amountCents).toBe(30000);
    expect(result.preview?.categoryKey).toBe('food');
    expect(payerName(ctx, result)).toBe('我');
    expect(sharesByName(ctx, result)).toEqual({ 我: 10000, 小王: 10000, 小李: 10000 });
  });
});

describe('scenario 2 — explicit per-person amounts with a remainder', () => {
  it('"我付了 500，小王承担 200，剩下我自己承担。"', async () => {
    const { result, ctx } = await parse('我付了 500，小王承担 200，剩下我自己承担。');

    expect(result.ready).toBe(true);
    expect(result.preview?.amountCents).toBe(50000);
    expect(payerName(ctx, result)).toBe('我');
    expect(sharesByName(ctx, result)).toEqual({ 我: 30000, 小王: 20000 });
  });
});

describe('scenario 3 — excluding a member', () => {
  it('"这 600 块我付的，我和小王一人一半，小李不算。"', async () => {
    const { result, ctx } = await parse('这 600 块我付的，我和小王一人一半，小李不算。');

    expect(result.ready).toBe(true);
    expect(result.preview?.amountCents).toBe(60000);
    expect(payerName(ctx, result)).toBe('我');
    expect(sharesByName(ctx, result)).toEqual({ 我: 30000, 小王: 30000 });
    // 小李 is not part of the split at all.
    expect(Object.keys(sharesByName(ctx, result))).not.toContain('小李');
  });
});

describe('scenario 4 — travellers, split four ways', () => {
  it('"酒店 1200 我先付了，我们四个人平摊。"', async () => {
    const { result, ctx } = await parse('酒店 1200 我先付了，我们四个人平摊。', {
      nicknames: ['我', '小王', '小李', '小张'],
    });

    expect(result.ready).toBe(true);
    expect(result.preview?.amountCents).toBe(120000);
    expect(result.preview?.categoryKey).toBe('lodging');
    expect(payerName(ctx, result)).toBe('我');
    expect(sharesByName(ctx, result)).toEqual({
      我: 30000,
      小王: 30000,
      小李: 30000,
      小张: 30000,
    });
  });
});

describe('MVP rounding case', () => {
  it('"我付了 500，我们三个人吃饭，其中小王和小李也要分摊。"', async () => {
    const { result, ctx } = await parse('我付了 500，我们三个人吃饭，其中小王和小李也要分摊。');

    expect(result.ready).toBe(true);
    expect(result.preview?.amountCents).toBe(50000);
    expect(payerName(ctx, result)).toBe('我');

    const shares = sharesByName(ctx, result);
    // 166.67 + 166.67 + 166.66 === 500.00 exactly.
    expect(shares).toEqual({ 我: 16667, 小王: 16667, 小李: 16666 });
    expect(Object.values(shares).reduce((a, b) => a + b, 0)).toBe(50000);
  });
});

describe('follow-up context', () => {
  it('understands "第二天也是 800" as another lodging expense', async () => {
    const first = await parse('昨天酒店花了 800。');
    expect(first.result.ready).toBe(true);

    const second = await parse('第二天也是 800。', { pending: first.result.draft });

    expect(second.result.action).toBe('create_expense');
    expect(second.result.ready).toBe(true);
    expect(second.result.preview?.amountCents).toBe(80000);
    expect(second.result.preview?.categoryKey).toBe('lodging');
    // "第二天" is the day after 昨天, i.e. today.
    expect(second.result.preview?.date).toBe('2026-09-14');
    expect(second.result.preview?.note).toBe('酒店');
    expect(second.result.preview?.paidBy.userId).toBe(second.ctx.currentUserId);
  });

  it('reuses the previous amount when only the date changes', async () => {
    const first = await parse('昨天酒店花了 800。');
    const second = await parse('第二天也是一样的。', { pending: first.result.draft });
    expect(second.result.preview?.amountCents).toBe(80000);
  });
});

describe('refining a pending draft', () => {
  it('"小李不算，改成我和小王平摊。" applies to the draft being confirmed', async () => {
    const first = await parse('我付了 300，我们三个人平摊。');
    expect(first.result.ready).toBe(true);
    expect(first.result.preview?.amountCents).toBe(30000);

    const refined = await parse('小李不算，改成我和小王平摊。', { pending: first.result.draft });

    expect(refined.result.action).toBe('update_draft');
    expect(refined.result.ready).toBe(true);
    // The total is preserved — the user only changed who shares it.
    expect(refined.result.preview?.amountCents).toBe(30000);
    expect(sharesByName(refined.ctx, refined.result)).toEqual({ 我: 15000, 小王: 15000 });
  });

  it('"小李不算" alone keeps everything else and drops one participant', async () => {
    const first = await parse('我付了 300，我们三个人平摊。');
    const refined = await parse('小李不算。', { pending: first.result.draft });
    expect(refined.result.ready).toBe(true);
    expect(sharesByName(refined.ctx, refined.result)).toEqual({ 我: 15000, 小王: 15000 });
  });
});

describe('refusing to guess', () => {
  it('asks when a name matches more than one member', async () => {
    const { result } = await parse('这 300 我付的，小王承担 100。', {
      nicknames: ['我', '小王', '小王'],
    });
    expect(result.ready).toBe(false);
    expect(result.questions.join(' ')).toContain('匹配到多位成员');
  });

  it('asks when the named person is not in the ledger', async () => {
    const { result } = await parse('阿强付了 300 买书。');
    expect(result.ready).toBe(false);
    expect(result.questions.join(' ')).toContain('阿强');
  });

  it('asks when the head count does not match the ledger roster', async () => {
    const { result } = await parse('我们四个人平摊，一共 1200。', {
      nicknames: ['我', '小王', '小李'],
    });
    expect(result.ready).toBe(false);
    expect(result.questions.join(' ')).toContain('4 个人');
    expect(result.questions.join(' ')).toContain('3 位成员');
  });

  it('asks for the amount when none was spoken', async () => {
    const { result } = await parse('昨天晚上和小王吃饭。');
    expect(result.ready).toBe(false);
    expect(result.questions.join(' ')).toContain('多少钱');
  });
});

describe('share invariants', () => {
  it('rejects splits that do not add up to the total', async () => {
    const { result } = await parse('这顿饭一共 500，小王承担 200，小李承担 200，我承担 200。');
    expect(result.ready).toBe(false);
    expect(result.violations.map((v) => v.rule)).toContain('shares_sum_mismatch');
  });

  it('always produces shares that sum to the total', async () => {
    // Amounts are spoken in yuan; the wire/persistence format is cents.
    for (const totalYuan of [1, 9.99, 100, 500, 1234.57]) {
      const totalCents = Math.round(totalYuan * 100);
      for (const people of [2, 3, 4, 6, 7]) {
        const nicknames = ['我', ...Array.from({ length: people - 1 }, (_, i) => `成员${i + 2}`)];
        const { result } = await parse(`一共 ${totalYuan} 元，我们${people}个人平摊。`, { nicknames });
        expect(result.ready).toBe(true);
        const shares = result.preview?.shares ?? [];
        expect(shares).toHaveLength(people);
        const sum = shares.reduce((a, s) => a + s.amountCents, 0);
        expect(sum).toBe(totalCents);
        // Nobody is asked for a fraction of a cent, and nobody pays a negative amount.
        expect(shares.every((s) => Number.isInteger(s.amountCents) && s.amountCents >= 0)).toBe(true);
      }
    }
  });
});
