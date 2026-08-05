# lib/
> L2 | 父级: ../CLAUDE.md

成员清单
autocomplete.ts: 可搜索组合框的无 DOM 索引规则；打开时保持当前有效项，搜索时回退到首个非禁用项。
dates.ts: 以非空 resolvedTimezone 选择服务端确定的投影 IANA，缺失时硬失败；nullable currentSystemTimezone 仅在可用时与冻结值比较，以识别 system 来源 blank→blank 的显式重新采用动作。本模块产出的 Date 一律是「墙钟载体」——记录时区的年月日时分被放进 UTC 槽位，只许经 getUTC* 读回，它不代表绝对时刻；载体曾建在浏览器本地时区上，而本地处于 DST 缺失小时时那个墙钟值根本不可表示，Date 自动前跳一小时，业务分钟整体晚 60 分钟（时刻线错位、blankDraft 预填被服务端 future_timestamp 拒绝）。日历原语 addDays/rangeForWeek/rangeForMonth 与 isoDate/isoMinute 同建在 UTC 槽位上，只改一半会让 UTC+14 的用户整体错开一天。
export.ts: 数据主权纯函数；按 offset/limit 全量收集含软删除时段，以白名单保留非空 resolvedTimezone、nullable currentSystemTimezone 与 UTC 锚点，并拒绝残缺分页。
nature.ts: 四类 nature 的固定顺序、中文标签、跨亮暗锁色相的语义/源令牌、CSS/画布颜色解析与校验色相数学；业务色不再依赖图表系列下标。
timeline.ts: 日/周视图共享的 UTC/墙钟分层；只接受服务端 resolvedTimezone 具体 IANA，用 UTC 锚点、真实日界和累计差值计算 gross/pure 与扣除，DST 折叠片段保守投影并输出调时安全判定；午夜前跳的时区（America/Santiago、Asia/Beirut 等）当天 00:00 并不存在，日界解析改由二分降级到「这一天真正开始的那一瞬」而非抛错——本层被日/周页在 render 期直接调用，抛错即白屏，因此「不抛错」是硬契约；超长软标记的判定与文案也收在这里（isSegmentOverlong / OVERLONG_SEGMENT_LABEL），已闭合时段只采信服务端 overlong，进行中时段才用 configuration 下发的阈值补判——前端不设第二个比较点。
timelineInteraction.ts: 时间轴交互分钟数学真源；保持五级缩放数组稳定，并把表现层整屏选择解析为实测视口密度，在半开日界与相邻边界内完成吸附、边缘调整、整段等长移动和冲突预检。
timelineCallouts.ts: 短时段可读性纯函数；与 CSS 的 23px 极薄阈值同源，计算细节标签锚点、消重、下界回推与拥挤退化，不依赖 DOM。
useBodyScrollLock.ts: Modal 与移动侧栏共享的 body 滚动锁 hook。

主题注册表已迁至 `../theme/`，避免把色板数据与通用纯函数混放。

[PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
