# lib/

> L2 | 父级: ../CLAUDE.md

成员清单

financeAnalytics.ts: 纯财务分析与图表模型转换；在不改变原始流水的前提下，过滤会破坏 ECharts 无环约束的资金流连线（自环与回边只在展示模型里消失，绝不炸页面）。桑基连线存在 `source →（target → 金额）` 的出边表里，它同时充当判环的邻接表——曾把两个名字编码成 `a__b` 当 key 再 split 回解，账户名含 `__` 就解出不存在的节点、ECharts 静默丢边，用户的钱在资金流里凭空消失；名字是用户写的自由文本，结构化数据一律不进字符串。本层所有聚合都假定输入是整本账，页面因此不得传会截断历史的 limit。
reimbursement.ts: 报销领域模型；状态元数据与 isReimbursable/isPendingReimbursement/isReimbursementIncome 判定，供饼图卡、流水页、核销抽屉共享同一套语义。
format.ts: 金额、日期与文案的展示格式化工具。
timeRange.ts: 时间粒度、区间键与流水筛选规则；月末/季末/ISO 周起点的解释权收在这里，页面只传不透明区间键。边界由 `test_fin_pure.mjs` 锁定。
useApi.ts: 页面异步 API 请求状态 hook；loader 存 ref 供调用方就地写闭包，卸载后丢弃迟到响应。
useBodyScrollLock.ts: 弹层打开期间的页面滚动锁定 hook；只锁 overflow，不做 padding 补偿——滚动条占位由全局 scrollbar-gutter: stable 承担，二者叠加会导致抖动+白边（历史教训）。

法则: 此目录只做纯转换与 UI 基础能力；不得在这里写入账本或绕过 API 客户端。
[PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
