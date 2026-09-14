import { guessCategoryFromText } from '../domain/categories.js';
import { addDays } from '../lib/dates.js';
import type { AgentDate, AgentPatch, AgentPersonRef, AgentSharing } from './schema.js';
import { isRoleWord } from './schema.js';

/**
 * Deterministic, offline natural-language parser.
 *
 * Why this exists next to an LLM parser:
 *   1. it is the fallback when the model is unreachable / unconfigured, so the
 *      app is never unable to record an expense;
 *   2. it is fully unit-testable, which is how the money-critical examples from
 *      the product spec are pinned down in CI;
 *   3. it demonstrates the boundary — this module produces the same `AgentPatch`
 *      as the LLM, so nothing downstream knows which one ran.
 *
 * It is intentionally *not* a general NLP system: it handles the phrasings that
 * matter for expense capture (amount / type / category / date / payer / split).
 */

export interface RosterEntry {
  userId: string;
  nickname: string;
}

export interface RuleParserOptions {
  /** Local today, YYYY-MM-DD. */
  today: string;
  roster: RosterEntry[];
  currentUserId: string;
  /** Context of the draft being refined, used for follow-ups like "第二天也是 800". */
  context?: {
    date?: string | null;
    amountCents?: number | null;
    categoryKey?: string | null;
    note?: string | null;
    participants?: string[] | null;
    paidBy?: string | null;
    hasDraft?: boolean;
  } | null;
}

const CN_DIGITS: Record<string, number> = {
  零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5,
  六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
};

function cnNumber(token: string): number | null {
  const trimmed = token.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  if (trimmed === '俩') return 2;
  if (trimmed === '仨') return 3;
  if (trimmed.length === 1 && CN_DIGITS[trimmed] !== undefined) return CN_DIGITS[trimmed]!;
  if (/^十[一二三四五六七八九]$/.test(trimmed)) return 10 + CN_DIGITS[trimmed[1]!]!;
  if (/^[一二三四五六七八九]十[一二三四五六七八九]?$/.test(trimmed)) {
    const tens = CN_DIGITS[trimmed[0]!]! * 10;
    const ones = trimmed.length === 3 ? CN_DIGITS[trimmed[2]!]! : 0;
    return tens + ones;
  }
  return null;
}

/** Full-width digits/letters -> ASCII, tidy separators, drop emoji noise. */
export function normalizeUtterance(text: string): string {
  return text
    .replace(/[\uFF10-\uFF19]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[\uFF21-\uFF3A\uFF41-\uFF5A]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[，、；]/g, ',')
    .replace(/[。！？!?；;~～]/g, '。')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface AmountExtraction {
  value: number;
  matched: string;
}

/**
 * Amount extraction with explicit precedence, because digits in an utterance are
 * ambiguous: "我们四个人吃饭花了 400" contains two numbers and only one of them
 * is money. Measure words ("人", "晚", "天") always disqualify a number, as do
 * dates.
 */
export function extractAmount(text: string): AmountExtraction | null {
  const cleaned = text.replace(/(\d),(\d{3})(?!\d)/g, '$1$2');
  const candidates: { value: number; priority: number; index: number; matched: string }[] = [];

  const push = (raw: string, priority: number, index: number, multiplier = 1) => {
    const n = Number(raw);
    if (!Number.isFinite(n)) return;
    candidates.push({ value: n * multiplier, priority, index, matched: raw });
  };

  let m: RegExpExecArray | null;

  // P0: explicit currency symbol.
  const symbolRe = /[¥￥$]\s*([0-9]+(?:\.[0-9]+)?)\s*(万|千|百)?/g;
  while ((m = symbolRe.exec(cleaned))) {
    push(m[1]!, 0, m.index, multiplierOf(m[2]));
  }

  // P1: an explicit unit ("400 块", "1200 元", "1.2 万").
  const unitRe = /([0-9]+(?:\.[0-9]+)?)\s*(万|千|百)?\s*(?:块钱|元钱|块|元|人民币|rmb)/gi;
  while ((m = unitRe.exec(cleaned))) {
    push(m[1]!, 1, m.index, multiplierOf(m[2]));
  }

  // P2: an amount verb ("一共 300", "花了 160", "我付了 500").
  const verbRe =
    /(?:一共|总共|共计|合计|总计|总共|共|消费|花费|花了|花掉|付了|付款|支付了|支付|支出|用了|收了|收到|赚了|进账|报销了)\s*(?:了)?\s*(?:共)?\s*([0-9]+(?:\.[0-9]+)?)\s*(万|千|百)?/g;
  while ((m = verbRe.exec(cleaned))) {
    push(m[1]!, 2, m.index, multiplierOf(m[2]));
  }

  // P3: a bare number that is neither a measure phrase nor part of a date.
  const bareRe = /([0-9]+(?:\.[0-9]+)?)\s*(万|千|百)?/g;
  while ((m = bareRe.exec(cleaned))) {
    const after = cleaned.slice(m.index + m[0].length);
    if (/^\s*(?:个|人|位|晚|天|小时|分钟|次|份|张|间|家|台|件|瓶|杯|碗|顿|年|月|日|号|周|岁|层|楼|场|袋|盒|套|只|条)/.test(after)) {
      continue;
    }
    const before = cleaned.slice(Math.max(0, m.index - 2), m.index);
    if (/[-\/年月]$/.test(before)) continue;
    if (/^[:：]/.test(after)) continue;
    push(m[1]!, 3, m.index, multiplierOf(m[2]));
  }

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => a.priority - b.priority || a.index - b.index || b.value - a.value);
  const best = candidates[0]!;
  if (best.value <= 0 || best.value > 100_000_000) return null;
  return { value: best.value, matched: best.matched };
}

function multiplierOf(token: string | undefined): number {
  switch (token) {
    case '万':
      return 10_000;
    case '千':
      return 1_000;
    case '百':
      return 100;
    default:
      return 1;
  }
}


// ---------------------------------------------------------------------------
// Date
// ---------------------------------------------------------------------------

const RELATIVE_DAYS: { pattern: RegExp; days: number }[] = [
  { pattern: /大前天/, days: -3 },
  { pattern: /前天/, days: -2 },
  { pattern: /(?:昨天|昨日|昨晚|昨天晚上)/, days: -1 },
  { pattern: /(?:今天|今日|今早|今晚|刚刚|刚才)/, days: 0 },
  { pattern: /后天/, days: 2 },
  { pattern: /(?:明天|明日)/, days: 1 },
];

/** "第二天" / "次日" / "隔天" — relative to the *previous* expense, not today. */
const NEXT_IN_CONTEXT = /(?:第二天|次日|隔天|转天|后一天)/;
const SAME_IN_CONTEXT = /(?:同一天|当天|当晚)/;

export function extractDate(
  text: string,
  options: { today: string; contextDate?: string | null },
): AgentDate | null {
  // Absolute dates first: they are unambiguous.
  const iso = /(\d{4})\s*[-/年]\s*(\d{1,2})\s*[-/月]\s*(\d{1,2})\s*日?/.exec(text);
  if (iso) {
    const value = `${iso[1]}-${String(Number(iso[2])).padStart(2, '0')}-${String(
      Number(iso[3]),
    ).padStart(2, '0')}`;
    return { kind: 'absolute', value };
  }

  const monthDay =
    /(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]/.exec(text) ?? /(\d{1,2})\/(\d{1,2})/.exec(text);
  if (monthDay) {
    const month = Number(monthDay[1]);
    const day = Number(monthDay[2]);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      const year = Number(options.today.slice(0, 4));
      let value = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      // A month/day far in the future almost certainly refers to last year.
      if (value > addDays(options.today, 180)) {
        value = `${year - 1}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      }
      return { kind: 'absolute', value };
    }
  }

  for (const entry of RELATIVE_DAYS) {
    if (entry.pattern.test(text)) return { kind: 'relative', days: entry.days };
  }

  const base = options.contextDate ?? options.today;
  if (NEXT_IN_CONTEXT.test(text)) return { kind: 'absolute', value: addDays(base, 1) };
  if (SAME_IN_CONTEXT.test(text)) return { kind: 'absolute', value: base };

  return null;
}

// ---------------------------------------------------------------------------
// Roster mentions
// ---------------------------------------------------------------------------

export interface Mention {
  entry: RosterEntry;
  surface: string;
  start: number;
  end: number;
}

const NAME_PREFIXES = ['小', '老', '阿', '大'];

function nameForms(nickname: string): string[] {
  const base = nickname.trim();
  const forms = new Set<string>();
  if (base.length >= 2) forms.add(base);
  for (const prefix of NAME_PREFIXES) {
    if (base.length > prefix.length && base.startsWith(prefix)) {
      forms.add(base.slice(prefix.length));
    }
  }
  if (base.length >= 3) forms.add(base.slice(-2));
  return [...forms].filter((f) => f.length >= 2 || base.length === 1);
}

/**
 * Find every place the utterance mentions a ledger member.
 *
 * Doing the lookup against the *ledger roster* (rather than trying to detect
 * Chinese names generically) is what keeps this parser honest: it finds both
 * 小王 and 小李 in "小王和小李也要分摊", while leaving role words like 朋友 alone.
 */
export function findMentions(text: string, roster: RosterEntry[]): Mention[] {
  const raw: Mention[] = [];
  for (const entry of roster) {
    for (const form of nameForms(entry.nickname)) {
      let from = 0;
      for (;;) {
        const index = text.indexOf(form, from);
        if (index === -1) break;
        raw.push({ entry, surface: form, start: index, end: index + form.length });
        from = index + 1;
      }
    }
  }

  const kept: Mention[] = [];
  const ordered = [...raw].sort((a, b) => a.start - b.start || b.surface.length - a.surface.length);
  for (const mention of ordered) {
    const collides = kept.some((k) => k.start < mention.end && mention.start < k.end);
    if (collides) continue;
    kept.push(mention);
  }
  return kept.sort((a, b) => a.start - b.start);
}

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

const PAYER_VERBS = '付了|付的|付款|付钱|买单|请客|结账|垫付|支付了|支付|出的|掏的钱|掏钱';

const SPLIT_SIGNAL = /(?:平摊|平分|平均|均摊|均分|AA|A一下|一人一半|对半|各付一半|各承担一半|一半|分摊|分担|承担|参与|算上|大家|所有人|全员|全部人)/;
const ALL_MEMBERS_SIGNAL = /(?:大家|所有人|全员|全部人|我们全部|咱们全部)/;
const INCOME_SIGNAL = /(?:工资|收入|报销|退款|退钱|进账|赚了|奖金|分红|利息|补贴|发工资|收到钱)/;
const REFINE_SIGNAL = /(?:改成|改为|换成|重新|重来|修正|去掉|删掉|删了|不要|不算|不包括|不用|加上|再加|增加|补充)/;
const INHERIT_SIGNAL = /(?:也是|同样|另外一个?|另一笔|再加一?笔|还有一?笔)/;

const LEADING_NOISE = /^(?:然后|接着|还有|另外|再|也|就|那|这|这样|嗯|呃|那个|这个|另外一?笔|还有一?笔)+/;

function stripStopwordPrefix(value: string): string {
  let out = value;
  for (;;) {
    const next = out.replace(LEADING_NOISE, '');
    if (next === out) break;
    out = next;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export function parseWithRules(input: string, options: RuleParserOptions): AgentPatch {
  const text = normalizeUtterance(input);
  const context = options.context ?? null;
  const hasDraft = context?.hasDraft === true;

  if (text === '') return { action: 'unknown' };

  const amount = extractAmount(text);
  const mentions = findMentions(text, options.roster);

  const action = decideAction({ text, amount, hasDraft });

  const patch: AgentPatch = { action };
  const inheriting = action === 'create_expense' && hasDraft && INHERIT_SIGNAL.test(text);

  if (amount) patch.amount = amount.value;
  else if (inheriting && context?.amountCents) patch.amount = context.amountCents / 100;

  if (INCOME_SIGNAL.test(text)) patch.type = 'income';
  else if (amount || /(?:花了|花|付了|买|吃|住|打车|加油|门票|购物)/.test(text)) {
    patch.type = 'expense';
  }

  const date = extractDate(text, { today: options.today, contextDate: context?.date ?? null });
  if (date) patch.date = date;

  // Category: never overwrite a consciously chosen category during a refinement.
  const guessed = guessCategoryFromText(text);
  if (guessed !== 'other') {
    patch.category = guessed;
  } else if (inheriting && context?.categoryKey) {
    patch.category = context.categoryKey;
  } else if (!hasDraft || action === 'create_expense') {
    patch.category = guessed;
  }

  const note = deriveNote(text, mentions, options.roster);
  if (note !== '') patch.note = note;
  else if (inheriting && context?.note) patch.note = context.note;

  const payer = detectPayer(text, mentions, options.roster);
  if (payer) {
    patch.paidBy = payer;
  } else if (inheriting && context?.paidBy) {
    patch.paidBy = { ref: context.paidBy };
  }

  const sharing = detectSharing(text, mentions, options.roster, {
    hasSplitSignal: SPLIT_SIGNAL.test(text),
    payerRef: payer?.ref ?? null,
  });

  if (sharing) patch.sharing = sharing;
  else if (inheriting && context?.participants && context.participants.length > 0) {
    patch.sharing = { participants: context.participants.map((id) => ({ ref: id })) };
  }

  patch.confidence = 0.4 + (amount ? 0.2 : 0) + (patch.date ? 0.1 : 0) + (sharing ? 0.2 : 0);
  patch.assistantMessage = amount
    ? '收到，请确认这笔账。'
    : '我还没听清金额，能再说一次吗？';

  if (!amount && !inheriting && action !== 'update_draft') {
    patch.questions = ['这笔账是多少钱？'];
  }

  return patch;
}

function decideAction(args: {
  text: string;
  amount: AmountExtraction | null;
  hasDraft: boolean;
}): AgentPatch['action'] {
  const { text, amount, hasDraft } = args;
  if (!hasDraft) return 'create_expense';

  const refine = REFINE_SIGNAL.test(text);
  const inherit = INHERIT_SIGNAL.test(text);

  if (refine && !/(?:第二天|次日|隔天)/.test(text)) return 'update_draft';
  if (inherit) return 'create_expense';
  if (amount) return 'create_expense';
  return 'update_draft';
}

// ---------------------------------------------------------------------------
// Payer
// ---------------------------------------------------------------------------

export function detectPayer(
  text: string,
  mentions: Mention[],
  roster: RosterEntry[],
): AgentPersonRef | null {
  const selfRe = new RegExp(
    `(?:我|咱|自己|本人)(?:先|已经|刚刚|提前|来|是|要)*\\s*(?:${PAYER_VERBS})`,
  );
  if (selfRe.test(text)) return { ref: 'me' };

  for (const mention of mentions) {
    const after = text.slice(mention.end, mention.end + 5);
    if (new RegExp(`^(?:先|已经|刚刚|提前|是|来)*\\s*(?:${PAYER_VERBS})`).test(after)) {
      return { ref: mention.surface };
    }
  }

  // A name we don't have on the roster: keep it as a ref so the resolver can
  // surface a "who is this?" question instead of silently ignoring it.
  const genericRe = new RegExp(
    `([\\u4e00-\\u9fa5A-Za-z]{1,4})(?:先|已经|刚刚|提前)?\\s*(?:${PAYER_VERBS})`,
    'g',
  );
  let match: RegExpExecArray | null;
  while ((match = genericRe.exec(text)) !== null) {
    const candidate = stripStopwordPrefix(match[1] ?? '');
    if (candidate === '' || isRoleWord(candidate)) continue;
    if (roster.some((r) => r.userId === candidate)) continue;
    return { ref: candidate };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Sharing
// ---------------------------------------------------------------------------

const COUNT_RE =
  /(?:我们|咱们|咱)?\s*(?:一共|总共|共)?\s*(\d+|[一二两三四五六七八九十]+|俩|仨)\s*(?:个|位)?\s*人/;
const EXCLUDE_AFTER = /^(?:也)?\s*(?:不算|不参与|不用摊|不摊|不用出|不分摊|除外)/;
const INCLUDE_AFTER =
  /^\s*(?:也|都|一起|要|会|得|再)*\s*(?:分摊|分担|平摊|平分|承担|参与|算上|AA)/;
const COMPANION_BEFORE = /[和跟与同、,及]/;

/**
 * `<name>[,和跟与]<name>也要分摊` for people who are *not* on the roster.
 *
 * Roster matching finds members; this finds the people the user named who have
 * not joined yet, so the resolver can ask "who is 小李?" instead of quietly
 * dropping them from the split. The names are captured as a list and split on
 * separators, which is what keeps "小王和小李" from becoming one nonsense name.
 */
const INCLUSION_NAME_RE =
  /([\u4e00-\u9fa5]{1,4}(?:\s*[和跟与及、,]\s*[\u4e00-\u9fa5]{1,4})*)\s*(?:也|都|一起|要|会)*\s*(?:分摊|分担|参与|算上|平摊)/g;

const NAME_CANDIDATE_NOISE =
  /^(?:我们|咱们|咱|大家|所有人|全员|其中|包括|还有|另外|然后|接着|和|跟|与|同|就|也|都|一起|要|得|会|来|去|这|那|我|你)+/;

/** Trailing particles the greedy name match can swallow ("小李也要分摊"). */
const NAME_CANDIDATE_TRAILING = /(?:也|都|一起|要|会|得|来|去|的|了|就|还|和|跟|与|及)+$/;

/** Anything that reads like a count or a quantity rather than a person. */
const NAME_CANDIDATE_REJECT = /[0-9个位人天晚次份张间家台件瓶杯碗顿年月日号周岁层楼场袋盒套条钱块元们]/;

function cleanNameCandidate(value: string): string {
  let out = value.trim();
  for (;;) {
    const next = out.replace(NAME_CANDIDATE_NOISE, '').replace(NAME_CANDIDATE_TRAILING, '');
    if (next === out) break;
    out = next;
  }
  if (out.length < 1 || out.length > 4) return '';
  if (NAME_CANDIDATE_REJECT.test(out)) return '';
  return out;
}

export function detectSharing(
  text: string,
  mentions: Mention[],
  roster: RosterEntry[],
  options: { hasSplitSignal: boolean; payerRef: string | null },
): AgentSharing | null {
  const excludedRefs: AgentPersonRef[] = [];
  const amountEntries: { ref: string; amount: number }[] = [];
  let remainderRef: AgentPersonRef | null = null;
  let includeAllMembers = false;
  let expectedCount: number | null = null;

  const equalSignal =
    /(?:平摊|平分|平均|均摊|均分|AA|A一下|一人一半|对半|各付一半|各承担一半)/.test(text);

  // 1. Exclusions -----------------------------------------------------------
  for (const mention of mentions) {
    const after = text.slice(mention.end, mention.end + 8);
    if (EXCLUDE_AFTER.test(after)) excludedRefs.push({ ref: mention.surface });
  }
  const excludedIds = new Set(
    excludedRefs.map((ref) => roster.find((r) => r.nickname === ref.ref)?.userId ?? ref.ref),
  );

  // 2. Explicit per-person amounts ("小王承担 200") --------------------------
  const amountRe =
    /(我|自己|本人|[\u4e00-\u9fa5A-Za-z]{2,4})\s*(?:来|要|得|需)?\s*(?:承担|分摊|负责|负担)\s*(?:了)?\s*(?:¥|￥)?\s*([0-9]+(?:\.[0-9]+)?)/g;
  let match: RegExpExecArray | null;
  while ((match = amountRe.exec(text)) !== null) {
    const who = stripStopwordPrefix(match[1] ?? '');
    const value = Number(match[2]);
    if (who === '' || !Number.isFinite(value)) continue;
    if (who === '剩下' || who === '其余') continue;
    if (who === '我' || who === '自己' || who === '本人') {
      amountEntries.push({ ref: 'me', amount: value });
    } else {
      amountEntries.push({ ref: who, amount: value });
    }
  }

  // 3. "剩下我自己承担" ------------------------------------------------------
  if (/(?:剩下|其余|其他|余下|剩余的?|多出来的?)[^。]{0,8}?(?:我|自己|本人)/.test(text)) {
    remainderRef = { ref: 'me' };
  }

  // 4. How many people? -----------------------------------------------------
  const countMatch = COUNT_RE.exec(text);
  if (countMatch) {
    const parsed = cnNumber(countMatch[1] ?? '');
    if (parsed !== null && parsed >= 2 && parsed <= 50) expectedCount = parsed;
  }
  if (ALL_MEMBERS_SIGNAL.test(text)) includeAllMembers = true;

  // 5. Participants ---------------------------------------------------------
  const positioned: { ref: string; pos: number }[] = [];

  for (const mention of mentions) {
    if (excludedIds.has(mention.entry.userId)) continue;
    const before = text.slice(Math.max(0, mention.start - 2), mention.start);
    const after = text.slice(mention.end, mention.end + 8);
    const isCompanion = COMPANION_BEFORE.test(before);
    const isIncluded = INCLUDE_AFTER.test(after);
    const isAmountHolder = amountEntries.some(
      (entry) => entry.ref === mention.surface || entry.ref === mention.entry.userId,
    );
    // When the user is talking about a split at all, a member who is named and
    // neither the payer nor excluded is part of it.
    const unclassified = options.hasSplitSignal;

    if (isCompanion || isIncluded || isAmountHolder || unclassified) {
      positioned.push({ ref: mention.surface, pos: mention.start });
    }
  }

  // People the user named who are not on the roster yet ("小李也要分摊").
  INCLUSION_NAME_RE.lastIndex = 0;
  let inclusionMatch: RegExpExecArray | null;
  while ((inclusionMatch = INCLUSION_NAME_RE.exec(text)) !== null) {
    const list = (inclusionMatch[1] ?? '').split(/[和跟与及、,\s]+/).filter(Boolean);
    for (const raw of list) {
      const candidate = cleanNameCandidate(raw);
      if (candidate === '' || isRoleWord(candidate)) continue;
      if (mentions.some((mention) => mention.surface === candidate)) continue;
      if (roster.some((entry) => entry.nickname === candidate)) continue;
      if (positioned.some((entry) => entry.ref === candidate)) continue;
      positioned.push({ ref: candidate, pos: inclusionMatch.index });
    }
  }

  positioned.sort((a, b) => a.pos - b.pos);
  const participantRefs: AgentPersonRef[] = positioned.map((entry) => ({ ref: entry.ref }));

  // 6. Am I part of the split? ---------------------------------------------
  if (options.hasSplitSignal && /(?:我|咱)/.test(text)) {
    if (!participantRefs.some((ref) => ref.ref === 'me')) participantRefs.unshift({ ref: 'me' });
  }

  // 7. "我们三个人" without names -> the whole ledger, validated by the count.
  if (expectedCount !== null && participantRefs.filter((ref) => ref.ref !== 'me').length === 0) {
    includeAllMembers = true;
  }

  const hasAnything =
    participantRefs.length > 0 ||
    excludedRefs.length > 0 ||
    amountEntries.length > 0 ||
    remainderRef !== null ||
    includeAllMembers;

  if (!hasAnything) return null;

  const sharing: AgentSharing = { mode: amountEntries.length > 0 || remainderRef ? 'amounts' : 'equal' };

  if (includeAllMembers) {
    sharing.includeAllMembers = true;
    if (expectedCount !== null) sharing.expectedParticipantCount = expectedCount;
  } else {
    if (participantRefs.length > 0) sharing.participants = participantRefs;
    if (expectedCount !== null && participantRefs.length > 0) {
      sharing.expectedParticipantCount = expectedCount;
    }
  }
  if (excludedRefs.length > 0) sharing.exclude = excludedRefs;
  if (amountEntries.length > 0) sharing.amounts = amountEntries;
  if (remainderRef) sharing.remainderTo = remainderRef;

  return sharing;
}

// ---------------------------------------------------------------------------
// Note
// ---------------------------------------------------------------------------

const NOTE_NOISE_PATTERNS: RegExp[] = [
  /(?:我|我们|咱们|咱|自己|本人)(?:先|已经|刚刚|提前)*(?:一共|总共|共计|合计|总计|共)?(?:花了|花费|花掉|花|消费|用了|付了|付款|支付了|支付|垫付|买单|请客|结账|收了|收到|赚了|进账|报销了|付的|出的)/g,
  /(?:花了|花费|花掉|消费|用了|付出了)/g,
  /(?:一共|总共|共计|合计|总计|大概是?|大约)/g,
  /[¥￥$]?\s*\d+(?:\.\d+)?\s*(?:万|千|百)?\s*(?:块钱|元钱|块|元|人民币|rmb)?/g,
  /[一二两三四五六七八九十]+(?:\s*个)?\s*人/g,
  /(?:昨天|昨日|昨晚|今天|今日|刚刚|刚才|前天|大前天|明天|明日|后天|第二天|次日|隔天|当天|当晚)/g,
  /(?:平摊|平分|平均|均摊|均分|AA|A一下|一人一半|对半|各付一半|各承担一半|一半)/g,
  /(?:剩下|其余|其他的?|余下的?|剩余的?|多出来的?)/g,
  /(?:承担|分摊|分担|负责|参与|不算|不参与|除外|分成|算上|也要|一起|其中|里面|当中|大家|所有人|全员|全部人)/g,
  /(?:也是|同样|另外|再加|还有|接着|然后)/g,
  /(?:我|我们|咱们|咱|自己|本人)/g,
  /[的和跟与同,、]/g,
];

export function deriveNote(text: string, mentions: Mention[], _roster: RosterEntry[]): string {
  let out = text.replace(/[。.,，!！?？]/g, ' ');
  for (const mention of mentions) {
    out = out.split(mention.surface).join(' ');
  }
  for (const pattern of NOTE_NOISE_PATTERNS) {
    out = out.replace(pattern, ' ');
  }
  out = out.replace(/\s+/g, ' ').trim();
  out = out.replace(/^(?:的|个|顿|笔|单|次|份|这|那|就|是)\s*/g, '').trim();
  out = out.replace(/[的和与跟,、\s]+$/g, '').trim();
  return out.slice(0, 60);
}

