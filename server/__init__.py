"""
[INPUT]: 无运行时依赖。
[OUTPUT]: 将 server 标记为 LifeOS 可导入服务包。
[POS]: 服务端根包；供入口、测试与隔离子进程通过稳定模块路径加载。
[PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
"""
