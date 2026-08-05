"""
[INPUT]: 接收领域或 HTTP 边界提供的错误码、消息、状态码与结构化上下文。
[OUTPUT]: 对外提供 DomainError 及其稳定 JSON 投影。
[POS]: core 的错误规范；所有 API 错误从此处收敛，调用方无需知道领域内部异常类型。
[PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
"""

from __future__ import annotations

from typing import Any


class DomainError(RuntimeError):
    """可安全投影到 HTTP 的预期失败。"""

    def __init__(self, code: str, message: str, status: int = 422, **extra: Any) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status
        self.extra = extra

    def payload(self) -> dict[str, Any]:
        return {"error": self.code, "message": self.message, **self.extra}
