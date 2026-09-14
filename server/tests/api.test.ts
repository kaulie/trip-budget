import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { createApp, createDeps } from '../src/app.js';

/**
 * End-to-end over real HTTP against a real (in-memory) database.
 *
 * This is the MVP loop from the product spec:
 *   创建账本 → 生成邀请码 → 另一台设备加入 → 语音记账 → 确认保存 → 另一台设备同步 → 统计正确
 */

const TODAY = '2026-09-14';

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const deps = createDeps({ dbPath: ':memory:' });
  const app = createApp(deps);
  server = app.server;
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (typeof address === 'object' && address) baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

interface ApiResponse<T = any> {
  status: number;
  body: T;
}

async function api<T = any>(
  method: string,
  path: string,
  options: { token?: string; body?: unknown } = {},
): Promise<ApiResponse<T>> {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      'x-client-date': TODAY,
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  return { status: response.status, body: text === '' ? undefined : JSON.parse(text) };
}

async function signUp(deviceId: string, nickname: string) {
  const response = await api<{ token: string; user: { id: string } }>('POST', '/auth/anonymous', {
    body: { deviceId, nickname },
  });
  expect(response.status).toBeLessThan(300);
  return response.body;
}

describe('MVP core loop over HTTP', () => {
  let ownerToken = '';
  let partnerToken = '';
  let ownerId = '';
  let partnerId = '';
  let ledgerId = '';
  let inviteCode = '';

  it('creates an anonymous identity without any signup', async () => {
    const owner = await signUp('device-owner', '我');
    const partner = await signUp('device-partner', '小王');
    ownerToken = owner.token;
    partnerToken = partner.token;
    ownerId = owner.user.id;
    partnerId = partner.user.id;
    expect(ownerToken).not.toBe(partnerToken);

    // The same device is the same identity on the next launch.
    const again = await signUp('device-owner', '我');
    expect(again.token).toBe(ownerToken);
    expect(again.user.id).toBe(ownerId);
  });

  it('creates a ledger and generates a shareable invite code', async () => {
    const created = await api<{ ledger: any }>('POST', '/ledgers', {
      token: ownerToken,
      body: { name: '日本旅行' },
    });
    expect(created.status).toBe(201);
    ledgerId = created.body.ledger.id;
    inviteCode = created.body.ledger.inviteCode;
    expect(inviteCode).toMatch(/^[A-Z0-9]{2,6}-[A-Z0-9]{5}$/);
    expect(created.body.ledger.ownerId).toBe(ownerId);

    const second = await api<{ ledger: any }>('POST', '/ledgers', {
      token: ownerToken,
      body: { name: '家庭账本' },
    });
    expect(second.body.ledger.inviteCode).not.toBe(inviteCode);
  });

  it('rejects a bad invite code and lets the second device join with a good one', async () => {
    const bad = await api('POST', '/ledgers/join', {
      token: partnerToken,
      body: { inviteCode: 'NOPE-00000' },
    });
    expect(bad.status).toBe(404);

    const joined = await api<{ ledger: any }>('POST', '/ledgers/join', {
      token: partnerToken,
      body: { inviteCode: inviteCode.toLowerCase() },
    });
    expect(joined.status).toBe(200);
    expect(joined.body.ledger.id).toBe(ledgerId);

    const detail = await api<{ members: any[] }>('GET', `/ledgers/${ledgerId}`, {
      token: partnerToken,
    });
    expect(detail.body.members.map((m: any) => m.nickname).sort()).toEqual(['小王', '我']);
  });

  it('asks instead of guessing when a name says 小李 but 小李 has not joined', async () => {
    const interpreted = await api<any>('POST', `/ledgers/${ledgerId}/agent/interpret`, {
      token: ownerToken,
      body: { text: '我付了 500，我们三个人吃饭，其中小王和小李也要分摊。', source: 'voice' },
    });
    expect(interpreted.body.ready).toBe(false);
    expect(interpreted.body.questions.join(' ')).toContain('小李');

    // 小李 joins on another device, then the exact same sentence works.
    const liToken = (await signUp('device-li', '小李')).token;
    const joined = await api('POST', '/ledgers/join', { token: liToken, body: { inviteCode } });
    expect(joined.status).toBe(200);
  });

  it('produces a confirmable draft with exact rounding for ¥500 / 3 people', async () => {
    const interpreted = await api<any>('POST', `/ledgers/${ledgerId}/agent/interpret`, {
      token: ownerToken,
      body: { text: '我付了 500，我们三个人吃饭，其中小王和小李也要分摊。', source: 'voice' },
    });

    expect(interpreted.body.ready).toBe(true);
    expect(interpreted.body.parser).toBe('rule');
    const preview = interpreted.body.preview;
    expect(preview.amountCents).toBe(50000);
    expect(preview.categoryName).toBe('吃饭');
    expect(preview.date).toBe(TODAY);
    expect(preview.paidBy.nickname).toBe('我');

    const shares = preview.shares as { nickname: string; amountCents: number }[];
    expect(shares.map((s) => [s.nickname, s.amountCents])).toEqual([
      ['我', 16667],
      ['小王', 16667],
      ['小李', 16666],
    ]);
    expect(shares.reduce((a, s) => a + s.amountCents, 0)).toBe(50000);

    // Save exactly what the user confirmed.
    const saved = await api<any>('POST', `/ledgers/${ledgerId}/expenses`, {
      token: ownerToken,
      body: { expense: interpreted.body.expense, clientMutationId: 'voice-0001' },
    });
    expect(saved.status).toBe(201);
    expect(saved.body.expense.amountCents).toBe(50000);
    expect(saved.body.expense.shares).toHaveLength(3);
    expect(saved.body.expense.paidBy).toBe(ownerId);
  });

  it('is idempotent when the same capture is uploaded twice', async () => {
    const payload = {
      clientMutationId: 'retry-once',
      expense: {
        type: 'expense',
        amountCents: 12800,
        categoryKey: 'food',
        date: TODAY,
        note: '晚饭',
        paidBy: ownerId,
        shares: [{ userId: ownerId, amountCents: 12800 }],
      },
    };
    const first = await api<any>('POST', `/ledgers/${ledgerId}/expenses`, {
      token: ownerToken,
      body: payload,
    });
    const second = await api<any>('POST', `/ledgers/${ledgerId}/expenses`, {
      token: ownerToken,
      body: payload,
    });
    expect(second.body.expense.id).toBe(first.body.expense.id);
  });

  it('refuses to save a split that does not add up', async () => {
    const response = await api<any>('POST', `/ledgers/${ledgerId}/expenses`, {
      token: ownerToken,
      body: {
        expense: {
          type: 'expense',
          amountCents: 50000,
          categoryKey: 'food',
          date: TODAY,
          paidBy: ownerId,
          shares: [
            { userId: ownerId, amountCents: 20000 },
            { userId: partnerId, amountCents: 20000 },
          ],
        },
      },
    });
    expect(response.status).toBe(422);
    expect(response.body.error.details.violations[0].rule).toBe('shares_sum_mismatch');
  });

  it('refuses a payer who is not in the ledger', async () => {
    const outsider = await signUp('device-outsider', '路人');
    const response = await api<any>('POST', `/ledgers/${ledgerId}/expenses`, {
      token: ownerToken,
      body: {
        expense: {
          type: 'expense',
          amountCents: 1000,
          categoryKey: 'food',
          date: TODAY,
          paidBy: outsider.user.id,
          shares: [{ userId: outsider.user.id, amountCents: 1000 }],
        },
      },
    });
    expect(response.status).toBe(422);
    expect(response.body.error.details.violations[0].rule).toBe('payer_not_member');
  });

  it('syncs the new expenses to the other device', async () => {
    const sync = await api<any>('GET', `/ledgers/${ledgerId}/sync?since=0`, { token: partnerToken });
    expect(sync.status).toBe(200);
    expect(sync.body.expenses.length).toBeGreaterThanOrEqual(2);
    expect(sync.body.cursor).toBeGreaterThan(0);

    // Pulling again from the new cursor returns nothing new.
    const again = await api<any>('GET', `/ledgers/${ledgerId}/sync?since=${sync.body.cursor}`, {
      token: partnerToken,
    });
    expect(again.body.expenses).toHaveLength(0);

    // A fresh device sees the whole ledger through the invite code.
    const thirdToken = (await signUp('device-third', '小张')).token;
    await api('POST', '/ledgers/join', { token: thirdToken, body: { inviteCode } });
    const thirdSync = await api<any>('GET', `/ledgers/${ledgerId}/sync?since=0`, {
      token: thirdToken,
    });
    expect(thirdSync.body.expenses.length).toBeGreaterThanOrEqual(2);
    // 我 / 小王 / 小李 / 小张 have all joined by now.
    expect(thirdSync.body.members).toHaveLength(4);
  });

  it('reports paid vs borne per member as two different numbers', async () => {
    const balances = await api<any>('GET', `/ledgers/${ledgerId}/balances?range=all`, {
      token: ownerToken,
    });
    const byName = Object.fromEntries(
      (balances.body.balances.members as any[]).map((m) => [m.nickname, m]),
    );

    // The owner paid ¥500 + ¥128 = ¥628 but only bears ¥166.67 + ¥128.
    expect(byName['我'].paidCents).toBe(50000 + 12800);
    expect(byName['我'].shareCents).toBe(16667 + 12800);
    expect(byName['我'].netCents).toBe(byName['我'].paidCents - byName['我'].shareCents);

    // 小王 paid nothing but bears a share — the whole point of the split model.
    expect(byName['小王'].paidCents).toBe(0);
    expect(byName['小王'].shareCents).toBe(16667);

    // The suggested transfers settle the ledger exactly.
    const members = balances.body.balances.members as any[];
    const owed = members.filter((m) => m.netCents > 0).reduce((a, m) => a + m.netCents, 0);
    const transfers = balances.body.balances.settlements as any[];
    expect(transfers.reduce((a, t) => a + t.amountCents, 0)).toBe(owed);
  });

  it('computes statistics by category, member and day', async () => {
    const stats = await api<any>('GET', `/ledgers/${ledgerId}/stats?range=all`, {
      token: ownerToken,
    });
    const s = stats.body.stats;
    expect(s.totalExpenseCents).toBe(50000 + 12800);
    expect(s.expenseCount).toBe(2);

    const food = s.byCategory.find((c: any) => c.categoryKey === 'food');
    expect(food.amountCents).toBe(62800);
    expect(food.ratio).toBeCloseTo(1);
    expect(s.daily.find((d: any) => d.date === TODAY).expenseCents).toBe(62800);
  });

  it('lets a member edit and delete, and propagates both through sync', async () => {
    const list = await api<any>('GET', `/ledgers/${ledgerId}/expenses`, { token: partnerToken });
    const target = list.body.expenses.find((e: any) => e.note === '晚饭');
    expect(target).toBeTruthy();

    const edited = await api<any>('PATCH', `/ledgers/${ledgerId}/expenses/${target.id}`, {
      token: partnerToken,
      body: {
        expectedRevision: target.revision,
        expense: {
          type: 'expense',
          amountCents: 20000,
          categoryKey: 'food',
          date: TODAY,
          note: '晚饭（改成 200）',
          paidBy: ownerId,
          shares: [
            { userId: ownerId, amountCents: 10000 },
            { userId: partnerId, amountCents: 10000 },
          ],
        },
      },
    });
    expect(edited.status).toBe(200);
    expect(edited.body.expense.shares).toHaveLength(2);

    // A stale edit is rejected instead of silently clobbering the new version.
    const stale = await api<any>('PATCH', `/ledgers/${ledgerId}/expenses/${target.id}`, {
      token: ownerToken,
      body: {
        expectedRevision: target.revision,
        expense: {
          type: 'expense',
          amountCents: 10000,
          categoryKey: 'food',
          date: TODAY,
          paidBy: ownerId,
          shares: [{ userId: ownerId, amountCents: 10000 }],
        },
      },
    });
    expect(stale.status).toBe(409);

    const ownerSync = await api<any>('GET', `/ledgers/${ledgerId}/sync?since=0`, {
      token: ownerToken,
    });
    const synced = ownerSync.body.expenses.find((e: any) => e.id === target.id);
    expect(synced.amountCents).toBe(20000);
    expect(synced.shares).toHaveLength(2);

    const deleted = await api<any>('DELETE', `/ledgers/${ledgerId}/expenses/${target.id}`, {
      token: partnerToken,
    });
    expect(deleted.status).toBe(200);

    // The tombstone still travels, so other devices drop it instead of keeping it.
    const afterDelete = await api<any>('GET', `/ledgers/${ledgerId}/sync?since=0`, {
      token: ownerToken,
    });
    const tombstone = afterDelete.body.expenses.find((e: any) => e.id === target.id);
    expect(tombstone.deletedAt).not.toBeNull();

    const visible = await api<any>('GET', `/ledgers/${ledgerId}/expenses`, { token: ownerToken });
    expect(visible.body.expenses.some((e: any) => e.id === target.id)).toBe(false);
  });

  it('keeps an outsider out of the ledger', async () => {
    const outsiderToken = (await signUp('device-outsider', '路人')).token;
    expect((await api('GET', `/ledgers/${ledgerId}`, { token: outsiderToken })).status).toBe(403);
    const write = await api('POST', `/ledgers/${ledgerId}/expenses`, {
      token: outsiderToken,
      body: { expense: { type: 'expense', amountCents: 1, paidBy: ownerId, shares: [] } },
    });
    expect(write.status).toBe(403);
  });

  it('requires authentication', async () => {
    expect((await api('GET', '/ledgers')).status).toBe(401);
    expect((await api('GET', '/health')).status).toBe(200);
  });
});
