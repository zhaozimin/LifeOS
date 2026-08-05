"""
[INPUT]: 依赖 zoneinfo、TZ 环境变量与 /etc/localtime 的 IANA 名称，以及 runtime/config.json 冻结的 timezone/resolvedTimezone。
[OUTPUT]: 对外提供进程级冻结的记录时区（configure_record_timezone / record_timezone / record_timezone_state）、
          系统时区探测与两种当前时刻（utc_now_iso 机器时刻、now_record_iso 用户墙钟时刻）。
[POS]: core 的记录时区真源；时间与财务两域都从这里取得同一个「用户认为的现在」，
       任何一域自行解释系统时区都会让两本账本的日界脱钩。这里不理解任何领域业务字段，
       只把 config.json 里的一个 IANA 名称固化成进程内唯一的时区事实。
[PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
"""

from __future__ import annotations

import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError


# 记录时区在进程启动时冻结一次，此后不再随系统时区漂移：
# 用户在飞机上落地换区，不该让昨天的账本重新解释成另一个日界。
RECORD_ZONE: Any | None = None
EFFECTIVE_TIMEZONE = "system"
TIMEZONE_SOURCE = "system"
RESOLVED_TIMEZONE = ""


def utc_now_iso() -> str:
    """机器时刻：审计、created_at、updated_at 用，永远带 +00:00，不参与用户日界。"""
    return datetime.now(timezone.utc).isoformat()


def now_record_iso() -> str:
    """用户墙钟时刻：任何会被用户读作「几点」的字段都必须用它。

    与 utc_now_iso 的区别不是格式而是语义——同一瞬间，前者答「机器记了什么」，
    后者答「用户当时看表是几点」。财务的 occurredAt 属于后者：
    北京 19:43 买的奶茶，账本上写 11:43 就是错的，哪怕它指向同一个瞬间。
    """
    return datetime.now(record_timezone()[0]).isoformat()


def system_timezone_for_conversion() -> tuple[ZoneInfo, str]:
    """解析 IANA 名称；固定偏移不能安全还原 DST 历史。"""
    candidates = []
    environment_timezone = str(os.environ.get("TZ") or "").strip().lstrip(":")
    if environment_timezone and not environment_timezone.startswith("/"):
        candidates.append(environment_timezone)
    for localtime_path in (Path("/etc/localtime"), Path("/var/db/timezone/zoneinfo")):
        try:
            resolved = str(localtime_path.resolve(strict=True))
        except OSError:
            continue
        marker = "/zoneinfo/"
        if marker in resolved:
            candidates.append(resolved.split(marker, 1)[1])
    for candidate in candidates:
        try:
            zone = ZoneInfo(candidate)
            return zone, zone.key
        except (ValueError, ZoneInfoNotFoundError):
            continue
    fallback = datetime.now().astimezone().tzinfo
    fallback_key = getattr(fallback, "key", None)
    if isinstance(fallback_key, str) and fallback_key:
        try:
            return ZoneInfo(fallback_key), fallback_key
        except (ValueError, ZoneInfoNotFoundError):
            pass
    raise RuntimeError("无法识别系统 IANA 时区；请在 runtime/config.json 中明确填写 timezone。")


def resolve_record_timezone(value: Any, resolved_timezone: str | None = None) -> tuple[Any, str, str, str]:
    configured = str(value or "").strip()
    if not configured:
        if resolved_timezone:
            try:
                zone = ZoneInfo(resolved_timezone)
            except (ValueError, ZoneInfoNotFoundError) as exc:
                raise RuntimeError(f"记录时区冻结状态无效：{resolved_timezone}。") from exc
            return zone, "system", "system", resolved_timezone
        zone, concrete_name = system_timezone_for_conversion()
        return zone, "system", "system", concrete_name
    try:
        zone = ZoneInfo(configured)
    except (ValueError, ZoneInfoNotFoundError) as exc:
        raise RuntimeError("timezone 无效；请填写 IANA 时区，例如 Asia/Shanghai。") from exc
    return zone, configured, "config", configured


def configure_record_timezone(value: Any, resolved_timezone: str | None = None) -> str:
    global RECORD_ZONE, EFFECTIVE_TIMEZONE, TIMEZONE_SOURCE, RESOLVED_TIMEZONE
    RECORD_ZONE, EFFECTIVE_TIMEZONE, TIMEZONE_SOURCE, RESOLVED_TIMEZONE = resolve_record_timezone(
        value, resolved_timezone
    )
    return EFFECTIVE_TIMEZONE


def current_system_timezone_name() -> str | None:
    try:
        return system_timezone_for_conversion()[1]
    except RuntimeError:
        return None


def record_timezone() -> tuple[Any, str]:
    if RECORD_ZONE is None:
        configure_record_timezone("")
    return RECORD_ZONE, RESOLVED_TIMEZONE


def record_timezone_state() -> dict[str, str]:
    """冻结后的时区三元组，供配置投影使用。

    必须经本函数读取：`from core.clock import EFFECTIVE_TIMEZONE` 会把值绑死在导入那一刻，
    而 configure_record_timezone 是在启动过程中才跑的，绑早了就永远是 "system"。
    """
    if RECORD_ZONE is None:
        configure_record_timezone("")
    return {
        "timezone": EFFECTIVE_TIMEZONE,
        "timezoneSource": TIMEZONE_SOURCE,
        "resolvedTimezone": RESOLVED_TIMEZONE,
    }
