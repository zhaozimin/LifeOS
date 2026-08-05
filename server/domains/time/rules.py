"""
[INPUT]: 依赖 time.clock 的 UTC 分钟语义、time.constants 的性质集合及 core.errors.DomainError。
[OUTPUT]: 对外提供 I1–I4 时段校验、超长时段软判定、跨自然日拆分、空白覆盖与范围汇总。
[POS]: time 的不变量和统计层；service 在连接内调用校验，前端与 HTTP 不得各自复写时间算术。
[PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
"""

from __future__ import annotations

import json
import sqlite3
import unicodedata
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from typing import Any

from core.errors import DomainError
from domains.time.clock import (
    local_day_bounds_utc, local_minute_to_utc, now_as_utc, now_record_minute, parse_date,
    parse_utc_minute, utc_to_local_minute,
)
from domains.time.constants import NATURES, OVERLONG_SEGMENT_MINUTES


def minute_delta(start: datetime, end: datetime) -> int:
    return int((end - start).total_seconds() // 60)


def is_overlong_segment(gross_minutes: int | None) -> bool:
    """毛时间是否越过超长软标记线；全仓唯一与 OVERLONG_SEGMENT_MINUTES 的比较点。

    进行中时段没有毛时间（None），不能仅凭「已经跑了很久」在服务端判定为可疑：
    是否超时由前端用配置阈值 + 已过分钟自行判断，服务端只对既成事实的闭合时段表态。
    """
    return gross_minutes is not None and gross_minutes > OVERLONG_SEGMENT_MINUTES


def normalize_name(value: Any) -> str:
    return unicodedata.normalize("NFKC", str(value or "")).strip().casefold()


def value_of(item: Any, camel: str, snake: str | None = None, default: Any = None) -> Any:
    if isinstance(item, sqlite3.Row):
        key = snake or camel
        return item[key] if key in item.keys() else default
    if not isinstance(item, dict):
        return default
    return item[camel] if camel in item else item.get(snake or camel, default)


def category_of(item: Any) -> dict[str, str]:
    direct = value_of(item, "category", default=None)
    if isinstance(direct, dict):
        return {"name": str(direct.get("name") or "未归类"), "nature": str(direct.get("nature") or "support")}
    raw = value_of(item, "categoryJson", "category_json", None)
    if isinstance(raw, str) and raw:
        try:
            parsed = json.loads(raw)
            if isinstance(parsed, dict):
                return {"name": str(parsed.get("name") or "未归类"), "nature": str(parsed.get("nature") or "support")}
        except json.JSONDecodeError:
            pass
    return {"name": "未归类", "nature": "support"}


def conflict_shape(item: Any) -> dict[str, Any]:
    return {
        "id": value_of(item, "id"), "title": value_of(item, "title", default=""),
        "startedAt": value_of(item, "startedAt", "started_at"), "endedAt": value_of(item, "endedAt", "ended_at"),
    }


def item_utc(item: Any, prefix: str) -> datetime | None:
    utc_value = value_of(item, f"{prefix}Utc", f"{prefix}_utc")
    if utc_value:
        return parse_utc_minute(utc_value, f"{prefix}Utc")
    local_value = value_of(item, f"{prefix}At", f"{prefix}_at")
    return None if local_value is None else local_minute_to_utc(local_value, f"{prefix}At", legacy=True)


def validate_candidate(
    started_at: str, ended_at: str | None, deduction_minutes: int, existing: list[Any], *,
    now: datetime | None = None, exclude_id: str | None = None, started_utc: str | datetime | None = None,
    ended_utc: str | datetime | None = None, check_conflicts: bool = True, too_long_code: str = "too_long",
) -> None:
    """统一执行 I1–I4：唯一 open、不可重叠、时长有界、未来边界受限。"""
    current = now_as_utc(now)
    reference_now = now if now is not None and now.tzinfo is not None else now_record_minute()
    start = parse_utc_minute(started_utc, "startedUtc") if isinstance(started_utc, str) else (
        started_utc.astimezone(timezone.utc) if isinstance(started_utc, datetime)
        else local_minute_to_utc(started_at, "startedAt", reference_now=reference_now)
    )
    end = parse_utc_minute(ended_utc, "endedUtc") if isinstance(ended_utc, str) else (
        ended_utc.astimezone(timezone.utc) if isinstance(ended_utc, datetime) else (
            local_minute_to_utc(ended_at, "endedAt", reference_now=reference_now) if ended_at is not None else None
        )
    )
    if start > current:
        raise DomainError("future_timestamp", "startedAt 不能晚于当前分钟。")
    if end is not None and end > current and not (start == current and end == current + timedelta(minutes=1)):
        raise DomainError("future_timestamp", "endedAt 只能是同分钟开始时段的当前分钟 + 1。")
    if end is not None:
        if end <= start:
            raise DomainError("invalid_range", "endedAt 必须严格晚于 startedAt。")
        gross = minute_delta(start, end)
        if gross > 1440:
            extra = {"suggestedEndedAt": utc_to_local_minute(start + timedelta(minutes=1440))} if too_long_code == "open_segment_too_long" else {}
            raise DomainError(too_long_code, "单个时段的毛时间不能超过 1440 分钟。", **extra)
        if deduction_minutes < 0 or deduction_minutes > gross:
            raise DomainError("deduction_out_of_range", "扣除分钟必须位于 0 与毛时间之间。")
    elif deduction_minutes != 0:
        raise DomainError("deduction_out_of_range", "进行中时段的扣除必须为 0。")
    if not check_conflicts:
        return
    active = [item for item in existing if value_of(item, "id") != exclude_id and not value_of(item, "deletedAt", "deleted_at")]
    if end is None:
        open_items = [item for item in active if value_of(item, "endedAt", "ended_at") is None]
        if open_items:
            raise DomainError("open_segment_exists", "已有进行中时段。", conflicts=[conflict_shape(item) for item in open_items])
    conflicts = []
    for item in active:
        other_start, other_end = item_utc(item, "started"), item_utc(item, "ended")
        if other_start is not None and (end is None or other_start < end) and (other_end is None or start < other_end):
            conflicts.append(conflict_shape(item))
    if conflicts:
        raise DomainError("overlap", "时段与已有记录重叠。", conflicts=conflicts)


def split_segment_by_day(item: Any, now: datetime | None = None, *, window_start: datetime | None = None, window_end: datetime | None = None) -> list[dict[str, Any]]:
    from domains.time.clock import record_timezone
    zone, _ = record_timezone()
    current = now_as_utc(now)
    start = item_utc(item, "started")
    raw_end = value_of(item, "endedAt", "ended_at")
    end = item_utc(item, "ended") if raw_end else current
    if start is None or end is None or end <= start:
        return []
    total_gross = minute_delta(start, end)
    total_deduction = 0 if raw_end is None else int(value_of(item, "deductionMinutes", "deduction_minutes", 0) or 0)
    visible_start = max(start, now_as_utc(window_start)) if window_start is not None else start
    visible_end = min(end, now_as_utc(window_end)) if window_end is not None else end
    if visible_end <= visible_start:
        return []
    pieces, cursor = [], visible_start
    while cursor < visible_end:
        boundary = local_day_bounds_utc(cursor.astimezone(zone).date(), zone)[1]
        piece_end = min(boundary, visible_end)
        gross_before, gross_through = minute_delta(start, cursor), minute_delta(start, piece_end)
        deduction = round(total_deduction * gross_through / total_gross) - round(total_deduction * gross_before / total_gross)
        pieces.append({
            "id": value_of(item, "id"), "date": cursor.astimezone(zone).date().isoformat(),
            "start": utc_to_local_minute(cursor, zone), "end": utc_to_local_minute(piece_end, zone),
            "grossMinutes": minute_delta(cursor, piece_end), "deductionMinutes": deduction,
            "pureMinutes": minute_delta(cursor, piece_end) - deduction, "category": category_of(item),
            "projectName": value_of(item, "projectName", "project_name"),
        })
        cursor = piece_end
    return pieces


def _coverage_window(day: date, now: datetime) -> tuple[datetime, datetime]:
    from domains.time.clock import record_timezone
    zone, _ = record_timezone()
    start, next_start = local_day_bounds_utc(day, zone)
    current, current_day = now_as_utc(now), now_as_utc(now).astimezone(zone).date()
    return (start, next_start) if day < current_day else (start, max(start, current)) if day == current_day else (start, start)


def compute_day_coverage(items: list[Any], day_value: str, now: datetime | None = None) -> dict[str, Any]:
    from domains.time.clock import record_timezone
    zone, _ = record_timezone()
    current, day = now_as_utc(now), parse_date(day_value)
    window_start, window_end = _coverage_window(day, current)
    intervals, open_item = [], None
    for item in items:
        if value_of(item, "deletedAt", "deleted_at"):
            continue
        start, raw_end = item_utc(item, "started"), value_of(item, "endedAt", "ended_at")
        end = item_utc(item, "ended") if raw_end else current
        if start is None or end is None:
            continue
        clipped = max(start, window_start), min(end, window_end)
        if clipped[0] < clipped[1]:
            intervals.append(clipped)
        if raw_end is None and (start < window_end or (day == current.astimezone(zone).date() and start == current)) and current >= window_start:
            open_item = item
    merged: list[list[datetime]] = []
    for start, end in sorted(intervals):
        if not merged or start > merged[-1][1]:
            merged.append([start, end])
        else:
            merged[-1][1] = max(merged[-1][1], end)
    recorded, gaps, cursor = sum(minute_delta(start, end) for start, end in merged), [], window_start
    for start, end in merged:
        if cursor < start:
            gaps.append({"start": utc_to_local_minute(cursor, zone), "end": utc_to_local_minute(start, zone), "minutes": minute_delta(cursor, start)})
        cursor = max(cursor, end)
    if cursor < window_end:
        gaps.append({"start": utc_to_local_minute(cursor, zone), "end": utc_to_local_minute(window_end, zone), "minutes": minute_delta(cursor, window_end)})
    denominator = minute_delta(window_start, window_end)
    open_payload = None
    if open_item is not None:
        start = item_utc(open_item, "started")
        open_payload = {"id": value_of(open_item, "id"), "title": value_of(open_item, "title", default=""), "startedAt": value_of(open_item, "startedAt", "started_at"), "ageMinutes": max(0, minute_delta(start, current))}
    return {"date": day.isoformat(), "gaps": gaps, "recordedMinutes": recorded, "gapMinutes": denominator - recorded, "coverage": round(recorded / denominator, 3) if denominator else 0.0, "denominatorMinutes": denominator, "openSegment": open_payload}


def summarize_range(items: list[Any], from_value: str, to_value: str, now: datetime | None = None) -> dict[str, Any]:
    from domains.time.clock import record_timezone
    zone, _ = record_timezone()
    current = now_as_utc(now)
    start_day, end_day = parse_date(from_value, "from"), parse_date(to_value, "to")
    if end_day < start_day:
        raise DomainError("invalid_range", "to 必须不早于 from。")
    if (end_day - start_day).days > 3660:
        raise DomainError("too_long", "统计区间不能超过 3661 天。")
    day_names = [(start_day + timedelta(days=index)).isoformat() for index in range((end_day - start_day).days + 1)]
    window_start, window_end = local_day_bounds_utc(start_day, zone)[0], local_day_bounds_utc(end_day, zone)[1]
    pieces, day_buckets = [], {name: [] for name in day_names}
    for item in items:
        if value_of(item, "deletedAt", "deleted_at"):
            continue
        item_pieces = split_segment_by_day(item, current, window_start=window_start, window_end=window_end)
        pieces.extend(item_pieces)
        for name in {piece["date"] for piece in item_pieces}:
            if name in day_buckets:
                day_buckets[name].append(item)
    natures = {nature: {"nature": nature, "grossMinutes": 0, "pureMinutes": 0} for nature in NATURES}
    categories, projects, category_ids, project_ids = {}, {}, defaultdict(set), defaultdict(set)
    effective = gross_work = deductions = 0
    day_effective, day_gross = defaultdict(int), defaultdict(int)
    for piece in pieces:
        nature = piece["category"]["nature"] if piece["category"]["nature"] in NATURES else "support"
        name, gross, pure = piece["category"]["name"], piece["grossMinutes"], piece["pureMinutes"]
        natures[nature]["grossMinutes"] += gross; natures[nature]["pureMinutes"] += pure
        target = categories.setdefault((name, nature), {"name": name, "nature": nature, "grossMinutes": 0, "pureMinutes": 0, "segmentCount": 0})
        target["grossMinutes"] += gross; target["pureMinutes"] += pure; category_ids[(name, nature)].add(str(piece["id"]))
        if piece.get("projectName"):
            project = projects.setdefault(piece["projectName"], {"projectName": piece["projectName"], "grossMinutes": 0, "pureMinutes": 0, "segmentCount": 0})
            project["grossMinutes"] += gross; project["pureMinutes"] += pure; project_ids[piece["projectName"]].add(str(piece["id"]))
        if nature == "core": effective += pure; day_effective[piece["date"]] += pure
        if nature in {"core", "support"}: gross_work += gross; day_gross[piece["date"]] += gross
        deductions += piece["deductionMinutes"]
    for key, target in categories.items(): target["segmentCount"] = len(category_ids[key])
    for key, target in projects.items(): target["segmentCount"] = len(project_ids[key])
    days, denominator, recorded, gaps = [], 0, 0, 0
    for name in day_names:
        coverage = compute_day_coverage(day_buckets[name], name, current)
        denominator += coverage["denominatorMinutes"]; recorded += coverage["recordedMinutes"]; gaps += coverage["gapMinutes"]
        days.append({"date": name, "effectiveWorkMinutes": day_effective[name], "grossMinutes": day_gross[name], "recordedMinutes": coverage["recordedMinutes"], "gapMinutes": coverage["gapMinutes"], "coverage": coverage["coverage"], "partial": name == current.astimezone(zone).date().isoformat()})
    return {"from": start_day.isoformat(), "to": end_day.isoformat(), "byNature": [natures[nature] for nature in NATURES], "byCategory": sorted(categories.values(), key=lambda row: (-row["grossMinutes"], row["name"])), "byProject": sorted(projects.values(), key=lambda row: (-row["grossMinutes"], row["projectName"])), "effectiveWorkMinutes": effective, "grossWorkMinutes": gross_work, "recordedMinutes": recorded, "gapMinutes": gaps, "deductionMinutes": deductions, "coverage": round(recorded / denominator, 3) if denominator else 0.0, "days": days}
