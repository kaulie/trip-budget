# 架构

## 全局视图

```
┌──────────────────────────────────────────────────────────────┐
│ iOS App (SwiftUI, iOS 17+)                                   │
│                                                              │
│  Features/        视图层，只依赖 AppModel                      │
│  AppModel         @Observable，唯一持有网络/本地缓存/离线队列    │
│  APIClient        actor，唯一发 HTTP 的地方                    │
│  LocalStore       本地 JSON 快照 + 离线写入队列（outbox）       │
│  SpeechCapture    SFSpeechRecognizer + AVAudioEngine          │
│  Money / ShareAllocator   金额与分摊（与服务端规则一致）        │
└───────────────────────────┬──────────────────────────────────┘
                            │ REST + JSON（增量同步用游标）
┌───────────────────────────▼──────────────────────────────────┐
│ server/src/http        20 个端点，手写路由（无框架）            │
│   只做：解析输入 → 调 domain → 返回结果                        │
├──────────────────────────────────────────────────────────────┤
│ server/src/agent       「理解」层，可替换                       │
│   ruleParser（离线） / llmParser（DeepSeek）→ 同一个 AgentPatch │
│   resolve  指代消解：把「小王」解析成账本成员，歧义就提问         │
│   interpret 编排：patch → draft → shares → 校验                │
├──────────────────────────────────────────────────────────────┤
│ server/src/domain      「业务规则」层，确定性、可脱离数据库测试    │
│   money / validation / analytics / categories                 │
├──────────────────────────────────────────────────────────────┤
│ server/src/store       SQLite（node:sqlite，无原生依赖）        │
└──────────────────────────────────────────────────────────────┘
```

## 客户端 / 后端 / 数据库的边界

**客户端负责**：交互、把用户确认过的内容提交、离线缓存与重放、本地展示用的分摊预览。

**客户端不负责**：决定一笔账是否合法。App 里的 `ShareAllocator` 只是为了让确认界面
能实时显示每个人的金额（这是个*提案*），保存前服务端会用同一套规则重新计算并校验。
即使客户端算错，也只会被 422 拒绝，不会写进数据库。

**后端负责**：成员与权限、金额不变量、幂等与并发、增量同步、统计口径、
自然语言理解的落地点（指代消解与校验都在这里）。

**数据库负责**：持久化与事务。所有涉及金额的写操作都在一个事务里完成
（expense + shares + ledger revision）。

## Agent 与业务系统的边界（核心设计）

```
用户说的话
   │
   ▼
Agent（可替换）              只做「理解 → 推断 → 输出结构化操作」
   │  AgentPatch { action, amount, date, paid_by, sharing... }
   ▼
指代消解（业务）              「小王」→ user_id；重名就提问，绝不猜
   │  DraftState { amountCents, paidBy, participants... }
   ▼
金额物化（业务）              平均/权重用最大余额法；指定金额必须自洽
   │  shares: [{userId, amountCents}]
   ▼
确定性校验（业务）            成员归属、金额合法、非负、Σshares == total
   │
   ▼
用户确认 → 保存（业务）       保存前再校验一次，事务写入
```

Agent 不接触数据库，也不决定「谁属于这个账本」。它可以很聪明地理解语言，
但对钱的行为被限制在一份 schema 之内，并且这份 schema 的产物必须通过业务校验。

好处是具体的：换模型只影响 `llmParser.ts`；规则解析器（`ruleParser.ts`）完全不依赖网络，
既是 LLM 不可用时的兜底，也是全部金额场景的回归测试基准。

## 同步模型

- 每个账本有一个单调递增的 `revision`；每次写入都会把受影响行标记成新的 revision。
- `GET /ledgers/:id/sync?since=N` 返回该游标之后变化过的账本/成员/分类/账目，并给出新游标。
- 删除是**软删除**：墓碑也会随同步下发，其他设备据此移除本地副本。
- 写入端幂等：客户端为每次创建生成 `clientMutationId`，重试不会重复记账。
- 冲突处理：更新时带 `expectedRevision`，不匹配返回 409；客户端提示「已被其他人修改」
  并自动重新同步，而不是静默覆盖。
- 离线：断网时创建操作进入本地 outbox，联网后按原 `clientMutationId` 重放。

## 金额

- 全链路使用**整数分**（`amountCents`），包括 API、数据库、Swift 模型与 UI。
- 分摊用最大余额法（largest remainder）：`500 / 3 = 16667 + 16667 + 16666 分`，
  多出的分给列表里靠前的人，结果确定且可复现。
- 服务端与客户端各有一份实现（`domain/money.ts` / `ShareAllocator.swift`），
  规则一致；服务端那份是权威。
- 日期是**本地日历日**（`YYYY-MM-DD`），不是时间戳：在东京吃晚饭就记东京那天，
  客户端通过 `x-client-date` 把自己的「今天」告诉服务端。

## 为什么不用框架 / 少依赖

- 后端的运行时依赖是 **0**：HTTP 用 `node:http` + 手写路由，数据库用内置 `node:sqlite`，
  LLM 用内置 `fetch`。这样这个项目只依赖 Node 本身，不会因为依赖升级而腐坏。
- 这不是「为了少而少」：20 个端点、一种鉴权、一种错误模型，框架带来的抽象成本大于收益。
- iOS 侧只用系统框架（SwiftUI / Speech / AVFoundation / Observation），没有第三方库。

## 未来扩展点（已留好，但目前不做）

- **正式账号体系**：`users.id` 稳定，`device_id` 只是当前的凭证；加一张
  `user_identities(provider, subject, user_id)` 就能接手机号/Apple 登录，不需要改账目表。
- **Android**：接口是纯 REST/JSON，分页与游标都是通用的，没有 iOS 专属语义。
- **债务结算闭环**：现在已经有 `settlements`（最小转账集），加一张 `settlements` 表
  记录「已结清」即可。
- **自定义分类**：分类是数据表，按账本存入，已有创建接口，只差管理 UI。
