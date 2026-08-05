"""
[INPUT]: 依赖 ~/.config/lifeos/install.json 或隔离 LIFEOS_INSTALL_PATH 指向的 LifeOS runtime/config.json。
[OUTPUT]: 对外提供域前缀白名单、禁代理/重定向的 Bearer 请求和明确拒绝/结果未知两类异常。
[POS]: Skill 的唯一网络边界；timectl/finctl 只能经此层调用回环 LifeOS，Token 不会离开进程。它不依赖任何时间或财务纯函数。
[PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any


SHARED_READONLY = {("GET", "/v1/health")}


class LifeOSHTTPError(RuntimeError):
    def __init__(self, status: int, payload: dict[str, Any]) -> None:
        super().__init__(payload.get("message", f"HTTP {status}"))
        self.status, self.payload = status, payload


class LifeOSTransportError(RuntimeError):
    """写入是否已提交未知；调用者必须先只读核查。"""


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *_args: Any, **_kwargs: Any) -> None:
        return None


@dataclass(frozen=True)
class Connection:
    root: Path
    port: int
    token: str


def _installation_root() -> Path:
    pointer = Path.home() / ".config" / "lifeos" / "install.json"
    if pointer.is_file():
        try:
            payload = json.loads(pointer.read_text(encoding="utf-8"))
            candidate = payload.get("installPath")
        except (OSError, json.JSONDecodeError) as exc:
            raise LifeOSTransportError("LifeOS 安装指针无效。") from exc
        if isinstance(candidate, str) and candidate:
            return Path(candidate)
        raise LifeOSTransportError("LifeOS 安装指针缺少 installPath。")
    candidate = os.environ.get("LIFEOS_INSTALL_PATH", "")
    if candidate:
        return Path(candidate)
    legacy = [Path.home() / ".config" / name / "install.json" for name in ("timeos", "finos", "finance-node-openclaw")]
    if any(path.exists() for path in legacy):
        raise LifeOSTransportError("检测到旧系统指针；请按 LifeOS 部署协议迁移，禁止静默沿用。")
    raise LifeOSTransportError("未找到 LifeOS 安装；请先部署或在隔离演练中设置 LIFEOS_INSTALL_PATH。")


def connection() -> Connection:
    root = _installation_root().resolve()
    config_path = root / "server" / "runtime" / "config.json"
    try:
        config = json.loads(config_path.read_text(encoding="utf-8"))
        token, port = config["accessToken"], config["port"]
    except (OSError, KeyError, TypeError, json.JSONDecodeError) as exc:
        raise LifeOSTransportError("LifeOS 连接配置无效。") from exc
    if not isinstance(token, str) or not token or not isinstance(port, int) or not 1 <= port <= 65535:
        raise LifeOSTransportError("LifeOS 连接配置缺少有效 Token 或端口。")
    return Connection(root, port, token)


def request_api(method: str, path: str, *, domain: str, payload: dict[str, Any] | None = None) -> Any:
    method = method.upper()
    prefix = f"/v1/{domain}/"
    if method == "GET" and (method, path) not in SHARED_READONLY and not path.startswith(prefix):
        raise LifeOSTransportError(f"{domain} 只读请求越过域前缀，已在本地拒绝。")
    if method != "GET" and not path.startswith(prefix):
        raise LifeOSTransportError(f"{domain} 写请求越过域前缀，已在本地拒绝。")
    active = connection()
    body = None if payload is None else json.dumps(payload, ensure_ascii=False).encode("utf-8")
    request = urllib.request.Request(f"http://127.0.0.1:{active.port}{path}", data=body, method=method, headers={"Authorization": f"Bearer {active.token}", "Content-Type": "application/json"})
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirect())
    try:
        with opener.open(request, timeout=15) as response:
            if 300 <= response.status < 400: raise LifeOSTransportError("已拒绝重定向，以保护访问密钥。")
            raw = response.read()
    except urllib.error.HTTPError as exc:
        raw = exc.read()
        try: parsed = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError): parsed = {"message": f"HTTP {exc.code}"}
        if 400 <= exc.code < 500: raise LifeOSHTTPError(exc.code, parsed) from exc
        raise LifeOSTransportError("服务端失败，写入结果未知；禁止重试，请先只读核查。") from exc
    except (OSError, urllib.error.URLError) as exc:
        raise LifeOSTransportError("连接失败，写入结果未知；禁止重试，请先只读核查。") from exc
    try:
        parsed = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise LifeOSTransportError("回执无效，写入结果未知；禁止重试，请先只读核查。") from exc
    # 读取端点可合法返回数组（例如 transactions）；写入端点仍由调用方以对象回执消费。
    if not isinstance(parsed, (dict, list)):
        raise LifeOSTransportError("回执不是 JSON 对象或数组，写入结果未知。")
    return parsed


def request_write_api(method: str, path: str, *, domain: str, payload: dict[str, Any]) -> dict[str, Any]:
    """把写操作的结果未知纪律固定在唯一传输层，ctl 不得绕过。"""
    if method.upper() == "GET": raise LifeOSTransportError("写入接口不接受 GET。")
    return request_api(method, path, domain=domain, payload=payload)
