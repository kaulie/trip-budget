# 数据模型

金额一律是**整数分**（`amount_cents`），类型（`type`）承载正负号，金额本身永远为正。

## 表

```
users                    身份（当前阶段：设备匿名身份）
  id, nickname, device_id(unique), created_at, updated_at, revision

ledgers                  账本
  id, name, currency, owner_id→users, invite_code(unique),
  created_at, updated_at, deleted_at, revision

ledger_revisions         每个账本的单调递增计数器（增量同步的游标来源）
  ledger_id(unique), revision

ledger_members           成员关系（同时也是权限的来源）
  id, ledger_id→ledgers, user_id→users, role(owner|member),
  joined_at, removed_at, revision
  unique(ledger_id, user_id)

categories               分类（每个账本一份拷贝，因此用户可以改）
  id, ledger_id→ledgers, key, name, icon(SF Symbol), kind(expense|income|both),
  sort_order, is_archived, revision
  unique(ledger_id, key)

expenses                 账目
  id, ledger_id→ledgers, type(expense|income),
  amount_cents(>0), currency, category_id, date(YYYY-MM-DD), note,
  paid_by→users,            ← 谁实际付的钱
  share_mode(equal|weights|amounts),
  source(voice|text|manual|agent), raw_utterance,
  created_by, created_at, updated_at, deleted_at, revision,
  client_mutation_id        ← 幂等键
  index(ledger_id, date), index(ledger_id, revision)
  unique(ledger_id, client_mutation_id) where not null

expense_shares           分摊（谁承担多少）
  id, expense_id→expenses(on delete cascade), ledger_id, user_id,
  amount_cents(>=0)
  unique(expense_id, user_id)
  index(ledger_id, user_id)
```

## 为什么 `paid_by` 和 `expense_shares` 要分成两张表

- 一笔支出**只有一个付款人**，但**可以有多个承担人**：1:N 关系，放同一个字段里表达不了。
- 统计口径不同：`paid_by` 回答「谁垫了钱」，`expense_shares` 回答「这笔消费算谁的」。
  两者相减就是应收应付（`net = paid - share`）。
- 「收入」复用同一套结构：付款人 = 收钱的人，`shares` = 这笔钱实际属于谁，
  于是「A 收到 1000，其中 500 是 B 的」也能算出 B 欠 A 500。

## 不变量（由服务端强制，客户端无法绕过）

1. `amount_cents > 0`，且是整数；
2. `paid_by` 必须属于该账本的**有效成员**；
3. 每个 `expense_shares.user_id` 必须属于该账本的有效成员，且不重复；
4. 每个 `expense_shares.amount_cents >= 0`；
5. **`Σ expense_shares.amount_cents == expenses.amount_cents`**（含一分钱的舍入误差都不允许）；
6. 删除是软删除（`deleted_at`），以便墓碑能同步到其他设备；
7. `client_mutation_id` 在同一账本内唯一，重复上传返回同一条记录。

任何一条不满足都会返回 `422` 和机器可读的规则码，例如：

```json
{
  "error": {
    "code": "unprocessable",
    "message": "business rules violated",
    "details": {
      "violations": [
        {
          "rule": "shares_sum_mismatch",
          "message": "分摊合计与账目总额不一致（合计 40000 分，总额 50000 分，差 10000 分）。",
          "details": { "sumCents": 40000, "amountCents": 50000, "diffCents": 10000 }
        }
      ]
    }
  }
}
```

规则码清单：`amount_invalid`、`amount_not_positive`、`amount_too_large`、`date_out_of_range`、
`payer_missing`、`payer_not_member`、`shares_invalid`、`shares_empty`、`share_user_not_member`、
`share_user_duplicated`、`share_amount_negative`、`shares_sum_mismatch`。

## 派生的东西（不落库）

- **成员应收应付**：`paid_cents - share_cents`；为正表示大家欠他。
- **结算建议**：对 `net` 做贪心配对得到最小转账集（`docs/API.md` 的 `/balances`）。
- **统计**：分类占比、按时段、按成员（支付 / 承担两列）、每日序列。

不落库是有意的：它们都可以由 `paid_by` + `shares` 直接推导，存下来只会带来一致性问题。
未来要支持「已结清」时，再加一张只记录结算动作的表即可。

## 分类

初始 10 个分类（吃饭 / 交通 / 门票娱乐 / 住宿 / 购物 / 日常生活 / 医疗 / 教育 / 工资收入 / 其他）
以数据行的形式写入每个账本，`icon` 直接存 SF Symbol 名，所以客户端渲染的是服务端返回的数据，
不是写死在 UI 里的枚举。新增分类走 `POST /ledgers/:id/categories`。
