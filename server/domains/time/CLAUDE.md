# domains/time/
> L2 | 父级: ../CLAUDE.md

成员清单
constants.py: 时间前缀、I1–I4 枚举、请求白名单、时区历史迁移模式与超长软标记阈值 OVERLONG_SEGMENT_MINUTES 的单一真源。
clock.py（时区原语已上移 core.clock，本模块只转出）: 冻结 IANA 时区、UTC/本地分钟投影、DST 多解拒绝与自然日绝对边界；不重新读取系统时区解释历史。「这一天的 00:00 是几点」只有 `local_minute_boundary_utc` 一个答案——日界与只读筛选窗口都从它取，午夜跳变的时区（America/Santiago、America/Havana）在切换日降级到「这一自然日真正开始的那一瞬」，与面板 lib/timeline.ts 同口径；写入路径另走 `local_minute_to_utc` 的 409 拒绝，两者语义相反、不可互换。`ensure_projectable_date` 是墙钟进入本域的可表示范围闸门：本域收墙钟、发 UTC 瞬间，两者的可表示区间差着一个时区偏移加一天，贴着 datetime 两端的日期换算必然越界，因此在解析处就明确 4xx 拒绝，不让 OverflowError 冒到 httpd 兜成 500。
rules.py: I1–I4、重叠、跨自然日拆分、覆盖率和统计汇总；所有区间比较以 UTC 锚点为准。`is_overlong_segment` 是全域唯一与超长阈值比较的地方，它只软标记不拒绝，1440 分钟硬闸仍在 `validate_candidate` 内独立生效。
store.py: time.sqlite3 行到 API 投影（含调用 rules 得出的 overlong 软标记，进行中时段恒为 false）、主数据解析与按绝对开始时间排序的本账本读取原语。
migration.py: convert 保留 UTC/换钟面、preserve 保留钟面/重锚 UTC 的无副作用计划器；先验证全量约束再由 service 原子应用。
service.py: schema/旧库 UTC 补写与拓扑拒绝、时段和主数据事务服务（创建与改名两条路径都拒绝重名）、时区状态协调；`list_segments` 的 from/to 是**只读窗口**而非写入时刻，分钟形式走 `local_minute_boundary_utc` 与 gaps/summary 共用一套日界，日期形式的 to 取当天终点；`configuration` 把超长阈值随配置下发给面板，前端因此不必自带阈值；时段新增、修改、自动收尾与删除都完整追加 before/after 版本并生成本账本检查点，reconcile 整批只留最终快照，因为事务中间态从未存在；提交后的快照失败降级为回执警告。
routes.py: 时间域 `/v1/time/*` 的 13 条声明式 HTTP 契约（公共 `GET /v1/health` 由 core 持有），并由该契约驱动装配 handler；筛选查询和 JSON 形状只在此层转换。
interop.py: 面向未来交叉视图的只读 projects_summary 内核；P1 平移，不暴露 HTTP。

法则：time.sqlite3 是唯一时间真源。记录时区由 runtime_state 双键冻结；任何请求不能把系统时区变化静默写进历史数据。

[PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
