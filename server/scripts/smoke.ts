/**
 * End-to-end smoke run against a real HTTP server.
 *
 *   npm run smoke
 *
 * It walks the MVP loop and prints each step, so "does it actually run?" can be
 * answered without the iOS app and without curl.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp, createDeps } from '../src/app.js';

const now = new Date();
const TODAY = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(
  now.getDate(),
).padStart(2, '0')}`;

const dir = mkdtempSync(join(tmpdir(), 'trip-budget-smoke-'));
const deps = createDeps({ dbPath: join(dir, 'smoke.sqlite') });
const { server } = createApp(deps);
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
const base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;

let failures = 0;

function step(title: string) {
  console.log(`\n\x1b[1m${title}\x1b[0m`);
}

function ok(label: string, value?: unknown) {
  console.log(`  \x1b[32m✓\x1b[0m ${label}${value === undefined ? '' : `  ${JSON.stringify(value)}`}`);
}

function check(label: string, condition: boolean, detail?: unknown) {
  if (condition) {
    ok(label);
  } else {
    failures += 1;
    console.log(`  \x1b[31m✗ ${label}\x1b[0m ${detail === undefined ? '' : JSON.stringify(detail)}`);
  }
}

interface ApiError extends Error {
  status: number;
  body: unknown;
}

async function call<T = any>(
  method: string,
  path: string,
  options: { token?: string; body?: unknown } = {},
): Promise<T> {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      'x-client-date': TODAY,
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  const parsed = text === '' ? undefined : JSON.parse(text);
  if (!response.ok) {
    const error = new Error(`HTTP ${response.status}`) as ApiError;
    error.status = response.status;
    error.body = parsed;
    throw error;
  }
  return parsed as T;
}

const money = (cents: number) => `¥${(cents / 100).toFixed(2)}`;

try {
  step('1. 两台设备各自匿名进入（无需注册）');
  const me = await call<{ token: string; user: { id: string; nickname: string } }>(
    'POST',
    '/auth/anonymous',
    { body: { deviceId: 'smoke-device-1', nickname: '我' } },
  );
  const wang = await call<{ token: string }>('POST', '/auth/anonymous', {
    body: { deviceId: 'smoke-device-2', nickname: '小王' },
  });
  const li = await call<{ token: string }>('POST', '/auth/anonymous', {
    body: { deviceId: 'smoke-device-3', nickname: '小李' },
  });
  ok('设备 A', me.user.nickname);
  ok('设备 B', '小王');

  step('2. 创建账本并生成邀请码');
  const created = await call<{ ledger: { id: string; inviteCode: string } }>('POST', '/ledgers', {
    token: me.token,
    body: { name: '日本旅行' },
  });
  const ledgerId = created.ledger.id;
  ok('账本', '日本旅行');
  ok('邀请码', created.ledger.inviteCode);

  step('3. 另一台设备用邀请码加入');
  await call('POST', '/ledgers/join', {
    token: wang.token,
    body: { inviteCode: created.ledger.inviteCode },
  });
  await call('POST', '/ledgers/join', {
    token: li.token,
    body: { inviteCode: created.ledger.inviteCode },
  });
  const detail = await call<{ members: { nickname: string }[] }>('GET', `/ledgers/${ledgerId}`, {
    token: wang.token,
  });
  ok('成员', detail.members.map((m) => m.nickname));

  step('4. 语音记账：说一句话');
  const utterance = '我付了 500，我们三个人吃饭，其中小王和小李也要分摊。';
  console.log(`  用户说：「${utterance}」`);
  const interpreted = await call<any>('POST', `/ledgers/${ledgerId}/agent/interpret`, {
    token: me.token,
    body: { text: utterance, source: 'voice' },
  });
  check('Agent 理解成功', interpreted.ready === true, interpreted.questions);
  ok('解析器', interpreted.parser === 'rule' ? '规则解析（离线可用）' : 'LLM');

  step('5. 展示确认界面');
  const preview = interpreted.preview;
  console.log(`  吃饭 · ${money(preview.amountCents)}   ${preview.date}`);
  console.log(`  付款人：${preview.paidBy.nickname}`);
  console.log('  费用分摊：');
  for (const share of preview.shares) {
    console.log(`    ${share.nickname.padEnd(4, ' ')} ${money(share.amountCents)}`);
  }
  const sum = preview.shares.reduce((a: number, s: any) => a + s.amountCents, 0);
  check('分摊合计严格等于总额', sum === preview.amountCents, { sum, total: preview.amountCents });
  check(
    '舍入正确（166.67 / 166.67 / 166.66）',
    sum === 50000 && preview.shares[2].amountCents === 16666,
  );

  step('6. 用户确认 → 保存');
  const saved = await call<any>('POST', `/ledgers/${ledgerId}/expenses`, {
    token: me.token,
    body: { expense: interpreted.expense, clientMutationId: 'smoke-1' },
  });
  ok('已保存账目', saved.expense.id.slice(0, 8));
  const duplicate = await call<any>('POST', `/ledgers/${ledgerId}/expenses`, {
    token: me.token,
    body: { expense: interpreted.expense, clientMutationId: 'smoke-1' },
  });
  check('重复上传不会重复记账', duplicate.expense.id === saved.expense.id);

  step('7. 另一台设备同步看到');
  const sync = await call<any>('GET', `/ledgers/${ledgerId}/sync?since=0`, { token: wang.token });
  check('设备 B 拉取到该账目', sync.expenses.some((e: any) => e.id === saved.expense.id));
  ok('同步游标', sync.cursor);

  step('8. 自然语言修改待确认的账目');
  const draft = await call<any>('POST', `/ledgers/${ledgerId}/agent/interpret`, {
    token: me.token,
    body: { text: '我付了 300，我们三个人平摊。', source: 'text' },
  });
  const refined = await call<any>('POST', `/ledgers/${ledgerId}/agent/interpret`, {
    token: me.token,
    body: { text: '小李不算，改成我和小王平摊。', source: 'text', pendingDraft: draft.draft },
  });
  check('识别为「修改」而不是新账目', refined.action === 'update_draft', refined.action);
  check('总额保持不变', refined.preview?.amountCents === 30000, refined.preview?.amountCents);
  check(
    '分摊改为 ¥150 / ¥150',
    refined.preview?.shares.length === 2 &&
      refined.preview.shares.every((s: any) => s.amountCents === 15000),
    refined.preview?.shares,
  );

  step('9. 统计：区分「谁付钱」与「谁承担」');
  const stats = await call<any>('GET', `/ledgers/${ledgerId}/stats?range=all`, { token: me.token });
  ok('总支出', money(stats.stats.totalExpenseCents));
  for (const category of stats.stats.byCategory) {
    console.log(
      `    ${category.name}  ${money(category.amountCents)}  ${(category.ratio * 100).toFixed(1)}%`,
    );
  }
  for (const member of stats.stats.byMember) {
    console.log(
      `    ${member.nickname.padEnd(4, ' ')} 实际支付 ${money(member.paidCents).padStart(10)} / 实际承担 ${money(
        member.shareCents,
      ).padStart(10)}`,
    );
  }
  const byName = Object.fromEntries(stats.stats.byMember.map((m: any) => [m.nickname, m]));
  check(
    '我支付 ¥500 但只承担 ¥166.67',
    byName['我'].paidCents === 50000 && byName['我'].shareCents === 16667,
  );
  check('小王没付钱但承担 ¥166.67', byName['小王'].paidCents === 0 && byName['小王'].shareCents === 16667);

  step('10. 结算建议（第一阶段只展示，不强制）');
  const balances = await call<any>('GET', `/ledgers/${ledgerId}/balances?range=all`, {
    token: me.token,
  });
  for (const edge of balances.balances.settlements) {
    const from = stats.stats.byMember.find((m: any) => m.userId === edge.fromUserId)?.nickname;
    const to = stats.stats.byMember.find((m: any) => m.userId === edge.toUserId)?.nickname;
    console.log(`    ${from} → ${to}  ${money(edge.amountCents)}`);
  }
  check('存在应收应付关系', balances.balances.settlements.length > 0);

  step('11. 业务规则拦截不合法的分摊');
  let rejected = false;
  try {
    await call('POST', `/ledgers/${ledgerId}/expenses`, {
      token: me.token,
      body: {
        expense: {
          type: 'expense',
          amountCents: 50000,
          categoryKey: 'food',
          date: TODAY,
          paidBy: me.user.id,
          shares: [{ userId: me.user.id, amountCents: 30000 }],
        },
      },
    });
  } catch (error) {
    rejected = (error as ApiError).status === 422;
  }
  check('服务端拒绝“分摊合计 ≠ 总额”的账目（422）', rejected);
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

console.log(
  failures === 0
    ? '\n\x1b[32m全部通过 —— MVP 闭环可用\x1b[0m\n'
    : `\n\x1b[31m${failures} 项失败\x1b[0m\n`,
);
process.exit(failures === 0 ? 0 : 1);
