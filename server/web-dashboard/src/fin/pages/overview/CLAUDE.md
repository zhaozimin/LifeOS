# fin/pages/overview/
> L2 | 父级: ../CLAUDE.md

成员清单
status-card.tsx: 财务 KPI 的统一状态卡。
charts.tsx: 收入、项目成本回款与工作生活支出 ECharts 视图；只接收已聚合数据。
data.ts: 对交易、项目和账户归属的纯聚合与抽屉筛选函数。

法则：图表不访问 API；OverviewPage 负责读取、刷新、抽屉状态和 widget 装配。
依赖方向单向且不可逆：data.ts 拥有全部聚合口径与轴格式化，charts.tsx 拥有全部展示类型（含 AreaMode），
OverviewPage 只从两者导入、不自行定义。三者任何一方都不得用 `@ts-nocheck` 关闭检查——
本目录由 OverviewPage 拆分而来，跨文件符号只剩编译器一道防线，关掉它等于把崩溃推迟到用户点击那一刻。

[PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
