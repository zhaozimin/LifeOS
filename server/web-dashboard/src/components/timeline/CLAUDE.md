# timeline/
> L2 | 父级: ../CLAUDE.md

成员清单
TimelineEvent.tsx: 日/周时间轴共享的领域事项适配器；把 UTC 真实 duration 与墙钟起止、标题、备注、选中状态和可选控制柄投射到设计系统 EventFrame，空间不足时隐藏低优先级信息；超长软标记由调用方判定后经 overlong 传入，只前置进既有 meta 行，绝不改动色块与时长。
DayTimeline.tsx: 单日 24h 墙钟编排；消费记录时区与 UTC 当前瞬间，按 23px 阈值组织细节栏，普通日保留五档缩放与调时，DST 切换日显示真实时长并明确停用拖拽；超长软标记由 lib/timeline 的 isSegmentOverlong 统一判定（已闭合采信服务端 overlong，进行中用 configuration 下发的 overlongSegmentMinutes 与已过分钟补判），本层只把同一份 OVERLONG_SEGMENT_LABEL 分发给事项、细节标签与分布块提示。
WeekTimeline.tsx: 一周共享墙钟日历；按记录时区 UTC 日界把跨日时段裁剪进七列，显示真实 gross 与折叠片段保守几何，不在高密七列中启用细节栏和直接调时。
useTimelineSegmentInteraction.ts: 单日时间块手势状态机；先消费 DST 直接调时安全判定，普通日让整屏和五档共享选择、双击、长按平移、端点拖动及 UTC 同步预览，非单射日只保留设置入口。

[PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
