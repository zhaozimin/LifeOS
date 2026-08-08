# pages/

> L2 | 父级: ../CLAUDE.md

成员清单

FlowPage.tsx: 全局资金流桑基图与抽屉钻取；三视图 tab 仅 dual 模式显示；流水不传 limit 取整本账——桑基路径、可支撑月数与时间范围栏的可选桶全部由这份数据推导，早期月份不得因数量上限从界面消失；整页一屏装下——根容器 = 视口−顶栏−留白的纵向 flex，桑基区 flex-1 吃掉剩余高度（不随数据量变化），标题与 KPI 行同屏可见，极小窗口 560px 保底转页面滚动。（首次引导已搁置，待整套使用教程后重做。）
OverviewPage.tsx: 财务状况看板的读取、刷新、抽屉和 widget 编排；MVP 不取周期规则且固定不渲染现金流预测/订阅卡，图表与聚合拆至 `overview/`。
LedgerPage.tsx: 流水账本，已删除流水保留原位置；修改痕迹弹窗将所有旧版本和删除内容以灰色删除线展示，并标明 AI/用户操作者，当前汇总只读最新有效版本；报销 tab 是全历史欠账清单（不受时间区间限制），二级状态桶按流程划分——待报销(draft+submitted 未出结果)/已驳回/已报销/全部，恰好分区；行内「是否报销」双按钮标记 ⇄ 撤回，报销回款收入行提供核销抽屉入口。KPI 卡「待回款」是钱的维度（含已驳回），与状态桶正交。
SettingsPage.tsx: 财务设置中心的草稿、保存和分组装配；MVP 不渲染货币/汇率与周期账目面板，旧深链统一回落到账户。
DesignSystemPage.tsx: 财务设置开发者模式中的设计系统活文档；色彩令牌实时测量自当前主题，控件、NavigationTile 与图表全部渲染真实共享组件。
overview/: 看板图表、聚合与 KPI 原语的局部模块；局部地图见 `overview/CLAUDE.md`。
settings/: 财务设置面板按职责拆分；局部地图见 `settings/CLAUDE.md`。

法则: 审计可见性优先于视觉整洁；汇总只能使用未删除实体。四个页面的每一处 useApi 依赖都必须带上 Layout 的 `useRefreshSignal()`——财务页挂在 FinPageFrame 的二级 Outlet 下，`useOutletContext()` 在这里取到的是 undefined，顶栏「刷新数据」曾因此对整个财务侧完全无效。

[PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
