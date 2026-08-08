"""
[INPUT]: 依赖 core.httpd 的声明式 Route/Request/Response 和 time.service 的单账本领域操作。
[OUTPUT]: 对外提供时间域完整 ROUTES 契约，修改历史默认完整返回，以及由契约驱动装配 `/v1/time/*`
           handler 的 build_routes；契约与实现漂移即启动失败。
[POS]: time API 的唯一端点真源；timectl 和前端 time API 都必须按此表对拍，不存在 `/v1/clock`。
[PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
"""

from __future__ import annotations

from typing import Any, Final
from urllib.parse import parse_qs

from core.errors import DomainError
from core.httpd import Request, Response, Route, routes_from_contract
from core.sqlite import Ledger
from core.validation import read_json_object
from domains.time import service


ROUTES: Final[tuple[tuple[str, str], ...]] = (
    ("GET", "/v1/time/configuration"), ("PUT", "/v1/time/configuration"),
    ("GET", "/v1/time/segments"), ("POST", "/v1/time/segments"),
    ("POST", "/v1/time/segments/reconcile"), ("POST", "/v1/time/segments/{id}/stop"),
    ("PUT", "/v1/time/segments/{id}"), ("DELETE", "/v1/time/segments/{id}"),
    ("GET", "/v1/time/summary/range"), ("GET", "/v1/time/gaps"),
    ("GET", "/v1/time/habits"), ("POST", "/v1/time/agent/operations"),
    ("GET", "/v1/time/audit/events"),
)


def _query(request: Request) -> dict[str, list[str]]:
    return parse_qs(request.query, keep_blank_values=True)


def _first(query: dict[str, list[str]], key: str) -> str | None:
    return query.get(key, [None])[0]


def _body(request: Request) -> dict[str, Any]:
    """沿用 TimeOS：没有请求体等同空对象，字段校验仍由领域服务执行。"""
    return read_json_object(request.body) if request.body else {}


def build_routes(ledger: Ledger, config: dict[str, Any]) -> tuple[Route, ...]:
    def configuration(request: Request) -> Response:
        return Response.json(200, service.configuration(ledger, config))

    def update_configuration(request: Request) -> Response:
        return Response.json(200, service.update_configuration(ledger, config, _body(request)))

    def segments(request: Request) -> Response:
        return Response.json(200, service.list_segments(ledger, _query(request)))

    def create(request: Request) -> Response:
        return Response.json(201, service.create_segment(ledger, _body(request)))

    def reconcile(request: Request) -> Response:
        return Response.json(200, service.reconcile_segments(ledger, _body(request)))

    def stop(request: Request) -> Response:
        return Response.json(200, service.stop_segment(ledger, request.params["id"], _body(request)))

    def update(request: Request) -> Response:
        return Response.json(200, service.update_segment(ledger, request.params["id"], _body(request)))

    def delete(request: Request) -> Response:
        return Response.json(200, service.delete_segment(ledger, request.params["id"], _body(request)))

    def summary(request: Request) -> Response:
        query = _query(request)
        from_value, to_value = _first(query, "from"), _first(query, "to")
        if not from_value or not to_value: raise DomainError("invalid_range", "summary/range 需要 from 与 to 日期。")
        return Response.json(200, service.summary(ledger, from_value, to_value))

    def gaps(request: Request) -> Response:
        date_value = _first(_query(request), "date")
        if not date_value: raise DomainError("invalid_range", "gaps 需要 date。")
        result = service.gaps(ledger, date_value)
        result.pop("denominatorMinutes", None)
        return Response.json(200, result)

    def habits(request: Request) -> Response:
        return Response.json(200, service.habits(ledger, _first(_query(request), "q") or ""))

    def agent_operation(request: Request) -> Response:
        return Response.json(200, service.agent_operation(ledger, _body(request)))

    def audit_events(request: Request) -> Response:
        raw_limit = _first(_query(request), "limit")
        try: limit = int(raw_limit) if raw_limit is not None else None
        except ValueError: limit = None
        return Response.json(200, service.audit_events(ledger, limit))  # type: ignore[arg-type]

    handlers = {
        ("GET", "/v1/time/configuration"): configuration,
        ("PUT", "/v1/time/configuration"): update_configuration,
        ("GET", "/v1/time/segments"): segments,
        ("POST", "/v1/time/segments"): create,
        ("POST", "/v1/time/segments/reconcile"): reconcile,
        ("POST", "/v1/time/segments/{id}/stop"): stop,
        ("PUT", "/v1/time/segments/{id}"): update,
        ("DELETE", "/v1/time/segments/{id}"): delete,
        ("GET", "/v1/time/summary/range"): summary,
        ("GET", "/v1/time/gaps"): gaps,
        ("GET", "/v1/time/habits"): habits,
        ("POST", "/v1/time/agent/operations"): agent_operation,
        ("GET", "/v1/time/audit/events"): audit_events,
    }
    return routes_from_contract(ROUTES, handlers)
