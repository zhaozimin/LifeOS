"""
[INPUT]: 依赖 HTTP 请求体长度、JSON 负载与各领域声明的字段白名单。
[OUTPUT]: 对外提供按调用方上限解析的 JSON 对象读取、未知字段拒绝与基础类型校验函数。
[POS]: core 的输入面收口；领域 service 负责业务语义，本模块只负责形状和资源上限。
[PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
"""

from __future__ import annotations

import json
from typing import Any, Iterable

from core.errors import DomainError


MAX_JSON_BODY_BYTES = 1024 * 1024


def read_json_object(raw_body: bytes, limit: int = MAX_JSON_BODY_BYTES) -> dict[str, Any]:
    """limit 必须由调用方按路由传入，否则附件与账单导入会被这道闸二次卡死。

    传输层已经按 Route.max_body_bytes 拦过一次；这里保留同名检查是纵深防御，
    但它绝不能成为一个**覆盖不到**的第二上限——附件路由放宽了传输层却卡在这里，
    正是「service 层写着 10MB、用户连 1MB 都传不上去」的直接原因。
    """
    if len(raw_body) > limit:
        raise DomainError("payload_too_large", f"请求体超过本端点 {limit // 1024} KB 上限。", status=413)
    try:
        payload = json.loads(raw_body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise DomainError("invalid_json", "请求体必须是有效 UTF-8 JSON。", status=400) from exc
    if not isinstance(payload, dict):
        raise DomainError("invalid_request", "请求体顶层必须是 JSON 对象。", status=400)
    return payload


def reject_unknown_fields(payload: dict[str, Any], allowed: Iterable[str], label: str) -> None:
    unknown = sorted(set(payload) - set(allowed))
    if unknown:
        raise DomainError(
            "invalid_request", f"{label} 含未知字段：{', '.join(unknown)}。", status=400, fields=unknown
        )


def int_field(payload: dict[str, Any], name: str, *, required: bool = False) -> int | None:
    value = payload.get(name)
    if value is None:
        if required:
            raise DomainError("invalid_request", f"{name} 为必填整数。", status=400)
        return None
    if isinstance(value, bool) or not isinstance(value, int):
        raise DomainError("invalid_request", f"{name} 必须是整数。", status=400)
    return value
