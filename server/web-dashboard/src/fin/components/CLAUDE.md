# components/

> L2 | 父级: ../CLAUDE.md

成员清单

TransactionEditSheet.tsx: 交易新增/编辑弹层，MVP 只保存当前一笔明确交易且不提供「另存为周期规则」；同时是报销流程第一、二步（记垫付、收回款）的入口。
TransactionDrawer.tsx: 交易列表抽屉，饼图/看板钻取的通用容器。
FinTimeRangeBar.tsx: 财务页面自持的日期范围控制条；仅通过回调把选择结果交给页面，避免路由壳读取流水。
FinCalendarDrawer.tsx: 时间范围的日历抽屉；与 FinTimeRangeBar 协作完成日期选择。
FinSearchPalette.tsx: 仅在用户主动打开时加载整本账的财务检索命令面板；不参与应用壳的首屏请求。
ReimbursementPieCard.tsx: 报销进度扇形图，消费 lib/reimbursement 的状态语义。
ReimbursementPill.tsx: 报销状态行内原语（是否报销双按钮 ReimbursementActions/展示 Tag/核销入口），状态→图标/文案的唯一事实源；rejected 统一叫「已驳回」（非终态，可二次报销仍计入待回款）；遵守 StatusPill 对比度铁律。
ReimbursementSettleSheet.tsx: 回款核销对账抽屉，报销流程第三步——勾选一笔回款覆盖的垫付并批量核销/撤销。
AdjustmentHistoryDrawer.tsx: 余额调整全历史抽屉；不传 limit，确保早期对账证据可追溯。
AttachmentLightbox.tsx: 附件预览与删除灯箱。
GlobalSearchPalette.tsx: 迁入财务域的通用搜索命令面板原型；新统一入口由 FinSearchPalette 承担。
DashboardCustomizer.tsx: 看板 widget 显隐与排序定制。
BudgetProgressCard.tsx / SavingsGoalCard.tsx / CashflowForecastCard.tsx / SubscriptionsCard.tsx: 看板业务卡片（预算/储蓄目标/现金流预测/订阅）。
InvoiceWorkbench.tsx: 发票工作台，dual 模式的开票追踪。
ProjectPLDrawer.tsx: 项目损益抽屉；不传 limit 读取项目全历史，避免早期成本/收入从图表消失。
TimeRangePicker.tsx / ViewSwitcher.tsx: 迁入财务页面的兼容型时间区间与视图切换控件。可选桶在 TimeRangePicker 里推导，因此「显示的区间必须就是过滤用的区间」也由它闭合：归一后的桶同步写回 store（桶列表为空时不写，避免在流水到达前抹掉用户的选择），页面只读 store——只算不写会让下拉写着一个月份、页面按另一个月份汇总，看板一片 ¥0 且随 persist 跨会话驻留。
charts/: EChart 壳、主题语义色与桑基/旭日/柱/线/环形阈值等图表实现。
ui/: 财务域仅存的两个分叉原语（AlertDialog/Autocomplete）；其余原语已并入共享 `src/components/ui/`，本目录不再是 UI 基础层的入口。

法则: 业务组件消费 lib 的领域判定，不得私造状态语义；UI 原语默认从共享 `src/components/ui/` 导入，只有本目录列出的两个分叉件例外；弹层统一走 Modal（z-80），确认/通知一律用 ui/AlertDialog（z-95），全站禁用原生 confirm/alert；滚动锁只走 useBodyScrollLock，禁止裸操 body.style。

[PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
