"""
[INPUT]: 依赖 runtime/config.json 的私密连接配置及 pathlib 的原子替换能力。
[OUTPUT]: 对外提供 fail-closed 的 load_config 与 0600 原子 write_config。
[POS]: core 的连接性与安全配置边界；领域设置不得写入此文件。
[PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
"""

from __future__ import annotations

import json
import os
import stat
from pathlib import Path
from typing import Any, Mapping


DEFAULT_PORT = 59418
PLACEHOLDER_TOKENS = {"", "<token_urlsafe(32)>", "<部署时生成>", "CHANGE_ME"}


def load_config(config_path: Path) -> dict[str, Any]:
    """读取并验证唯一连接配置；任何不安全值都在监听前失败。"""
    if not config_path.is_file():
        raise RuntimeError(f"缺少配置文件：{config_path}。请由安装器生成 accessToken。")
    try:
        payload = json.loads(config_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise RuntimeError(f"无法读取有效配置：{config_path}。") from exc
    if not isinstance(payload, dict):
        raise RuntimeError("runtime/config.json 顶层必须是 JSON 对象。")

    raw_token = payload.get("accessToken")
    if not isinstance(raw_token, str):
        raise RuntimeError("runtime/config.json 的 accessToken 必须是字符串。")
    token = raw_token.strip()
    if token != raw_token or token in PLACEHOLDER_TOKENS:
        raise RuntimeError("accessToken 缺失、为占位符或含首尾空白，拒绝启动。")

    host = payload.get("host", "127.0.0.1")
    if host != "127.0.0.1":
        raise RuntimeError("LifeOS 只允许监听 127.0.0.1；跨设备请使用 tailscale serve。")
    port = payload.get("port", DEFAULT_PORT)
    if isinstance(port, bool) or not isinstance(port, int) or not 1 <= port <= 65535:
        raise RuntimeError("runtime/config.json 的 port 必须是 1..65535 的整数。")
    allowed_hosts = payload.get("allowedHosts", [])
    if not isinstance(allowed_hosts, list) or any(
        not isinstance(item, str) or not item or item.strip() != item for item in allowed_hosts
    ):
        raise RuntimeError("allowedHosts 必须是非空、无首尾空白的主机名数组。")
    timezone = payload.get("timezone", "")
    timezone_source = payload.get("timezoneSource", "system")
    if not isinstance(timezone, str) or not isinstance(timezone_source, str):
        raise RuntimeError("timezone 与 timezoneSource 必须是字符串。")

    try:
        mode = stat.S_IMODE(config_path.stat().st_mode)
    except OSError as exc:
        raise RuntimeError(f"无法检查配置文件权限：{config_path}。") from exc
    if mode & 0o077:
        raise RuntimeError("runtime/config.json 权限必须为 0600，拒绝暴露访问密钥。")
    return {
        "host": host,
        "port": port,
        "accessToken": token,
        "allowedHosts": allowed_hosts,
        "timezone": timezone,
        "timezoneSource": timezone_source,
    }


def write_config(config_path: Path, payload: Mapping[str, Any]) -> None:
    """以同目录临时文件替换配置，避免半写入时进程读取到截断 JSON。"""
    config_path.parent.mkdir(parents=True, exist_ok=True)
    temporary = config_path.with_name(f".{config_path.name}.{os.getpid()}.tmp")
    try:
        temporary.write_text(json.dumps(dict(payload), ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        os.chmod(temporary, 0o600)
        temporary.replace(config_path)
    finally:
        temporary.unlink(missing_ok=True)
