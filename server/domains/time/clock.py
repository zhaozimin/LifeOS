"""
[INPUT]: 依赖 core.clock 冻结的记录时区真源、zoneinfo 与 core.errors.DomainError。
[OUTPUT]: 对外提供本地分钟/UTC 转换、写入路径的 DST 歧义拒绝、只读窗口边界的 DST 降级
          （local_minute_boundary_utc）、自然日 UTC 边界、可投影日期闸门（ensure_projectable_date），
          并转出 core.clock 的时区原语供本域沿用。
[POS]: time 的钟表语义层：只负责「分钟」这一粒度的语义（整分、DST 歧义、日界、可表示范围）。
       「这一天的 00:00 是几点」在本模块只有一个答案：local_minute_boundary_utc，
       日界与只读筛选窗口都从它取；写入路径另走 local_minute_to_utc 的 409 拒绝，两者不可互换。
       记录时区本身不归本域所有——它是 config.json 的事实，由 core.clock 冻结，财务域取的是同一份；
       本域若自行解释系统时区，两本账本的日界就会脱钩。
[PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
"""

from __future__ import annotations

import re
from datetime import date, datetime, time, timedelta, timezone
from typing import Any

from core.clock import (
    configure_record_timezone,
    current_system_timezone_name,
    now_record_iso,
    record_timezone,
    record_timezone_state,
    resolve_record_timezone,
    system_timezone_for_conversion,
    utc_now_iso,
)
from core.errors import DomainError

__all__ = [  # 时区原语在 core.clock，本模块只转出，不复制实现
    "configure_record_timezone", "current_system_timezone_name", "now_record_iso",
    "record_timezone", "record_timezone_state", "resolve_record_timezone",
    "system_timezone_for_conversion", "utc_now_iso",
]

MINUTE_PATTERN = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$")
DATE_PATTERN = re.compile(r"^\d{4}-\d{2}-\d{2}$")

# 本域的输入词汇是「墙钟」，输出词汇是「UTC 瞬间」，两者的可表示区间并不重合：
# 换算最多把一个瞬间推移一个时区偏移（历史极值近 16 小时），日界还要再往后取一天。
# 因此贴着 date/datetime 两端两天以内的日期，无论怎么算都会撞上 datetime 的边界。
# 这个约束此前从未被说出口，越界输入就一路走到 astimezone 里抛 OverflowError，
# 被 httpd 的兜底捕成 500——但服务器什么都没坏，是客户端给了一个无法投影成 UTC 的日期。
# 说出来一次，放在墙钟进入本域的唯一入口上，它就永远是一次明确的 4xx 拒绝。
PROJECTION_MARGIN = timedelta(days=2)


def ensure_projectable_date(value: date, field: str = "date") -> date:
    """拒绝无法安全投影成 UTC 瞬间的日期；返回值原样透传，便于在 parse 链上直接使用。"""
    if not date.min + PROJECTION_MARGIN <= value <= date.max - PROJECTION_MARGIN:
        raise DomainError("invalid_range", f"{field} 超出可换算成 UTC 的日期范围。", field=field, value=value.isoformat())
    return value


def parse_minute(value: Any, field: str = "timestamp") -> datetime:
    if not isinstance(value, str) or not MINUTE_PATTERN.fullmatch(value):
        raise DomainError("invalid_range", f"{field} 必须是 YYYY-MM-DDTHH:MM 格式。")
    try:
        parsed = datetime.strptime(value, "%Y-%m-%dT%H:%M")
    except ValueError as exc:
        raise DomainError("invalid_range", f"{field} 不是有效的本地分钟时间。") from exc
    ensure_projectable_date(parsed.date(), field)
    return parsed


def parse_date(value: Any, field: str = "date") -> date:
    if not isinstance(value, str) or not DATE_PATTERN.fullmatch(value):
        raise DomainError("invalid_range", f"{field} 必须是 YYYY-MM-DD 格式。")
    try:
        parsed = date.fromisoformat(value)
    except ValueError as exc:
        raise DomainError("invalid_range", f"{field} 不是有效日期。") from exc
    return ensure_projectable_date(parsed, field)


def format_minute(value: datetime) -> str:
    return value.strftime("%Y-%m-%dT%H:%M")


def format_utc_minute(value: datetime) -> str:
    return value.astimezone(timezone.utc).replace(second=0, microsecond=0).isoformat()


def parse_utc_minute(value: Any, field: str = "utcTimestamp") -> datetime:
    if not isinstance(value, str):
        raise DomainError("invalid_range", f"{field} 不是有效的 UTC 分钟。")
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError as exc:
        raise DomainError("invalid_range", f"{field} 不是有效的 UTC 分钟。") from exc
    if parsed.tzinfo is None:
        raise DomainError("invalid_range", f"{field} 必须携带 UTC 偏移。")
    return parsed.astimezone(timezone.utc).replace(second=0, microsecond=0)


def local_minute_candidates(value: datetime, zone: Any) -> list[datetime]:
    candidates: dict[str, datetime] = {}
    for fold in (0, 1):
        aware = value.replace(tzinfo=zone, fold=fold)
        round_trip = aware.astimezone(timezone.utc).astimezone(zone).replace(tzinfo=None)
        if round_trip == value:
            candidates[aware.astimezone(timezone.utc).isoformat()] = aware
    return sorted(candidates.values(), key=lambda item: item.astimezone(timezone.utc))


def localize_unambiguous(value: datetime, zone: Any, zone_name: str) -> datetime:
    candidates = local_minute_candidates(value, zone)
    if not candidates:
        raise DomainError("timezone_conversion_ambiguous", f"{format_minute(value)} 在 {zone_name} 中不存在。", status=409)
    if len(candidates) > 1:
        raise DomainError("timezone_conversion_ambiguous", f"{format_minute(value)} 在 {zone_name} 中有两个可能时刻。", status=409)
    return candidates[0]


def local_minute_to_utc(
    value: str,
    field: str,
    *,
    zone: Any | None = None,
    zone_name: str | None = None,
    reference_now: datetime | None = None,
    legacy: bool = False,
) -> datetime:
    if zone is None:
        zone, default_name = record_timezone()
        zone_name = zone_name or default_name
    else:
        zone_name = zone_name or str(zone)
    local_value = parse_minute(value, field)
    candidates = local_minute_candidates(local_value, zone)
    if len(candidates) == 1:
        return candidates[0].astimezone(timezone.utc)
    if len(candidates) > 1 and reference_now is not None:
        reference = reference_now.astimezone(zone).replace(second=0, microsecond=0)
        if reference.replace(tzinfo=None) == local_value:
            reference_utc = reference.astimezone(timezone.utc)
            matching = next((item for item in candidates if item.astimezone(timezone.utc) == reference_utc), None)
            if matching is not None:
                return matching.astimezone(timezone.utc)
    if legacy:
        if candidates:
            return candidates[0].astimezone(timezone.utc)
        return local_value.replace(tzinfo=zone, fold=0).astimezone(timezone.utc)
    qualifier = "不存在" if not candidates else "有两个可能时刻"
    raise DomainError(
        "invalid_local_minute", f"{field}={value} 在 {zone_name} 中{qualifier}。", status=409,
        field=field, timezone=zone_name, value=value,
    )


def utc_to_local_minute(value: datetime, zone: Any | None = None) -> str:
    return format_minute(value.astimezone(zone or record_timezone()[0]).replace(tzinfo=None))


def now_record_minute() -> datetime:
    return datetime.now(record_timezone()[0]).replace(second=0, microsecond=0)


def now_local_minute() -> datetime:
    return now_record_minute().replace(tzinfo=None)


def now_as_utc(now: datetime | None = None) -> datetime:
    if now is None:
        return now_record_minute().astimezone(timezone.utc)
    if now.tzinfo is not None:
        return now.astimezone(timezone.utc).replace(second=0, microsecond=0)
    return local_minute_to_utc(format_minute(now), "now", legacy=True)


def local_minute_boundary_utc(value: datetime, zone: Any | None = None) -> datetime:
    """只读窗口边界的本地分钟 → UTC 投影：永不因 DST 拒绝。

    与 local_minute_to_utc 的分歧是语义而非实现。写入路径上一个不存在或二义的分钟
    意味着用户记错了时刻，必须 409 让他重说；而读取窗口上的同一个分钟只是
    「从哪一瞬开始看」，降级到一个确定的瞬间不会污染任何数据。
    二义取最早候选（这一自然日的第一次 00:00），不存在则取「这一自然日真正开始的那一瞬」。
    面板 lib/timeline.ts 对同一族问题已是同一口径，服务端与它必须只有一个答案。
    """
    target_zone = zone or record_timezone()[0]
    candidates = local_minute_candidates(value, target_zone)
    if candidates:
        return candidates[0].astimezone(timezone.utc)
    return value.replace(tzinfo=target_zone, fold=0).astimezone(timezone.utc)


def local_day_bounds_utc(day: date, zone: Any | None = None) -> tuple[datetime, datetime]:
    target_zone = zone or record_timezone()[0]
    ensure_projectable_date(day)
    return (
        local_minute_boundary_utc(datetime.combine(day, time.min), target_zone),
        local_minute_boundary_utc(datetime.combine(day + timedelta(days=1), time.min), target_zone),
    )


def convert_local_minute(value: str, source_zone: Any, source_name: str, target_zone: Any, target_name: str) -> str:
    source = localize_unambiguous(parse_minute(value), source_zone, source_name)
    target = source.astimezone(target_zone).replace(tzinfo=None)
    localize_unambiguous(target, target_zone, target_name)
    return format_minute(target)
