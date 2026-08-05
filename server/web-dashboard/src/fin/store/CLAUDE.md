# store/

> L2 | 父级: ../CLAUDE.md

成员清单

timeRange.ts: 财务三页共享的时间区间真源（zustand + persist，键 finance-time-range/version 3）；只存 dimension 与不透明区间键 bucket，键的编解码归 fin/lib/timeRange。同时导出 reconcileBucket——bucket 跨会话持久化，因此完全可能指向账本里已不存在的区间（那个月的流水被软删、或换了账本），归一规则是「显示哪个区间就用哪个区间过滤」这条不变式的落点，由持有可选桶列表的 TimeRangePicker 写回，页面只读不算。all/custom 的键不由桶列表管辖，归一必须原样放行，否则会抹掉用户选定的日历区间。
dashboardLayout.ts: 看板 widget 的显隐与顺序（persist）；DEFAULT_ORDER 是 widget 清单真源，读取时与默认表求并集——旧存档里没有的新 widget 自动补到末尾并可见，已下线的 id 被丢弃，因此加 widget 不需要写迁移。
view.ts: 公司/个人/合并三视角（persist，键 finance-view）；仅 ViewSwitcher 消费，页面自持的视图态（如 FlowPage 的 flowView）不进这里。
theme.ts: 向根 store/theme 的兼容再导出，不持有任何状态；存在的唯一理由是挡住迁入页面另起一个 finance-theme 主题源。

法则: 只放跨页面且需要跨会话记忆的状态；单页视图态留在页面里。持久化状态可能与当前账本脱节，读取方必须能把失效值归一，而不是照单全收。

[PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
