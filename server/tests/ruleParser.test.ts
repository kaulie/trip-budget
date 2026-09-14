import { describe, expect, it } from 'vitest';
import { parseWithRules } from '../src/agent/ruleParser.js';
import { TODAY } from './helpers.js';

/**
 * These tests pin down the money-critical examples from the product spec.
 * They run entirely offline (the rule parser), which is exactly why that parser
 * exists: the LLM can be swapped, these behaviours cannot.
 */

const options = { today: TODAY, roster: [], currentUserId: 'u0' };

describe('rule parser: basic capture', () => {
  it('extracts amount, category, date and payer from "昨天和朋友吃饭花了 280"', () => {
    const patch = parseWithRules('昨天和朋友吃饭花了 280。', {
      ...options,
      roster: [
        { userId: 'u0', nickname: '我' },
        { userId: 'u1', nickname: '小王' },
      ],
    });

    expect(patch.amount).toBe(280);
    expect(patch.category).toBe('food');
    expect(patch.date).toEqual({ kind: 'relative', days: -1 });
    // "朋友" is a role word, not an identity: no question, no guess.
    expect(patch.paidBy).toBeUndefined();
  });

  it('does not mistake a head count for an amount', () => {
    const patch = parseWithRules('我们 4 个人吃饭花了 400', options);
    expect(patch.amount).toBe(400);
    expect(patch.sharing?.expectedParticipantCount).toBe(4);
  });

  it('handles "一共 1200" style totals and lodging', () => {
    const patch = parseWithRules('东京酒店住了三晚，一共 1200。', options);
    expect(patch.amount).toBe(1200);
    expect(patch.category).toBe('lodging');
  });

  it('supports thousands separators and 万', () => {
    expect(parseWithRules('装修花了 1,200 块', options).amount).toBe(1200);
    expect(parseWithRules('买车花了 12万', options).amount).toBe(120000);
  });

  it('detects income', () => {
    const patch = parseWithRules('这个月工资收入 20000', options);
    expect(patch.type).toBe('income');
    expect(patch.amount).toBe(20000);
  });
});
