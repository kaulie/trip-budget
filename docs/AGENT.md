# Agent 契约

App 内的记账 Agent 只做一件事：**把自然语言变成结构化的记账操作**。
它不碰数据库、不做权限判断、不决定金额是否合法。

## 三层职责

| 层 | 文件 | 能不能出错 | 说明 |
| --- | --- | --- | --- |
| 理解（可替换） | `agent/ruleParser.ts`、`agent/llmParser.ts` | 可以 | 都只输出同一份 `AgentPatch` |
| 消解 + 物化（业务） | `agent/resolve.ts` | 不可以猜 | 人名 → user_id；平均/权重 → 具体分 |
| 校验（业务） | `domain/validation.ts` | 权威 | 成员归属、非负、Σshares == total |

## AgentPatch（Agent 唯一被允许输出的格式）

```ts
{
  action: 'create_expense' | 'update_draft' | 'ask',
  type?: 'expense' | 'income',
  amount?: number | null,            // 单位是「元」，不是分
  category?: string | null,          // 分类 key / 名称 / 自由词
  date?: { kind: 'absolute', value: '2026-09-14' }
        | { kind: 'relative', days: -1 }
        | { kind: 'preset', value: 'today' | 'yesterday' | 'tomorrow' },
  note?: string | null,
  paid_by?: { ref: 'me' | '小王' | '<userId>' } | null,
  sharing?: {
    mode?: 'equal' | 'weights' | 'amounts',
    participants?: [{ ref: string }],        // 承担人（替换语义）
    exclude?: [{ ref: string }],             // 「小李不算」
    includeAllMembers?: boolean,             // 「大家平摊」
    expectedParticipantCount?: number,       // 「我们四个人」→ 4
    weights?: [{ ref: string, weight: number }],
    amounts?: [{ ref: string, amount: number }],   // 「小王承担 200」
    remainderTo?: { ref: string }            // 「剩下我自己承担」
  },
  questions?: string[],
  assistantMessage?: string
}
```

关键点：

- **人名是引用，不是 ID。** 由业务层用账本花名册解析。
- **金额是元，不是分。** 换算发生在业务层，避免模型自己除 100。
- **`paid_by` 通常不是承担人。** 「我付了 300，我们三个人平摊」里
  `paid_by = me`，而 `participants = [我, 小王, 小李]`。
- **`action`**：描述新账目用 `create_expense`；修改正在确认的那笔用 `update_draft`。

## 消解规则（`resolve.ts`）

**人名匹配**是分层的，只在唯一命中时才接受：

1. 精确 user id
2. 昵称完全一致
3. 互相包含（「小王」↔「王小明的」）
4. 去掉常见前缀后比较（「小王」↔「王小明」）

同一层命中多个 → **不猜**，返回「匹配到多位成员（小王、王小明），请问是哪一位？」。
完全找不到 → 「账本里找不到成员‘小李’，请问分摊人具体是谁？」。
「朋友」「同事」「大家」这类**角色词**不算人名，不会触发提问。

**人数校验**：用户说「我们四个人」时，如果账本不是 4 个人（或已识别的成员数不等于 4），
返回提问而不是自行挑选成员。

**金额物化**：
- `equal` → 最大余额法平均分配（多出的分给靠前的人）
- `weights` → 按权重分配
- `amounts` → 用户给的金额原样使用；缺金额的人平分剩余部分（「剩下我自己承担」就是这条路径）

## 上下文与追问

- `update_draft` 会以「用户当前正在确认的草稿」为基础做增量修改，
  所以「小李不算，改成我和小王平摊」不需要重新描述金额和分类。
- 客户端把当前草稿（包括用户手动改过的内容）回传给服务端作为上下文。
- 「第二天也是 800」被识别为**新账目**，并继承上一笔的分类、备注、付款人、承担人，
  日期取上一笔日期的次日。

## 示例（这些都有对应测试）

| 用户说 | 结果 |
| --- | --- |
| 昨天晚上和朋友吃饭花了 128 | 支出 128，吃饭，昨天，付款人我，我自己承担（「朋友」不是身份，不猜） |
| 这顿饭我付的，一共 300，我们三个人平摊 | 付款人我，¥100 / ¥100 / ¥100（账本正好 3 人） |
| 我付了 500，小王承担 200，剩下我自己承担 | 付款人我，我 ¥300，小王 ¥200 |
| 这 600 块我付的，我和小王一人一半，小李不算 | 付款人我，我 ¥300，小王 ¥300，小李不参与 |
| 酒店 1200 我先付了，我们四个人平摊 | 住宿 ¥1200，四人各 ¥300 |
| 我付了 500，我们三个人吃饭，其中小王和小李也要分摊 | 付款人我，¥166.67 / ¥166.67 / ¥166.66 |
| 小李不算，改成我和小王平摊 | 修改当前草稿：总额不变，分摊改为两人平分 |

## LLM 路径

- 单次 `chat/completions` 调用，`temperature: 0`，`response_format: json_object`，带硬超时。
- 输出经过 `normalizeAgentPatch()` 的防御式归一化：不认识的字段直接丢弃，绝不猜。
- **数字兜底**：模型没给出金额/日期时，用规则解析器的结果补齐
  （`mergePatches`），方向是单向的——模型负责措辞，规则负责数字。
- 任何失败（超时、非 200、非法 JSON、超时）都会静默回退到规则解析器，
  所以模型不可用只会降低理解质量，不会让 App 无法记账。
- `LLM_E2E=1 npx vitest run tests/llm.e2e.test.ts` 会用真实模型跑同一批验收句式，
  断言与规则解析器产出的业务结果一致。

## 安全约束（提示注入的兜底）

模型输出只被当作**数据**：金额要过 `toCents` + 范围校验，人名要过花名册，
分摊要过求和校验，无效输出会被反馈给用户（甚至让模型自我修正一轮），
最终保存路径不依赖模型的任何判断。
