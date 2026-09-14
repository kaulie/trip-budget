import { describe, expect, it } from 'vitest';
import { interpret } from '../src/agent/interpret.js';
import { llmConfigFromEnv, type LlmConfig } from '../src/agent/llmParser.js';
import { makeContext, TODAY } from './helpers.js';

/**
 * Live model check.
 *
 * Skipped by default (CI has no network and no API key). Run it explicitly when
 * you want to verify the LLM path still produces the same structured result as
 * the deterministic parser:
 *
 *   LLM_E2E=1 npx vitest run tests/llm.e2e.test.ts
 *
 * The point is not that the model is needed — the rule parser handles these
 * sentences on its own — but that swapping the model cannot change the outcome,
 * because both paths produce the same `AgentPatch` and the same validator runs.
 */
const envConfig = llmConfigFromEnv();
const enabled = process.env.LLM_E2E === '1' && envConfig.apiKey !== '';

/** Bypasses `LLM_DISABLED`, which is set for the offline suite. */
const liveConfig: LlmConfig = { ...envConfig, enabled: true, timeoutMs: 45_000 };

describe.skipIf(!enabled)('LLM parser (live)', () => {
  it('understands the MVP sentence and splits ¥500 three ways', async () => {
    const ctx = makeContext({ nicknames: ['我', '小王', '小李'] });
    const result = await interpret({
      text: '我付了 500，我们三个人吃饭，其中小王和小李也要分摊。',
      ctx,
      source: 'voice',
      llm: liveConfig,
    });

    expect(result.parser).toBe('llm');
    expect(result.ready).toBe(true);
    expect(result.preview?.amountCents).toBe(50000);
    expect(result.preview?.paidBy.userId).toBe('u0');

    const shares = Object.fromEntries(
      (result.preview?.shares ?? []).map((share) => [
        ctx.members.find((m) => m.userId === share.userId)?.nickname,
        share.amountCents,
      ]),
    );
    expect(shares['我']! + shares['小王']! + shares['小李']!).toBe(50000);
    expect(Object.keys(shares).sort()).toEqual(['我', '小王', '小李'].sort());
  }, 60_000);

  it('handles an explicit-amount split', async () => {
    const ctx = makeContext({ nicknames: ['我', '小王', '小李'] });
    const result = await interpret({
      text: '我付了 500，小王承担 200，剩下我自己承担。',
      ctx,
      source: 'voice',
      llm: liveConfig,
    });

    expect(result.ready).toBe(true);
    const shares = Object.fromEntries(
      (result.preview?.shares ?? []).map((share) => [
        ctx.members.find((m) => m.userId === share.userId)?.nickname,
        share.amountCents,
      ]),
    );
    expect(shares['小王']).toBe(20000);
    expect(shares['我']).toBe(30000);
  }, 60_000);

  it('understands a follow-up in context', async () => {
    const ctx = makeContext({ nicknames: ['我', '小王'], today: TODAY });
    const first = await interpret({
      text: '昨天酒店花了 800。',
      ctx,
      source: 'voice',
      llm: liveConfig,
    });
    const second = await interpret({
      text: '第二天也是 800。',
      ctx,
      source: 'voice',
      llm: liveConfig,
      pendingDraft: first.draft,
    });
    expect(second.ready).toBe(true);
    expect(second.preview?.amountCents).toBe(80000);
    expect(second.preview?.categoryKey).toBe('lodging');
  }, 60_000);
});
