"""
[INPUT]: 无运行时依赖。
[OUTPUT]: 对外提供时间域前缀、I1–I4 枚举、请求白名单与超长时段软标记阈值。
[POS]: time 的不变量真源；P1 迁入 TimeOS 常量，避免散落到 handler。
[PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
"""

API_PREFIX = "/v1/time"
NATURES = ("core", "support", "recovery", "leisure")
# 软标记阈值：毛时间超过 8 小时的已闭合时段视为「可疑 · 超长未闭合」，只提示不拒绝。
# 与 rules.validate_candidate 里 1440 分钟的硬拒绝闸是两件事，后者仍然是唯一的写入闸门。
OVERLONG_SEGMENT_MINUTES = 480
SOURCES = ("agent", "manual", "import")
TIMEZONE_HISTORY_MODES = ("convert", "preserve")
SEGMENT_CREATE_FIELDS = frozenset({
    "title", "categoryName", "expectedNature", "projectName", "startedAt", "endedAt",
    "deductionMinutes", "deductionNote", "tags", "note", "source",
})
SEGMENT_UPDATE_FIELDS = SEGMENT_CREATE_FIELDS - {"source"}
SEGMENT_STOP_FIELDS = frozenset({"endedAt", "deductionMinutes", "deductionNote"})
SEGMENT_DELETE_FIELDS = frozenset({"reason", "operator", "revertAutoClose"})
