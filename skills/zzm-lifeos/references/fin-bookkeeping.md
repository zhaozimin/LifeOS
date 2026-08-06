<!--
[INPUT]: 依赖 LifeOS 财务域 `/v1/fin/*` 的 configuration、transactions、habits、import、attachments 与 reimbursements 端点，以及用户的自然语言收支表达。
[OUTPUT]: 对外提供把用户话语映射到唯一 finctl 命令的确定性协议：渐进式字段推断、结构化信用卡还款护栏、文件传参写入、90 秒重复闸与 --allow-duplicate 的确认纪律、纠错与作废、报销核销、账单导入两步制、结果未知纪律，以及账务行六符号回显字典。
[POS]: lifeos Skill 的财务领域规则，也是账务行字典的唯一真源；只裁定语义，金额渲染、账户类型判定与报销状态机由 finctl/finview 与服务端兜底。时间表达一律走 timectl 与 time-recording.md，两本账本永不合库。
[PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
-->

# LifeOS 渐进式记账协议

## 核心原则

渐进式不是“先乱猜再修正”，而是让账本中的真实配置与历史习惯逐渐替代重复追问：第一次说完整，后续短句可以沿用强习惯；用户本次明确表达永远优先。

本协议只管财务账本。同一句话里的活动与时长属于时间域，必须另起一笔交给 `timectl`（见 [time-recording.md](time-recording.md)）；`finance.sqlite3` 与 `time.sqlite3` 永不合库、永不跨库事务，两笔各自写入、各自回显。

## 1. 连接与准备

1. 运行 `python3 "<SKILL_DIR>/scripts/finctl.py" request GET /v1/health`。
2. 连接失败但能定位安装：按 [deployment.md](deployment.md) 回到原安装目录恢复服务，再试一次。
3. 找不到安装：询问是否现在部署，不创建临时账本。
4. 每次会话首次写入前运行 `python3 "<SKILL_DIR>/scripts/finctl.py" request GET /v1/fin/configuration`；缓存最多 30 分钟，用户修改设置后立即刷新。写命令本身也会在发包前用同一份 configuration 对拍账户与分类，但那是护栏，不能代替你先看一眼真实主数据。

> `<SKILL_DIR>` 指本 Skill 目录（即包含 `scripts/finctl.py` 的那个 `lifeos` 目录）的绝对路径。Hermes 平台可用 `${HERMES_SKILL_DIR}` 展开，**其他平台该变量为空，必须先换成绝对路径**。详见 deployment.md 的防坑清单第 7 条。

完整字段与错误体以已安装仓库 `server/domains/finance/routes_read.py`、`routes_write.py` 的 `ROUTES` 契约和领域服务为准。LifeOS 不保留 FinOS 时代的 `docs/api.md`——那份文档已被实测认定失实（其中的 `?token=` 早已从代码移除），禁止据它推断字段。

## 2. 判断动作

- “花了、买了、付了、收到、工资到账、转账、还信用卡”且表示已发生：写交易。
- “想买、提醒我、计划转账”：不写。
- “这个月花了多少、预算还剩多少”：查询，不写。
- 语义不确定时只问一句：“这笔已经发生，需要现在记入账本吗？”

## 3. 最小提取

写交易至少确定：

- `amount`：始终为非负数字，方向由 `kind` 决定。finctl 会在本地拒绝负数。
- `kind`：`expense`、`income` 或 `transfer`，由子命令名决定，不必也不能手写进 payload。
- `title`：事项或商户。
- 支出/收入的 `accountName`；转账的 `fromAccountName` 与 `toAccountName`。

推荐补充：`merchant`、真实 `category.name`、`occurredAt`、`source: "agent"`。标签、备注、项目、报销、发票只在用户表达或业务必需时填。

典型方向：

- 买、花、付、订阅、扣款 → `expense`
- 收到、工资、回款、退款 → `income`
- 账户间挪钱、还信用卡、充值钱包、取现 → `transfer`

### 信用卡还款：判据在脚本，不在措辞

信用卡还款是**自有账户之间的资金转移**，必须写成 `transfer`，把来源账户与目标信用卡都落库。finctl 在发包前按账户类型和资金方向判定，与你怎么措辞无关（历史上靠“标题里有没有『还款』两个字”的护栏，被「还信用卡」「信用卡账单」「card payment」轻易绕过）：

| 形态 | 结论 |
|---|---|
| `expense` 落在信用卡账户上 | 放行。这是刷卡消费，本来就该这么记 |
| `income` 落在信用卡账户上（`accountName` 或 `toAccountName`） | 拒绝。钱进入信用卡是还款方向，改用 `transfer` |
| 非 `transfer` 却同时写出两个自有账户 | 拒绝。形态本身就是转账被记错了 `kind` |
| `transfer` 从储蓄账户到信用卡 | 放行。这才是还款的正确形态 |

唯一例外：商户退款、返现等**外部**资金流入信用卡，结构上与还款不可分辨，确认属实后加 `--external-inflow` 显式声明放行。不要用它绕开还款——那会让账本凭空多出一笔收入，并且看不见钱从哪个账户流出。

另有一格结构永远看不见：`expense` 单独落在信用卡上时，刷卡消费与“把还款记成卡上支出”形态完全相同。finctl 在这一格保留一张收窄的还款词表兜底；被它拒绝时说明结构与措辞自相矛盾，请与用户确认后改用 `transfer`，不要靠改标题绕过。

## 4. 渐进推断顺序

同一套五级顺序在两域通用（SKILL.md 常驻层已给出总纲），财务域细则如下：

1. 用户本次明确说出的账户、分类、时间和用途。
2. `finctl habits`（`GET /v1/fin/habits`）返回的强习惯；`share >= 0.7` 可直接沿用。
3. 最近同类交易中的稳定选择。
4. 系统配置中明确标记的默认值。
5. 仍有多个合理选项时，只询问影响账目真实性的那个字段。

**分类不问，账户必问。** 分类从现有清单里挑语义最近的那个，挑不出就用兜底的“未分类”（它一定存在，服务端每次启动都会确保）——**不要为了确认分类停下来反问用户**，写完在回执后加一行「归到「X」，不对说一声」即可。他不回应就是接受，回应了就按他说的改，两种都不打扰。绝不自行新建分类。

账户则相反：找不到真实账户时**必须问**。账户牵着余额，选错会让净资产错乱而用户当场看不出来；finctl 会用 configuration 对拍，未知账户在本地就被拒绝，不会发包。

一次例外不改写长期习惯；习惯由账本历史自然演化。

## 5. 写入与确认

**JSON 一律走文件传参。** 先用文件写入工具把补充字段落地成一个 JSON 文件，再把绝对路径交给 `--payload-file`。禁止 heredoc、`echo`、`printf` 与任何管道：`printf ... | python3 ...` 会被安全策略判为高危并中断整次写入，正确的一笔也会因此完全不落库。finctl 也不再接受 `--payload-file -` 这种 stdin 形态。

```bash
# /tmp/lifeos-fin-payload.json（用文件写入工具创建，不要用 shell 拼）
# {"accountName":"微信支付","category":{"name":"餐饮"},"merchant":"楼下面馆","source":"agent"}

python3 "<SKILL_DIR>/scripts/finctl.py" expense --title "午饭" --amount 38 \
  --payload-file /tmp/lifeos-fin-payload.json

python3 "<SKILL_DIR>/scripts/finctl.py" income --title "工资" --amount 21000 \
  --payload-file /tmp/lifeos-fin-salary.json

# 还信用卡：来源与目标都写在 payload 文件里的 fromAccountName / toAccountName
python3 "<SKILL_DIR>/scripts/finctl.py" transfer --title "还招商信用卡" --amount 3200 \
  --payload-file /tmp/lifeos-fin-repay.json
```

`--title` 与 `--amount` 是命令行参数，其余字段都在 payload 文件里；两者合并后由 finctl 补上 `kind` 再发出。多笔交易逐笔写入，成功后统一确认。

回复只转达回执里的 `display`（见第 9 节），不要展示请求 JSON，不要输出 Token。响应失败时不得声称“已记”。

### 同一笔不许写两遍

服务端在**新建**路径上有一道 90 秒重复闸：金额、方向、币种、账户三字段与标题全都相同、且发生时刻也落在同一窗口内的第二笔，一律以 409 `duplicate_record` 拒绝，回执里的 `existingId` 指向已经落库的那一笔。窗口之外（例如今天第二杯同样价钱的咖啡）永远放行——这道闸只挡“一次操作被提交了两遍”，不挡用户真实的重复消费。

收到 `duplicate_record` 时的纪律：

1. **禁止自动重试，也禁止改一个字重发。** 409 是明确的“本次未写入”，账本此刻正确，重发只会让它变错。
2. 用 `finctl transactions` 看一眼 `existingId` 那一笔，把它念给用户听。
3. 只有用户明确说“这是另外一笔”，才在同一条命令上加 `--allow-duplicate` 重发；用户说“那就是刚才那笔”，就到此为止，什么都不写。

```bash
# 用户已确认这是第二笔真实消费，不是重复提交
python3 "<SKILL_DIR>/scripts/finctl.py" expense --title "咖啡" --amount 25 \
  --payload-file /tmp/lifeos-fin-coffee.json --allow-duplicate
```

不要养成“遇到 409 就加 `--allow-duplicate`”的习惯：那等于把这道闸原地拆掉，用户的账本会重新开始悄悄翻倍。

同一个 id 重发（payload 里带了 `id`，而那条流水已存在）同样是 409 `duplicate_record`，含义是“那一行原封不动，本次一个字节都没写进去”。改用 `correct` 修改既有那一笔，或换成一次真正的新建。

## 6. 纠错、作废与报销

全部走 finctl 高层命令，不要自己拼 HTTP 动词和路径：

| 动作 | 命令 |
|---|---|
| 改刚才那一笔 | `finctl correct --id <ID> --payload-file <绝对路径>`，payload 里**只写要改的字段** |
| 作废一笔 | `finctl void --id <ID> --reason "<用户原话或明确理由>"`（软删，审计链保留） |
| 报销核销 | `finctl settle --income-id <回款收入 ID> --settle-ids-file <绝对路径>`，可选 `--unsettle-ids-file` 撤销误核销 |
| 查流水 | `finctl transactions` |
| 查习惯 | `finctl habits` |

- 纠正前先用 `transactions` 查最近交易并唯一定位目标；不唯一时列出最少候选让用户选。
- 不通过反向补一笔来伪装删除，除非用户明确要求保留冲销审计。
- 报销状态机：`notApplicable`（默认，与报销无关）、`draft`（可报销待提交）、`submitted`（已提交）、`reimbursed`（已核销）、`rejected`（被驳回）。用户说“可报销”时才写 `draft`。
- 回款到账时：先按 `income` 记这笔回款，再用 `settle` 把它与被垫付的支出一一对应。服务端只接受未软删、`kind=expense` 且报销状态不是 `notApplicable` 的支出，被拒的 ID 会原样出现在回执的 `invalid` 数组里——照实告诉用户，不要重发。
- 只改单笔报销状态而不核销时，用 `finctl request PATCH /v1/fin/transactions/<ID>/reimbursement --payload-file <绝对路径>`（payload 形如 `{"status":"submitted"}`）。
- 时间域的撤销与本域无关：混合句里那条时段要用 `timectl cancel` / `timectl delete` 单独处理，一条命令永远只动一本账。

## 7. 查询

- 月汇总：`finctl request GET "/v1/fin/summary/month?month=YYYY-MM"`
- 预算：`finctl request GET "/v1/fin/budget/status?month=YYYY-MM"`
- 流水：`finctl transactions`，需要筛选参数时用 `finctl request GET "/v1/fin/transactions?..."`

只返回用户问题需要的汇总，不主动泄露完整交易明细。`request` 的路径必须落在 `/v1/fin/*`（唯一例外是只读 `GET /v1/health`）；写成 `/v1/time/*` 会在发包前被 lifeconn 拒绝——那不是故障，而是提醒你这句话属于时间域。

## 8. 附件、导入与主数据护栏

- 收据或发票：先建交易拿到 ID，再把原始文件字节 Base64 后放进 payload 文件，用 `finctl request POST /v1/fin/transactions/<ID>/attachments --payload-file <绝对路径>` 上传（字段 `data`/`filename`/`mime`）。不要用图片描述冒充文件数据；单文件不超过 10MB。
- 账单导入是 `POST /v1/fin/import/preview` → `POST /v1/fin/import/commit` 两步：preview 纯解析不写库（`content` 为 Base64，单文件不超过 20MB），commit 才落库。**commit 不做查库去重**，重复提交会重复入账，提交前必须逐笔给用户看清并取得明确确认。
- 新账户、分类、资金来源或项目必须先展示现有选项并取得明确同意，再用 `finctl request POST /v1/fin/agent/operations --payload-file <绝对路径>`，把用户原始确认语放进 `userConfirmation`。缺这个字段服务端会以 422 `user_confirmation_required` 拒绝；绝不伪造确认。

## 9. 回显：原样转达 display（账务行字典真源）

写命令的回执带一个 `display`，它由 finview 按落库事实拼好，就是要给用户看的成品文本。**逐行原样输出，一字不增、一字不减，前后不加任何话**；没有 `display` 就不能声称写入成功。

```
✓ ¥38.00 午饭
```

六个符号各自只对应一种账本状态，与命令名无关；它们由脚本产出，不必也不得由模型拼装：

| 符号 | 含义 | 判据（服务端真实状态） |
|---|---|---|
| `✓` | 已入账 | 正常落库的一笔，`deletedAt` 为空且 `updatedAt == createdAt` |
| `↻` | 已更正 | `deletedAt` 为空且 `updatedAt != createdAt`，即这笔被 `correct` 改过 |
| `✗` | 已作废 | `deletedAt` 非空（软删）。**优先级最高，高于转账 `⇄`**——一笔被作废的转账画 `✗`，不画 `⇄` |
| `⇄` | 已转账 | 未作废且 `kind == "transfer"` |
| `⚑` | 待报销 | `reimbursementStatus` 属于 `draft`、`submitted`、`rejected` |
| `✓⚑` | 已核销 | `reimbursementStatus == "reimbursed"` |

`notApplicable` 是绝大多数交易的默认值，**不显示任何报销标记**。报销标记是主符号后的后缀，例如一笔待报销的差旅支出是 `✓ ¥1280.00 高铁票 ⚑`，核销后变成 `✓ ¥1280.00 高铁票 ✓⚑`。

`settle` 与导入这类批量写入允许首行汇总 + 末行计数，例如 `✓⚑ 已核销 3 笔，撤销 0 笔`。

**`¥` 只出现在账务行，时间行永不出现金额。** 混合句拆两笔后，两条回执各出各行，用户一眼就能分辨哪一行来自哪本账。时间行的五符号字典写在 [time-recording.md](time-recording.md) 第 6 节，两套字典分立，不得互相借用符号语义。

## 10. 错误分级

- 本地写前校验失败（金额为负、账户或分类不存在、信用卡还款形态不对、路径越域）或服务端明确返回 4xx：可以确认未写入；修正事实后才提交新请求。
- **5xx、超时、断连、重定向或畸形回执：结果未知，禁止重试**——原请求可能已经落账，重发就是重复入账。先用只读 `transactions` 核查目标窗口，再根据账本事实决定是否仍需写入。finctl 对这一类返回退出码 3 与 `error: result_unknown`，那是“去核查”，不是“去重发”。
- 401：停止，提示检查本机连接配置或恢复原服务，不索要用户把 Token 发到聊天。
- 422：按返回的机器码与 `agentInstruction` 处理，`user_confirmation_required` 回到明确确认步骤，其余按有效选项向用户追问。
- 409 `duplicate_record`：明确未写入。**禁止自动重试**，按第 5 节“同一笔不许写两遍”的三步走——先只读核对 `existingId` 那一笔，再向用户确认，确认是另一笔才带 `--allow-duplicate` 重发。
- 404：重新查 `transactions` 或 `configuration` 确认目标，不猜 ID。
- 413：附件超 10MB 或账单超 20MB，换文件或分批，不要截断内容后重发。

## 11. 本版关闭的两件事

**只记人民币。** 服务端只接受 CNY，显式的非人民币币种一律 409 `mvp_single_currency_only`。

真正危险的不是这道闸，是绕过它的那条路。用户说「东京午饭 3000 日元」时，你若直接 `--amount 3000`，服务端**不会**报错——它按 CNY 记下 ¥3000，回执照常给出「✓ ¥3000.00 东京午饭」。用户说的是 3000，看到的也是 3000，分辨不出这笔约 ¥150 的消费被记成了 ¥3000。这道闸只在你主动声明币种时才拦得住你，而它拦不住的那条路恰好是你最可能走的那条。

因此：**用户报的金额只要不是人民币，一律先停下告诉他本版只记人民币**，由他决定是自己折算成人民币报一个数，还是这笔先不记。**绝不许你替他按汇率折算**——你用的是哪一天、哪个来源的汇率，账本里不会留下任何痕迹，日后无从复核。

**周期账目是暂停的。** 用户说「房租每月自动记一笔」「订阅费帮我设成自动的」时，服务端以 409 `mvp_recurring_paused` 拒绝。如实告诉他这一版还不能自动重复，请他每月说一次；不要替他记一笔当月的就当作办好了，那会让他以为往后几个月都有人管。

两条都写在 `docs/已知问题.md` 里，用户可以自己核对。

[PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
