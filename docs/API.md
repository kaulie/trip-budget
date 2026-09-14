# API

Base URL：`http://127.0.0.1:4000`（可用 `PORT` / `HOST` 覆盖）
鉴权：`Authorization: Bearer <token>`；`token` 来自匿名登录，就是 `user.id`。
日期：所有涉及「今天」的接口都会读 `x-client-date: YYYY-MM-DD`（客户端本地日期）作为兜底。

## 身份

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/auth/anonymous` | `{ deviceId, nickname? }` → `{ token, user, created }`。同一 `deviceId` 重复调用返回同一身份。 |
| GET | `/me` | `{ user, ledgers }` |
| PATCH | `/me` | `{ nickname }`（会同步到各账本的成员显示名） |
| GET | `/health` | `{ ok, service, llm }`，不需要鉴权 |

## 账本与成员

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/ledgers` | 我参与的所有账本 |
| POST | `/ledgers` | `{ name, currency? }` → 账本 + 邀请码 + 默认分类 + `shareText` |
| POST | `/ledgers/join` | `{ inviteCode }`（大小写不敏感）→ 加入后的账本 |
| GET | `/ledgers/:ledgerId` | 账本 + 成员 + 分类 + 当前 revision + 账目数 |
| PATCH | `/ledgers/:ledgerId` | `{ name?, currency? }` |
| POST | `/ledgers/:ledgerId/invite-code/rotate` | 生成新邀请码（旧码立即失效） |
| GET | `/ledgers/:ledgerId/members` | 成员列表 |
| DELETE | `/ledgers/:ledgerId/members/:userId` | 自己退出随意；移除他人需为创建者；创建者不可被移除 |

## 分类

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/ledgers/:ledgerId/categories` | 分类（含 SF Symbol 图标名） |
| POST | `/ledgers/:ledgerId/categories` | `{ key?, name, icon?, kind? }` |

## 账目

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/ledgers/:ledgerId/expenses` | `?from&to&category&user&type&limit&offset` → `{ expenses, total, currency }` |
| POST | `/ledgers/:ledgerId/expenses/preview` | 只校验不保存 → `{ valid, violations }` 或 `{ valid, warnings, expense }` |
| POST | `/ledgers/:ledgerId/expenses` | 创建；`{ expense, clientMutationId? }`，幂等 |
| GET | `/ledgers/:ledgerId/expenses/:expenseId` | 单条 |
| PATCH | `/ledgers/:ledgerId/expenses/:expenseId` | 全量更新；`expectedRevision` 用于乐观并发 |
| DELETE | `/ledgers/:ledgerId/expenses/:expenseId` | 软删除（墓碑会同步到其他设备） |

写入体（`paidBy` 与 `shares` 是**两个**概念）：

```json
{
  "clientMutationId": "9f0c…",
  "expense": {
    "type": "expense",
    "amountCents": 50000,
    "currency": "CNY",
    "categoryKey": "food",
    "date": "2026-09-14",
    "note": "吃饭",
    "paidBy": "<user-id-我>",
    "shareMode": "equal",
    "shares": [
      { "userId": "<我>",   "amountCents": 16667 },
      { "userId": "<小王>", "amountCents": 16667 },
      { "userId": "<小李>", "amountCents": 16666 }
    ],
    "source": "voice",
    "rawUtterance": "我付了 500，我们三个人吃饭，其中小王和小李也要分摊"
  }
}
```

## 统计与结算

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/ledgers/:ledgerId/stats` | `?range=today|week|month|year|all&from&to` → 总支出/总收入、按分类、按成员（支付 / 承担）、按日序列 |
| GET | `/ledgers/:ledgerId/balances` | `?range=` → 每个成员的 `paidCents / shareCents / netCents` + 最小转账集 `settlements` |

`byMember` 里 `paidCents` 与 `shareCents` 是**两列不同的数字**，这是本产品的核心口径。

## Agent

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/ledgers/:ledgerId/agent/interpret` | `{ text, source, pendingDraft?, today? }` → 见下 |

返回：

```json
{
  "action": "create_expense",
  "parser": "rule",            // 或 "llm"
  "ready": true,               // 通过全部业务规则，可直接保存
  "draft":  { "...": "可回传作为下次修改的上下文" },
  "preview": {
    "amountCents": 50000,
    "categoryName": "吃饭",
    "categoryIcon": "fork.knife",
    "paidBy": { "userId": "...", "nickname": "我" },
    "shares": [
      { "userId": "...", "nickname": "我",   "amountCents": 16667 },
      { "userId": "...", "nickname": "小王", "amountCents": 16667 },
      { "userId": "...", "nickname": "小李", "amountCents": 16666 }
    ]
  },
  "expense": { "...": "校验通过的保存载荷，直接 POST /expenses 即可" },
  "questions": [],
  "violations": [],
  "warnings": [],
  "assistantMessage": "好的，支出 ¥500.00，请确认。",
  "notes": []
}
```

`ready = false` 时 `preview` 与 `expense` 为 `null`，`questions` 里是给用户的追问
（例如「账本里找不到成员‘小李’，请问分摊人具体是谁？」）。

## 同步

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/ledgers/:ledgerId/sync` | `?since=<cursor>&limit=` → 游标之后变化的账本/成员/分类/账目 + 新 `cursor` + `hasMore` |

客户端保存游标，按 `revision` 做后写覆盖；`deletedAt` 非空的记录是墓碑，用来移除本地副本。

## 错误格式

```json
{ "error": { "code": "unprocessable", "message": "…", "details": { "violations": [ … ] } } }
```

状态码：`400` 参数错误 / `401` 未认证 / `403` 非成员 / `404` 不存在 /
`409` 版本冲突（`expectedRevision` 不匹配）/ `422` 业务规则不通过。
