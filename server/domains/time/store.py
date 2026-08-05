"""
[INPUT]: 依赖已初始化的 time.sqlite3 连接、时间域 JSON 持久化格式与 rules 的超长软判定。
[OUTPUT]: 对外提供时段行投影（含 overlong 软标记）、主数据解析和只读时段读取原语。
[POS]: time 的持久化适配层；service 在一个连接内组合这些函数以保持复合操作原子性。
[PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
"""

from __future__ import annotations

import json
import sqlite3
from typing import Any

from core.errors import DomainError
from domains.time.rules import is_overlong_segment, normalize_name


def segment_from_row(row: sqlite3.Row) -> dict[str, Any]:
    started_utc, ended_utc = row["started_utc"], row["ended_utc"]
    gross = None
    if started_utc and ended_utc:
        from domains.time.clock import parse_utc_minute
        gross = int((parse_utc_minute(ended_utc) - parse_utc_minute(started_utc)).total_seconds() // 60)
    deduction = int(row["deduction_minutes"] or 0)
    return {
        "id": row["id"], "title": row["title"], "category": json.loads(row["category_json"] or "{}"),
        "projectName": row["project_name"], "startedAt": row["started_at"], "endedAt": row["ended_at"],
        "startedUtc": started_utc, "endedUtc": ended_utc,
        "deductionMinutes": deduction, "deductionNote": row["deduction_note"],
        "tags": json.loads(row["tags_json"] or "[]"), "note": row["note"], "source": row["source"],
        "createdAt": row["created_at"], "updatedAt": row["updated_at"], "deletedAt": row["deleted_at"],
        "deletedBy": row["deleted_by"], "deletionReason": row["deletion_reason"], "autoClosedBy": row["auto_closed_by"],
        "grossMinutes": gross, "pureMinutes": gross - deduction if gross is not None else None,
        "overlong": is_overlong_segment(gross),
    }


def fetch_segments(connection: sqlite3.Connection, *, include_deleted: bool = False) -> list[dict[str, Any]]:
    query = "SELECT * FROM segments" + ("" if include_deleted else " WHERE deleted_at IS NULL") + " ORDER BY started_utc,created_at"
    return [segment_from_row(row) for row in connection.execute(query).fetchall()]


def get_segment(connection: sqlite3.Connection, segment_id: str) -> dict[str, Any]:
    row = connection.execute("SELECT * FROM segments WHERE id=? AND deleted_at IS NULL", (segment_id,)).fetchone()
    if row is None:
        raise DomainError("not_found", "时段不存在。", status=404)
    return segment_from_row(row)


def load_master(connection: sqlite3.Connection, table: str, *, include_deleted: bool = False) -> list[dict[str, Any]]:
    rows = connection.execute(f"SELECT id,payload_json,sort_order FROM {table} ORDER BY sort_order,id").fetchall()
    items = []
    for row in rows:
        payload = json.loads(row["payload_json"])
        payload["id"] = row["id"]
        if include_deleted or not payload.get("deletedAt"):
            items.append(payload)
    return items


def resolve_master(connection: sqlite3.Connection, table: str, name: Any, error_code: str) -> dict[str, Any]:
    candidate = normalize_name(name)
    result = next((item for item in load_master(connection, table) if normalize_name(item.get("name")) == candidate), None)
    if result is None:
        raise DomainError(error_code, f"未找到主数据：{name}。", status=422)
    return result
