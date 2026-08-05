"""
[INPUT]: 依赖 time 领域的时钟、规则、存储、迁移、服务与路由模块。
[OUTPUT]: 将 time 标记为独立时间账本领域包。
[POS]: domains 的时间边界；不可导入 finance 的存储、服务或路由。
[PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
"""
