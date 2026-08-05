"""
[INPUT]: 依赖同级 core 模块的安全、HTTP 与持久化原语。
[OUTPUT]: 将 core 标记为共享基础设施包。
[POS]: server 的无业务基础层；time 与 finance 只能经此层复用通用能力。
[PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
"""
