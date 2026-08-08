"""
[INPUT]: 依赖已验证配置、领域健康投影、Ledger 身份与静态资源根。
[OUTPUT]: 对外提供 ThreadingHTTPServer、结构化 API 响应、健康端点与不可覆盖的防嵌入安全头；
           routes_from_contract 按域 ROUTES 装配路由，Route 自带请求体上限，
           回环 Host/Bearer 构成边界，未预期异常留痕到 stderr。
[POS]: core 的唯一 HTTP 边界；领域只能暴露 handler，不得自行创建服务器或绕过认证。
[PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
"""

from __future__ import annotations

import hmac
import json
import os
import re
import sys
import traceback
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Callable, Mapping
from urllib.parse import urlsplit

from core.errors import DomainError
from core.sqlite import Ledger
from core.static_files import StaticFiles


Handler = Callable[["Request"], "Response"]
SHARED_READONLY = frozenset({("GET", "/v1/health")})
DEFAULT_MAX_BODY_BYTES = 1024 * 1024
# 回环语义的两种等价写法。TimeOS 蓝本的 Host 正则同时接受二者且大小写不敏感
# （timeos_node_server.py:1399），收窄成只认 127.0.0.1 会让 localhost 书签直接吃 403。
LOOPBACK_HOSTS = frozenset({"127.0.0.1", "localhost"})


@dataclass(frozen=True)
class Request:
    method: str
    path: str
    query: str
    params: Mapping[str, str]
    headers: Mapping[str, str]
    app: "Application"
    body: bytes = b""
    # 本路由声明的请求体上限，供 read_json_object 复用；
    # 否则 core.validation 里那道同名检查会变成一个覆盖不到的第二上限。
    max_body_bytes: int = DEFAULT_MAX_BODY_BYTES


@dataclass(frozen=True)
class Response:
    status: int
    body: bytes = b""
    headers: Mapping[str, str] = field(default_factory=dict)

    @classmethod
    def json(cls, status: int, payload: Mapping[str, Any]) -> "Response":
        return cls(
            status=status,
            body=json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8"),
            headers={"Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store"},
        )


@dataclass(frozen=True)
class Route:
    method: str
    pattern: str
    handler: Handler
    # 请求体上限按路由声明：附件与账单导入天然比 JSON 表单大一个量级，
    # 全局 1MB 会把它们变成永远够不到的死功能，而放开全局又等于取消防线。
    max_body_bytes: int = DEFAULT_MAX_BODY_BYTES

    def match(self, method: str, path: str) -> re.Match[str] | None:
        if method != self.method:
            return None
        expression = "^" + re.sub(r"\{([a-zA-Z][a-zA-Z0-9_]*)\}", r"(?P<\1>[^/]+)", self.pattern) + "$"
        return re.match(expression, path)


@dataclass
class Application:
    config: Mapping[str, Any]
    build_id: str
    version: str
    web_root: Any
    time_ledger: Ledger
    finance_ledger: Ledger
    time_health: Callable[[], Mapping[str, Any]]
    finance_health: Callable[[], Mapping[str, Any]]
    routes: list[Route] = field(default_factory=list)

    def __post_init__(self) -> None:
        self.static_files = StaticFiles(self.web_root)

    def register(self, *routes: Route) -> None:
        signatures = {(route.method, route.pattern) for route in self.routes}
        for route in routes:
            signature = (route.method, route.pattern)
            if signature in signatures:
                raise RuntimeError(f"重复路由：{route.method} {route.pattern}")
            self.routes.append(route)
            signatures.add(signature)


_HEADER_FORBIDDEN = ("\r", "\n", "\0")
_SECURITY_HEADERS = (
    ("Content-Security-Policy", "frame-ancestors 'none'"),
    ("X-Frame-Options", "DENY"),
    ("X-Content-Type-Options", "nosniff"),
)
_SECURITY_HEADER_NAMES = frozenset(name.lower() for name, _ in _SECURITY_HEADERS)


def _assert_sendable_header(name: str, value: str) -> None:
    """头写出前的最后一道闸：不可编码或含控制字符一律在发送前失败。

    这里必须抛在 _send 写出任何字节之前——一旦状态行已经进了 socket，
    再失败就只能产出「一个响应里两个状态码」的畸形字节流，而客户端会采信第一个。
    """
    for text in (name, value):
        if any(bad in text for bad in _HEADER_FORBIDDEN):
            raise DomainError("invalid_header", f"响应头 {name} 含控制字符。", status=500)
    try:
        f"{name}: {value}".encode("latin-1")
    except UnicodeEncodeError as exc:
        raise DomainError(
            "invalid_header",
            f"响应头 {name} 含非 Latin-1 字符，必须先按 RFC 6266 编码。",
            status=500,
        ) from exc


def routes_from_contract(
    contract: tuple[tuple[str, str], ...],
    handlers: Mapping[tuple[str, str], Handler],
    body_limits: Mapping[tuple[str, str], int] | None = None,
) -> tuple[Route, ...]:
    """按域的 ROUTES 契约表装配运行路由。

    设计 2.1 把 ROUTES 定为全系统唯一路由真源，但此前 build_routes 是在同一个
    文件里把同一张表又手抄一遍——两处一旦漂移没有任何东西会报警。改由契约驱动
    装配之后，少一条 handler 或多一条 handler 都会在启动时直接拒绝监听。
    """
    missing = [signature for signature in contract if signature not in handlers]
    if missing:
        raise RuntimeError(f"ROUTES 契约缺少 handler：{missing}")
    undeclared = [signature for signature in handlers if signature not in contract]
    if undeclared:
        raise RuntimeError(f"handler 未在 ROUTES 契约中声明：{undeclared}")
    limits = body_limits or {}
    return tuple(
        Route(method, pattern, handlers[(method, pattern)], limits.get((method, pattern), DEFAULT_MAX_BODY_BYTES))
        for method, pattern in contract
    )


def health_handler(request: Request) -> Response:
    app = request.app
    return Response.json(
        200,
        {
            "status": "ok",
            "version": app.version,
            "buildId": app.build_id,
            "port": app.config["port"],
            "pid": os.getpid(),
            "domains": {"time": app.time_health(), "finance": app.finance_health()},
        },
    )


class LifeOSRequestHandler(BaseHTTPRequestHandler):
    server_version = "LifeOS/0.1"

    @property
    def app(self) -> Application:
        return self.server.app  # type: ignore[attr-defined]

    def do_GET(self) -> None:
        self._run()

    def do_POST(self) -> None:
        self._run()

    def do_PUT(self) -> None:
        self._run()

    def do_PATCH(self) -> None:
        self._run()

    def do_DELETE(self) -> None:
        self._run()

    def _run(self) -> None:
        parsed = urlsplit(self.path)
        try:
            self._assert_allowed_host()
            if self.command == "GET" and not parsed.path.startswith("/v1/"):
                if parsed.path == "/":
                    self._send(Response(302, headers={"Location": "/dashboard/"}))
                    return
                static = self.app.static_files.resolve(parsed.path, "gzip" in self.headers.get("Accept-Encoding", ""))
                if static is not None:
                    self._send(Response(200, static.body, {
                        "Content-Type": static.content_type,
                        "Cache-Control": static.cache_control,
                        **({"Content-Encoding": static.content_encoding} if static.content_encoding else {}),
                    }))
                    return
            self._authenticate()
            for route in self.app.routes:
                match = route.match(self.command, parsed.path)
                if match is not None:
                    body = self._read_body(route.max_body_bytes)
                    request = Request(
                        self.command, parsed.path, parsed.query, match.groupdict(),
                        self.headers, self.app, body, route.max_body_bytes,
                    )
                    self._send(route.handler(request))
                    return
            raise DomainError(
                "not_found",
                "未找到 API；时间端点使用 /v1/time/*，财务端点使用 /v1/fin/*。",
                status=404,
            )
        except DomainError as exc:
            self._send(Response.json(exc.status, exc.payload()))
        except Exception:
            # 裸 500 不留痕等于把故障现场一起丢掉。只打方法与路径，
            # query 与 Authorization 一律不进日志，避免 Token 随异常外泄。
            print(f"[LifeOS] 未预期异常 {self.command} {parsed.path}", file=sys.stderr, flush=True)
            traceback.print_exc(file=sys.stderr)
            self._send(Response.json(500, {"error": "internal_error", "message": "服务器内部错误。"}))

    def _read_body(self, limit: int = DEFAULT_MAX_BODY_BYTES) -> bytes:
        raw_length = self.headers.get("Content-Length", "0")
        try:
            length = int(raw_length)
        except ValueError as exc:
            raise DomainError("invalid_request", "Content-Length 必须是整数。", status=400) from exc
        if length < 0 or length > limit:
            raise DomainError(
                "payload_too_large", f"请求体超过本端点 {limit // 1024} KB 上限。", status=413
            )
        return self.rfile.read(length) if length else b""

    def _assert_allowed_host(self) -> None:
        raw_host = self.headers.get("Host", "")
        host = raw_host.rsplit(":", 1)[0] if raw_host.count(":") == 1 else raw_host
        if host.lower() in LOOPBACK_HOSTS:
            return
        if host not in self.app.config["allowedHosts"]:
            raise DomainError("forbidden_host", "Host 不在 LifeOS 白名单中。", status=403)

    def _authenticate(self) -> None:
        authorization = self.headers.get("Authorization", "")
        prefix = "Bearer "
        if not authorization.startswith(prefix):
            raise DomainError("unauthorized", "需要 Bearer accessToken。", status=401)
        received = authorization[len(prefix):]
        if not hmac.compare_digest(received, self.app.config["accessToken"]):
            raise DomainError("unauthorized", "accessToken 无效。", status=401)

    def _send(self, response: Response) -> None:
        # 头值必须在写出第一个字节之前全部校验通过。
        # http.server 用 latin-1 编码响应头：一个中文附件名会让 send_header 在
        # 状态行与部分头已经进 socket 之后抛异常，外层 except 再发一遍 500，
        # 网线上就成了「200 OK + Content-Type: application/pdf」后面紧跟「500」——
        # 客户端读到 200 与正确的 Content-Type，body 却是错误 JSON，前端没有任何察觉机会。
        # CRLF 同理：注入的换行会提前终结头块，把其后的安全头全部挤进响应体。
        # 防嵌入策略是 HTTP 边界的不变量，不允许领域响应以同名头覆盖或削弱。
        # CSP frame-ancestors 是现代浏览器的标准防线；X-Frame-Options 为旧浏览器兜底。
        headers = tuple(
            (name, value)
            for name, value in response.headers.items()
            if name.lower() not in _SECURITY_HEADER_NAMES
        ) + _SECURITY_HEADERS
        for name, value in headers:
            _assert_sendable_header(name, value)

        self._last_status = response.status
        self.send_response(response.status)
        for name, value in headers:
            self.send_header(name, value)
        self.send_header("Content-Length", str(len(response.body)))
        self.end_headers()
        if response.body:
            self.wfile.write(response.body)

    def log_message(self, _format: str, *_args: Any) -> None:
        """不记录 query 或 Authorization，避免 Token 经普通访问日志外泄。"""
        parsed = urlsplit(self.path)
        print(f"[LifeOS] {self.command} {parsed.path} -> {getattr(self, '_last_status', '-')}", flush=True)


def create_server(app: Application) -> ThreadingHTTPServer:
    server = ThreadingHTTPServer((app.config["host"], app.config["port"]), LifeOSRequestHandler)
    server.app = app  # type: ignore[attr-defined]
    return server
