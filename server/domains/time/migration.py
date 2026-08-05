"""
[INPUT]: 依赖 time.sqlite3 的 UTC 锚点、clock 的 DST 安全换算和 rules 的 I1–I4 校验。
[OUTPUT]: 对外提供历史时区 convert/preserve 的无副作用迁移计划与执行前校验。
[POS]: time 的历史语义迁移边界；service 在同一账本事务中应用计划，绝不猜测 DST 或修改审计发生时间。
[PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
"""

from __future__ import annotations

import sqlite3
from datetime import datetime
from typing import Any

from core.errors import DomainError
from domains.time.clock import (
    format_utc_minute,
    local_minute_to_utc,
    resolve_record_timezone,
    utc_to_local_minute,
)
from domains.time.rules import item_utc, validate_candidate


def conversion_timezone(configured: str, resolved_timezone: str | None = None) -> tuple[Any, str]:
    """将配置意图解析为可安全解释历史分钟的具体 IANA 时区。"""
    zone, _effective, _source, concrete_name = resolve_record_timezone(configured, resolved_timezone)
    return zone, concrete_name


def plan_timezone_conversion(
    connection: sqlite3.Connection,
    _source_configured: str,
    target_configured: str,
    target_resolved_timezone: str | None = None,
) -> list[tuple[str, str, str | None]]:
    """换算历史显示分钟，保留每条记录的绝对 UTC 事实。"""
    target_zone, _target_name = conversion_timezone(target_configured, target_resolved_timezone)
    rows = connection.execute("SELECT * FROM segments ORDER BY started_at, created_at").fetchall()
    converted_rows: list[dict[str, Any]] = []
    updates: list[tuple[str, str, str | None]] = []
    for row in rows:
        converted = dict(row)
        started_utc = item_utc(row, "started")
        ended_utc = item_utc(row, "ended")
        if started_utc is None:
            raise DomainError("timezone_conversion_conflict", "历史时段缺少绝对开始时间，不能安全换算。", status=409)
        converted["started_at"] = utc_to_local_minute(started_utc, target_zone)
        converted["ended_at"] = utc_to_local_minute(ended_utc, target_zone) if ended_utc else None
        converted_rows.append(converted)
        if converted["started_at"] != row["started_at"] or converted["ended_at"] != row["ended_at"]:
            updates.append((str(row["id"]), converted["started_at"], converted["ended_at"]))

    target_now = datetime.now(target_zone).replace(second=0, microsecond=0)
    try:
        for row in converted_rows:
            validate_candidate(
                row["started_at"], row["ended_at"], int(row.get("deduction_minutes") or 0),
                converted_rows, now=target_now, exclude_id=str(row["id"]),
                started_utc=row.get("started_utc"), ended_utc=row.get("ended_utc"),
                check_conflicts=not bool(row.get("deleted_at")),
            )
    except DomainError as exc:
        raise DomainError(
            "timezone_conversion_conflict",
            f"历史时段换算后无法满足时间账约束（{exc.message}）；请选择保留原显示时间。",
            status=409,
            cause=exc.code,
        ) from exc
    return updates


def plan_timezone_preservation(
    connection: sqlite3.Connection,
    target_configured: str,
    target_resolved_timezone: str | None = None,
) -> list[tuple[str, str, str | None]]:
    """保留钟面字符串，重新锚定 UTC；DST 缺证据时直接拒绝。"""
    target_zone, target_name = conversion_timezone(target_configured, target_resolved_timezone)
    rows = connection.execute("SELECT * FROM segments ORDER BY started_at, created_at").fetchall()
    anchored_rows: list[dict[str, Any]] = []
    updates: list[tuple[str, str, str | None]] = []
    try:
        for row in rows:
            anchored = dict(row)
            started_utc = format_utc_minute(
                local_minute_to_utc(row["started_at"], "startedAt", zone=target_zone, zone_name=target_name)
            )
            ended_utc = (
                format_utc_minute(
                    local_minute_to_utc(row["ended_at"], "endedAt", zone=target_zone, zone_name=target_name)
                )
                if row["ended_at"]
                else None
            )
            anchored.update({"started_utc": started_utc, "ended_utc": ended_utc})
            anchored_rows.append(anchored)
            if started_utc != row["started_utc"] or ended_utc != row["ended_utc"]:
                updates.append((str(row["id"]), started_utc, ended_utc))

        target_now = datetime.now(target_zone).replace(second=0, microsecond=0)
        for row in anchored_rows:
            validate_candidate(
                row["started_at"], row["ended_at"], int(row.get("deduction_minutes") or 0),
                anchored_rows, now=target_now, exclude_id=str(row["id"]),
                started_utc=row["started_utc"], ended_utc=row["ended_utc"],
                check_conflicts=not bool(row.get("deleted_at")),
            )
    except DomainError as exc:
        raise DomainError(
            "timezone_conversion_conflict",
            f"保留钟面时间后无法满足时间账约束（{exc.message}）。",
            status=409,
            cause=exc.code,
        ) from exc
    return updates
