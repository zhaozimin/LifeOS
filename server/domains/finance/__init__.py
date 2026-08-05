"""
[INPUT]: 依赖 finance 领域的算法、存储、服务与读写路由模块。
[OUTPUT]: 将 finance 标记为独立财务账本领域包。
[POS]: domains 的财务边界；不可导入 time 的存储、服务或路由。
[PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
"""
