# 验证说明

这份文档说明「怎么证明它真的能用」，以及每一项验证覆盖了什么。

## 1. 后端：单元 + 端到端

```bash
cd server && npm test
```

`Test Files 5 passed | 1 skipped` · `Tests 52 passed | 3 skipped`

| 文件 | 覆盖内容 |
| --- | --- |
| `tests/money.test.ts` | 金额解析/格式化；**1..2000 分 × 1..11 人 的穷举**，断言每人差额 ≤ 1 分且总和精确 |
| `tests/domain.test.ts` | 业务规则（付款人/承担人成员校验、负数、重复、求和、金额合法性）；余额与结算；收入语义 |
| `tests/ruleParser.test.ts` | 口语解析：金额识别不被人数/日期误判、千分位、万、收入识别 |
| `tests/sharing.test.ts` | **产品需求里的全部分摊场景**（见下表）+ 追问 + 上下文 + 舍入不变量 |
| `tests/api.test.ts` | 真实 HTTP + 真实 SQLite 的 MVP 闭环：匿名身份 → 建账本 → 邀请码加入 → Agent 理解 → 保存 → 另一设备同步 → 统计 → 编辑/删除 → 权限 |

被 `sharing.test.ts` 钉死的场景（全部通过）：

| 场景 | 断言 |
| --- | --- |
| 这顿饭我付的，一共 300，我们三个人平摊 | 付款人我；100/100/100 |
| 我付了 500，小王承担 200，剩下我自己承担 | 我 300；小王 200 |
| 这 600 块我付的，我和小王一人一半，小李不算 | 我 300；小王 300；小李不参与 |
| 酒店 1200 我先付了，我们四个人平摊 | 住宿；四人各 300 |
| 我付了 500，我们三个人吃饭，其中小王和小李也要分摊 | **16667 / 16667 / 16666 分**，和 == 50000 |
| 第二天也是 800（承接上句） | 新账目；日期为上一笔次日；继承分类/备注/付款人 |
| 小李不算，改成我和小王平摊 | 识别为「修改」；总额不变；改为两人平分 |
| 账本里有重名 / 名字不在账本 / 人数不匹配 | **不猜**，返回追问 |
| 分摊合计 ≠ 总额 | 返回 `shares_sum_mismatch`，拒绝保存 |

## 2. 真实模型路径（可选）

```bash
cd server && LLM_E2E=1 npx vitest run tests/llm.e2e.test.ts
```

3 个用例：MVP 主句式、指定金额分摊、上下文追问。断言的是**业务结果**
（总额、付款人、参与人、Σshares），不是模型的措辞——两条解析路径产出同一份 `AgentPatch`，
所以换模型不会改变业务结论。

## 3. 后端冒烟：一条命令看完整个闭环

```bash
cd server && npm run smoke
```

会真实启动一个 HTTP 服务（临时数据库），并按 11 步打印中文过程：
匿名身份 → 建账本 → 邀请码 → 另一设备加入 → 说一句话 → 展示确认卡片
→ 保存 → 幂等重复上传 → 另一设备同步 → 自然语言修改 → 统计 → 结算建议 → 规则拦截。

## 4. iOS：单元测试

```bash
cd ios && xcodebuild test -project TripBudget.xcodeproj -scheme TripBudget \
  -destination 'platform=iOS Simulator,name=iPhone 17' -only-testing:TripBudgetTests
```

`Executed 14 tests, with 0 failures`：客户端金额格式化/解析、**与后端一致的
最大余额法分摊**（含 500/3 = 167/167/166）、Server 响应解码（就绪 / 追问 / 统计）、
本地缓存与离线队列往返、账目排序。

## 5. iOS：端到端 UI 测试（真实后端 + 真实多设备）

```bash
cd server && npm run dev          # 先启动后端
cd ios && xcodebuild test -project TripBudget.xcodeproj -scheme TripBudget \
  -destination 'platform=iOS Simulator,name=iPhone 17' -only-testing:TripBudgetUITests
```

`testFullCaptureFlowFromOnboardingToSavedExpense` 走完并断言：

1. 首次进入 → 只填一个昵称 → 开始使用
2. 账本 tab → 创建「日本旅行」→ 读屏上的邀请码
3. 测试进程用该邀请码，以**另外两个匿名身份**调用 API 加入（真实的多设备路径）
4. **重启 App** → 断言成员列表已同步出「小王」「小李」（验证启动同步）
5. 首页 → 录音记账页 → 输入「我付了 500，我们三个人吃饭，其中小王和小李也要分摊」
6. 确认卡片：`确认记账` 可用，卡片上同时出现 **166.67** 与 **166.66**
7. 保存 → 回到首页 → 断言新账目出现在最近账目里
8. 统计页 → 断言「实际支付」列存在、总额 ¥500.00、某成员承担 ¥166.67

每步都附了截图，保存在 `docs/screenshots/`：

| 截图 | 内容 |
| --- | --- |
| `01-onboarding.png` | 只填昵称的首次进入 |
| `02-home-no-ledger.png` | 首页（尚未建账本） |
| `03-invite-code.png` | 建完账本，展示可分享的邀请码 |
| `04-home-with-members.png` | 重启后同步到 3 人成员 |
| `05-utterance.png` | 录音记账页（模拟器无语音识别时用同一句话输入） |
| `06-confirm-card.png` | 确认卡片：付款人 + 每人金额 |
| `07-home-with-expense.png` | 保存后首页出现该账目 |
| `08-stats.png` | 统计：实际支付 vs 实际承担 |

> 语音识别在模拟器上不可用（系统限制），所以 UI 测试走的是**同一句话的文本入口**；
> 真机上点麦克风即走 `SFSpeechRecognizer`。两条路进入的是同一个 Agent 接口。

## 6. 已知限制

- 模拟器没有语音识别与麦克风输入，语音路径需要在真机验证；App 已做了完整的降级
  （识别不可用时提示并切到文本输入，功能不缺失）。
- UI 测试依赖本机 4000 端口上的后端；未启动后端时该测试会失败（这是有意的，不是 mock）。
- 匿名身份以 `deviceId` 为凭证，同一台设备重装后是同一个身份；这是 MVP 的取舍，
  正式账号体系的扩展点见 `docs/ARCHITECTURE.md`。
- 第一阶段没有实现真正的「还钱/结清」，只输出结算建议；数据模型已经支持。
