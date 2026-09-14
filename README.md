# Trip Budget · 共享记账

一个 iPhone 优先的多人共享记账 App：**说一句话就记好一笔账**，并且从数据模型层面就把
「谁付的钱」和「谁承担费用」当作两个一等概念。

```
打开 App → 说一句话 → Agent 理解 → 用户确认 → 完成记账
```

> 「我付了 500，我们三个人吃饭，其中小王和小李也要分摊。」
> → 付款人：我，总额 ¥500，我 ¥166.67 / 小王 ¥166.67 / 小李 ¥166.66（严格等于 500）

---

## 为什么这个数据模型值得单独说

大多数记账 App 把一笔支出记成「我花了 300」。这个 App 记成：

```
Expense
├── totalAmount: 300      // 总金额
├── paidBy: 我            // 谁实际付了钱
└── shares                // 每个人最终承担多少
    ├── 我:   100
    ├── 小王: 100
    └── 小李: 100
```

差异就是「垫付 / AA / 部分分摊 / 指定金额」这些场景能不能自然表达。因为 `paidBy` 和
`shares` 从一开始就是分开的字段，后续的应收应付、结算建议、按成员统计都不需要推翻模型：

- 按成员统计时 **「实际支付」和「实际承担」是两列不同的数字**
  （A 支付了 ¥1000，但最终只承担 ¥300 —— 统计不会认为 A「消费了 ¥1000」）。
- 结算建议（谁该给谁多少钱）完全由 `paidBy` + `shares` 推导，不需要额外字段。
- 所有 `shares` 之和必须严格等于 `totalAmount`，由**服务端的确定性规则**保证，
  而不是交给 AI 判断。

---

## 一分钟跑起来

### 1. 后端（Node ≥ 22.5，零运行时依赖）

```bash
cd server
npm install
npm test          # 52 个测试：金额、业务规则、Agent、HTTP 端到端
npm run dev       # http://127.0.0.1:4000
```

想看一眼完整的 MVP 闭环（含中文步骤说明）：

```bash
cd server && npm run smoke
```

### 2. iPhone App

```bash
cd ios
xcodegen generate           # 由 project.yml 生成 TripBudget.xcodeproj
open TripBudget.xcodeproj   # 选 iPhone 模拟器，运行
```

模拟器直接连 `http://127.0.0.1:4000`，不用配任何东西。

#### 装到真机上（Xcode 直接 Run 就行）

1. 手机用数据线连上 Mac，信任这台电脑；
2. 打开 `TripBudget.xcodeproj`，在顶部把运行目标选成你的 iPhone；
3. 按 Run。

`project.yml` 里已经写好了 `DEVELOPMENT_TEAM`（个人开发者团队）和真机默认的服务器地址
（`TRIP_BUDGET_API`，见下），所以正常情况下点 Run 就能装上，不需要手动选签名团队。

关于「手机怎么找到你电脑上的后端」——真机上 `127.0.0.1` 指的是手机自己，所以必须用局域网地址：

| 场景 | 地址从哪来 |
| --- | --- |
| 首次安装 | 构建时写进 Info.plist 的 `TRIP_BUDGET_API`（`project.yml`，当前是 `http://192.168.3.84:4000`） |
| 之后换了 Wi-Fi / 换了电脑 | App 里改：**账本 → 我 → 服务器地址**，填 `192.168.1.20:4000` 这种，点「保存并重连」即可，不用重装 |
| 临时调试 | Xcode → Edit Scheme → Run → Arguments → Environment Variables 里设 `TRIP_BUDGET_API` |

优先级：App 里设置的 > 环境变量 > Info.plist > 回环地址。

前提是手机和电脑在同一个 Wi-Fi 下，且后端监听 `0.0.0.0`（默认就是）。
第一次连的时候 iOS 会弹「本地网络」权限，允许即可。

想用命令行装也可以用脚本（会自动探测手机、算出本机局域网地址）：

```bash
cd ios && ./scripts/run-on-device.sh
```

### 3. AI 是可选的，不是必需的

自然语言理解有两条路，产出**完全相同**的结构化结果（见 `docs/AGENT.md`）：

| 解析器 | 何时使用 | 特点 |
| --- | --- | --- |
| `ruleParser`（确定性规则） | 默认回退 | 全离线、可单元测试、覆盖产品需求里的全部句式 |
| `llmParser`（DeepSeek） | 配置了 `DEEPSEEK_API_KEY` | 更宽松的口语理解；失败或超时会自动回退到规则解析 |

```bash
cd server
DEEPSEEK_API_KEY=sk-xxx npm run dev      # 启用模型
LLM_E2E=1 npx vitest run tests/llm.e2e.test.ts   # 用真实模型跑一遍验收场景
```

换模型不需要动业务代码：两条路都只输出同一份 `AgentPatch`，之后走同一个校验器。

---

## 目录结构

```
server/                      Node + TypeScript，零运行时依赖
  src/domain/                金额 / 分类 / 校验 / 统计（纯函数，可脱离 HTTP 测试）
  src/agent/                 Agent：规则解析、LLM 解析、指代消解、编排
  src/store/                 SQLite（node:sqlite）+ 仓库层
  src/http/                  手写路由（20 个端点）
  tests/                     52 个测试，含 HTTP 端到端
ios/TripBudget/
  App/                       入口、主题、根路由
  Core/                      模型、API 客户端、本地缓存与离线队列、语音、金额
  Features/                  Onboarding / 首页 / 录音记账 / 确认 / 账目 / 统计 / 账本
  TripBudgetTests/           14 个单元测试
  TripBudgetUITests/         端到端 UI 测试（真实后端 + 真实多设备加入）
docs/                        架构、数据模型、API、Agent 契约、验证说明
```

---

## 这一版做了什么（MVP 范围）

- **无需注册**：首次进入只设置一个昵称；底层 `users.id` 稳定，给未来正式账号体系留了位置。
- **多账本**：创建 / 切换 / 重命名；创建者与成员两种角色。
- **邀请码共享**：`TRIP-8F3K2` 形式，可系统分享、可重置；另一台设备输入即加入。
- **语音 + 自然语言记账**：Speech-to-Text → Agent → 结构化账目 → 确认 → 保存。
  模拟器没有语音识别时，同一句话可以直接打字输入（能力不缺失）。
- **代付与分摊**：`paidBy` 与 `shares` 分离，支持平均 / 指定金额 / 排除成员 / 剩余部分归某人。
- **确认界面**：金额、分类、日期、付款人、承担人、每人金额都可改，也可以继续说一句话改
  （「小李不算，改成我和小王平摊」）。
- **统计**：总支出 / 总收入 / 分类占比 / 按时段 / 按成员（实际支付 vs 实际承担）/ 结算建议。
- **同步**：增量拉取（游标）、软删除墓碑、`clientMutationId` 幂等、`expectedRevision` 乐观并发、
  离线写入队列（联网自动重放）。

## 明确没做的（刻意留到后面）

- 账号体系（手机号 / 邮箱 / OAuth / Sign in with Apple）
- Android 客户端（后端与数据模型不设限制，接口是纯 REST + JSON）
- 完整的债务结算闭环（现在只输出结算建议，不记录「已还钱」）
- 通知 / 推送、导出、自定义分类管理 UI（后端已支持 `POST /categories`）

---

## 验证情况

| 验证项 | 命令 | 结果 |
| --- | --- | --- |
| 后端单元 + 端到端 | `cd server && npm test` | 52 passed |
| 真实 LLM 路径 | `cd server && LLM_E2E=1 npx vitest run tests/llm.e2e.test.ts` | 3 passed（与规则解析结果一致） |
| 后端冒烟闭环 | `cd server && npm run smoke` | 全部通过 |
| iOS 单元测试 | `xcodebuild test -only-testing:TripBudgetTests` | 14 passed |
| iOS 端到端 UI | `xcodebuild test -only-testing:TripBudgetUITests` | 通过（119s，含真实多设备加入） |

UI 测试跑的是完整闭环：设置昵称 → 创建账本 → 读出邀请码 → **另外两台「设备」用邀请码加入**
→ 重启 App 验证同步 → 输入「我付了 500，我们三个人吃饭，其中小王和小李也要分摊」
→ 确认卡片上断言 `166.67 / 166.67 / 166.66` → 保存 → 首页出现该账目 → 统计页断言
「实际支付 ¥500.00 / 实际承担 ¥166.67」。截图见 `docs/screenshots/`，细节见 `docs/VERIFICATION.md`。

---

## 分支与提交约定

- 功能分支：`feature/<taskId>`、修复分支 `fix/<taskId>`
- 不在主分支直接开发；提交信息用英文 + 说明「为什么」
- 改动业务规则时必须同时在 `server/tests/` 补测试
