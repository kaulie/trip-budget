import type { AgentContext, DraftState } from './resolve.js';
import { formatCents } from '../domain/money.js';

/**
 * The agent's instructions.
 *
 * Kept in one place so the contract is reviewable: the model must only ever
 * produce an intent description (`AgentPatch`) — never the persisted expense.
 * Amounts are in currency units, people are references, and anything the model
 * is unsure about must come back as a question instead of a guess.
 */

export const AGENT_SYSTEM_PROMPT = `你是一个「记账助手」，只做一件事：把用户的中文口语（或语音转写文本）转成结构化的记账操作 JSON。

规则（必须严格遵守）：
1. 只输出 JSON，不要输出任何解释文字、不要使用 markdown 代码块。
2. 不知道的信息不要编造。金额、日期这类关键信息没听清就不要填写，并在 questions 里提问。
3. 人名一律用用户说的“原话”作为引用（例如 ref 填 "小王"、"我"）。不要输出用户 ID。
   指代说话人自己一律用 ref = "me"。
4. 金额字段 amount 的单位是「元」（可以是小数），不是分。
5. 日期字段 date 可以是：
   - { "kind": "absolute", "value": "2026-09-14" }
   - { "kind": "relative", "days": -1 }（昨天）
   - { "kind": "preset", "value": "today" | "yesterday" | "tomorrow" }
6. 分摊信息放在 sharing 里：
   - participants: 参与者（"平摊/一起分摊"的人）
   - exclude: 明确排除的人（"小李不算"）
   - includeAllMembers: true 表示“账本里所有人”，例如“大家平摊”
   - expectedParticipantCount: 用户说的人数（“我们四个人” -> 4）
   - amounts: 指定金额（"小王承担 200" -> {ref:"小王", amount:200}）
   - remainderTo: "剩下我自己承担" -> {ref:"me"}
   - mode: "equal" 平均 / "weights" 按权重 / "amounts" 指定金额
   注意：付款人（paid_by）通常**不是**承担人。例如“我付了 300，我们三个人平摊”里，
   paid_by = "me"，participants = ["me", ...另外两个人]。
   如果用户没有提到任何人分摊，sharing 就留空（默认只有付款人自己承担）。
7. action 的含义：
   - "create_expense"：用户在描述一笔**新的**账目（默认值）
   - "update_draft"：用户在**修改**当前待确认的那笔账（例如“小李不算，改成我和小王平摊”“金额改成 200”）
   - "ask"：完全无法理解，需要用户重新说明
8. note 用简短的名词短语描述这笔钱是什么（例如“晚饭”“东京酒店”），不要包含金额和日期。
9. category 从给定分类里选 key；不确定就用 "other"。
10. assistantMessage 用一句简短中文复述你理解到的内容。

输出 JSON 结构：
{
  "action": "create_expense" | "update_draft" | "ask",
  "type": "expense" | "income",
  "amount": number | null,
  "category": string | null,
  "date": { ... } | null,
  "note": string | null,
  "paid_by": { "ref": string } | null,
  "sharing": {
    "mode": "equal" | "weights" | "amounts",
    "participants": [{ "ref": string }],
    "exclude": [{ "ref": string }],
    "includeAllMembers": boolean,
    "expectedParticipantCount": number,
    "amounts": [{ "ref": string, "amount": number }],
    "remainderTo": { "ref": string }
  } | null,
  "questions": [string],
  "assistantMessage": string,
  "confidence": number
}`;

export function buildAgentUserPrompt(
  text: string,
  ctx: AgentContext,
  options: { pendingDraft?: DraftState | null; recentNotes?: string[] },
): string {
  const roster = ctx.members
    .map(
      (m) =>
        `- ${m.nickname}${m.userId === ctx.currentUserId ? '（这是说话人自己，引用时用 ref="me"）' : ''}`,
    )
    .join('\n');

  const categories = ctx.categories.map((c) => `${c.key}=${c.name}`).join('、');

  const lines = [
    `【今天】${ctx.today}`,
    `【账本】${ctx.ledger.name}（货币 ${ctx.ledger.currency}）`,
    `【账本成员】\n${roster}`,
    `【可用分类】${categories}`,
  ];

  const draft = options.pendingDraft;
  if (draft) {
    const shares = draft.participants
      .map((p) => {
        const member = ctx.members.find((m) => m.userId === p.userId);
        const amount = p.amountCents !== undefined ? ` ¥${formatCents(p.amountCents)}` : '';
        return `${member?.nickname ?? p.userId}${amount}`;
      })
      .join('、');
    lines.push(
      `【当前待确认的账目】金额 ${draft.amountCents !== null ? `¥${formatCents(draft.amountCents)}` : '未知'}，` +
        `日期 ${draft.date ?? '未知'}，分类 ${draft.categoryKey ?? '未知'}，` +
        `付款人 ${ctx.members.find((m) => m.userId === draft.paidBy)?.nickname ?? '未知'}，` +
        `承担人 ${shares || '未知'}，备注 ${draft.note || '无'}`,
    );
  } else {
    lines.push('【当前待确认的账目】无');
  }

  if (options.recentNotes && options.recentNotes.length > 0) {
    lines.push(`【最近几笔】${options.recentNotes.join(' / ')}`);
  }

  lines.push('', `【用户这句话】${text}`, '', '请只输出 JSON。');
  return lines.join('\n');
}
