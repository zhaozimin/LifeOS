"""
[INPUT]: 依赖 time Ledger、冻结时区 clock、core 审计与 SQLite 连接；接收根配置的记录时区意图。
[OUTPUT]: 对外提供旧 TimeOS 账本迁移、时区恢复、时段与主数据事务、统计投影，以及无数量上限的不可覆盖前后版本和数据库检查点。
[POS]: time 的应用服务层；在 HTTP 监听前建立时间语义和数据库同构，并将所有时段写路径收口到同一版本链。
[PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
"""

from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timedelta, timezone
from typing import Any
from uuid import uuid4

from core.audit import (
    append_audit_event, append_record_revision, checkpoint_after_commit, checkpoint_database,
    ensure_audit_schema,
)
from core.config import write_config
from core.errors import DomainError
from core.sqlite import Ledger
from core.validation import int_field, reject_unknown_fields
from domains.time import clock
from domains.time.clock import (
    configure_record_timezone, current_system_timezone_name, format_utc_minute, local_minute_candidates,
    local_day_bounds_utc, local_minute_boundary_utc, local_minute_to_utc, parse_date, parse_minute, parse_utc_minute,
    record_timezone, resolve_record_timezone, utc_now_iso, utc_to_local_minute,
)
from domains.time.constants import (
    NATURES, OVERLONG_SEGMENT_MINUTES, SEGMENT_CREATE_FIELDS, SEGMENT_UPDATE_FIELDS, SOURCES,
    TIMEZONE_HISTORY_MODES,
)
from domains.time.migration import plan_timezone_conversion, plan_timezone_preservation
from domains.time.rules import (
    compute_day_coverage, conflict_shape, item_utc, normalize_name, summarize_range,
    validate_candidate,
)
from domains.time.store import fetch_segments, get_segment, load_master, resolve_master, segment_from_row


def default_categories() -> list[dict[str, Any]]:
    return [
        {"id": "category-dev", "name": "开发", "nature": "core", "keywords": ["代码", "编程", "写码", "调试", "开发"], "builtin": True},
        {"id": "category-writing", "name": "写作", "nature": "core", "keywords": ["写作", "文章", "文稿", "脚本", "写稿"], "builtin": True},
        {"id": "category-research", "name": "学习研究", "nature": "core", "keywords": ["学习", "研究", "阅读", "课程", "论文"], "builtin": True},
        {"id": "category-product", "name": "产品设计", "nature": "core", "keywords": ["产品", "设计", "原型", "需求", "规划"], "builtin": True},
        {"id": "category-meeting", "name": "会议沟通", "nature": "support", "keywords": ["会议", "沟通", "电话", "讨论", "同步"], "builtin": True},
        {"id": "category-operations", "name": "运营事务", "nature": "support", "keywords": ["运营", "事务", "邮件", "报销", "行政"], "builtin": True},
        {"id": "category-commute", "name": "通勤移动", "nature": "support", "keywords": ["通勤", "开车", "地铁", "打车", "赶路"], "builtin": True},
        {"id": "category-sleep", "name": "睡眠", "nature": "recovery", "keywords": ["睡觉", "睡眠", "午睡", "休息", "补觉"], "builtin": True},
        {"id": "category-food", "name": "饮食", "nature": "recovery", "keywords": ["吃饭", "早餐", "午饭", "晚饭", "做饭"], "builtin": True},
        {"id": "category-health", "name": "运动健康", "nature": "recovery", "keywords": ["运动", "健身", "跑步", "散步", "就医"], "builtin": True},
        {"id": "category-housework", "name": "家务生活", "nature": "recovery", "keywords": ["家务", "洗衣", "打扫", "采购", "整理"], "builtin": True},
        {"id": "category-phone", "name": "刷手机", "nature": "leisure", "keywords": ["刷手机", "短视频", "小红书", "微博", "刷屏"], "builtin": True},
        {"id": "category-media", "name": "影音娱乐", "nature": "leisure", "keywords": ["电影", "追剧", "视频", "游戏", "音乐"], "builtin": True},
        {"id": "category-social", "name": "社交闲聊", "nature": "leisure", "keywords": ["聊天", "聚会", "闲聊", "社交", "串门"], "builtin": True},
        {"id": "category-uncategorized", "name": "未归类", "nature": "support", "keywords": ["未归类", "说不清", "不知道"], "builtin": True, "protected": True},
    ]


def _columns(connection: sqlite3.Connection, table: str) -> set[str]:
    return {row["name"] for row in connection.execute(f"PRAGMA table_info({table})").fetchall()}


def _migrate_p0_schema(connection: sqlite3.Connection) -> None:
    """P0 从零生成的极简账本没有业务数据，升级时原地替换为 TimeOS 兼容 schema。"""
    segment_columns = _columns(connection, "segments")
    if segment_columns and "title" not in segment_columns:
        if connection.execute("SELECT COUNT(*) FROM segments").fetchone()[0]:
            raise RuntimeError("P0 时间账本含无法安全升级的临时时段；请用隔离备份重新迁移。")
        for table in ("segments", "categories", "projects", "settings", "runtime_state"):
            connection.execute(f"DROP TABLE IF EXISTS {table}")


def _ensure_schema_objects(connection: sqlite3.Connection) -> None:
    connection.executescript(
        """
        CREATE TABLE IF NOT EXISTS segments (
          id TEXT PRIMARY KEY, title TEXT NOT NULL, category_json TEXT,
          project_name TEXT, started_at TEXT NOT NULL, ended_at TEXT,
          started_utc TEXT, ended_utc TEXT,
          deduction_minutes INTEGER NOT NULL DEFAULT 0, deduction_note TEXT,
          tags_json TEXT, note TEXT, source TEXT NOT NULL DEFAULT 'agent',
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
          deleted_at TEXT, deleted_by TEXT, deletion_reason TEXT, auto_closed_by TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_segments_started ON segments(started_at);
        CREATE TABLE IF NOT EXISTS categories (
          id TEXT PRIMARY KEY, payload_json TEXT NOT NULL,
          sort_order INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS projects (
          id TEXT PRIMARY KEY, payload_json TEXT NOT NULL,
          sort_order INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS settings (
          id INTEGER PRIMARY KEY CHECK (id = 1), payload_json TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS runtime_state (
          key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        """
    )
    for name, definition in (
        ("deduction_note", "TEXT"), ("tags_json", "TEXT"), ("note", "TEXT"),
        ("deleted_at", "TEXT"), ("deleted_by", "TEXT"), ("deletion_reason", "TEXT"),
        ("auto_closed_by", "TEXT"), ("started_utc", "TEXT"), ("ended_utc", "TEXT"),
    ):
        if name not in _columns(connection, "segments"):
            connection.execute(f"ALTER TABLE segments ADD COLUMN {name} {definition}")


def _state_value(connection: sqlite3.Connection, key: str) -> str | None:
    row = connection.execute("SELECT value_json FROM runtime_state WHERE key=?", (key,)).fetchone()
    if row is None:
        return None
    try:
        value = json.loads(row["value_json"])
    except (TypeError, json.JSONDecodeError) as exc:
        raise RuntimeError(f"数据库中的 {key} 恢复状态无效。") from exc
    if not isinstance(value, str):
        raise RuntimeError(f"数据库中的 {key} 恢复状态无效。")
    return value


def _upsert_timezone_state(connection: sqlite3.Connection, configured: str, resolved: str) -> None:
    occurred_at = utc_now_iso()
    connection.executemany(
        "INSERT INTO runtime_state(key,value_json,updated_at) VALUES (?,?,?) "
        "ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at",
        (("record_timezone", json.dumps(configured, ensure_ascii=False), occurred_at),
         ("record_timezone_resolved", json.dumps(resolved, ensure_ascii=False), occurred_at)),
    )


def _choose_startup_timezone(
    connection: sqlite3.Connection, configured: str, *, missing_utc: int
) -> tuple[str, str]:
    database_configured = _state_value(connection, "record_timezone")
    database_resolved = _state_value(connection, "record_timezone_resolved")
    if database_configured is None and database_resolved is not None:
        raise RuntimeError("数据库只有具体记录时区、缺少配置时区状态；请从备份恢复 runtime_state。")
    if database_configured is not None:
        if database_configured:
            if database_resolved not in {None, database_configured}:
                raise RuntimeError("数据库中的配置时区与具体记录时区互相矛盾。")
            return database_configured, database_configured
        if not database_resolved:
            raise RuntimeError("数据库跟随系统但未冻结具体 IANA 时区。")
        if configured and configured != database_resolved:
            raise RuntimeError(f"账本跟随系统时冻结在 {database_resolved}，但配置要求 {configured}。")
        return (database_resolved, database_resolved) if configured else ("", database_resolved)
    if configured:
        return configured, configured
    if missing_utc:
        raise RuntimeError(
            "检测到尚未锚定 UTC 的旧账本，但配置仍为跟随系统时区；"
            "请先在 runtime/config.json 明确填写这些记录创建时使用的 IANA 时区。"
        )
    zone, _effective, _source, resolved = resolve_record_timezone("")
    del zone
    return "", resolved


def _legacy_utc_pair(row: sqlite3.Row) -> tuple[str, str | None]:
    zone, zone_name = record_timezone()
    start_candidates = local_minute_candidates(parse_minute(row["started_at"], "startedAt"), zone)
    end_value = row["ended_at"]
    if not start_candidates:
        raise RuntimeError(f"旧记录 {row['id']} 的 startedAt 不存在，无法安全补写 UTC。")
    if end_value is None:
        if len(start_candidates) != 1:
            raise RuntimeError(f"旧记录 {row['id']} 在 {zone_name} 的 DST 重复小时中缺少 fold 证据。")
        return format_utc_minute(start_candidates[0]), None
    end_candidates = local_minute_candidates(parse_minute(end_value, "endedAt"), zone)
    valid = [(start, end) for start in start_candidates for end in end_candidates if end > start]
    if len(valid) != 1:
        raise RuntimeError(f"旧记录 {row['id']} 无法唯一还原为正向 UTC 区间。")
    return format_utc_minute(valid[0][0]), format_utc_minute(valid[0][1])


def _backfill_and_validate_segments(connection: sqlite3.Connection) -> None:
    """补旧库 UTC 后验证每一行投影及活动记录的绝对时间拓扑。"""
    zone, zone_name = record_timezone()
    rows = connection.execute("SELECT * FROM segments WHERE started_utc IS NULL OR (ended_at IS NOT NULL AND ended_utc IS NULL)").fetchall()
    for row in rows:
        started_utc, ended_utc = _legacy_utc_pair(row)
        connection.execute("UPDATE segments SET started_utc=COALESCE(started_utc,?), ended_utc=CASE WHEN ended_at IS NULL THEN NULL ELSE COALESCE(ended_utc,?) END WHERE id=?", (started_utc, ended_utc, row["id"]))
    active_rows: list[tuple[str, datetime, datetime | None]] = []
    for row in connection.execute(
        "SELECT id,started_at,ended_at,started_utc,ended_utc,deleted_at FROM segments ORDER BY started_utc,id"
    ):
        try:
            start = parse_utc_minute(row["started_utc"], "startedUtc")
            end = parse_utc_minute(row["ended_utc"], "endedUtc") if row["ended_utc"] else None
        except Exception as exc:
            raise RuntimeError(f"账本记录 {row['id']} 的 UTC 锚点无效。") from exc
        if utc_to_local_minute(start, zone) != row["started_at"] or (end and utc_to_local_minute(end, zone) != row["ended_at"]):
            raise RuntimeError(f"账本记录 {row['id']} 的本地分钟与 UTC 锚点在 {zone_name} 中不一致。")
        if end is not None and end <= start:
            raise RuntimeError(f"账本记录 {row['id']} 的 UTC 区间无效。")
        if row["deleted_at"] is None:
            active_rows.append((str(row["id"]), start, end))
    previous_id: str | None = None
    previous_end: datetime | None = None
    previous_is_open = False
    conflicts: set[str] = set()
    for segment_id, start, end in active_rows:
        if previous_id is not None and (previous_is_open or (previous_end is not None and start < previous_end)):
            conflicts.update((previous_id, segment_id))
        if previous_id is None or (not previous_is_open and (end is None or previous_end is None or end > previous_end)):
            previous_id, previous_end, previous_is_open = segment_id, end, end is None
    if conflicts:
        raise RuntimeError(f"账本记录 {', '.join(sorted(conflicts))} 存在重叠，拒绝带病启动。")
    if connection.execute("SELECT COUNT(*) FROM segments WHERE ended_at IS NULL AND deleted_at IS NULL").fetchone()[0] > 1:
        raise RuntimeError("账本已有多个进行中时段，无法建立唯一约束。")
    connection.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_segments_one_open ON segments((1)) WHERE ended_at IS NULL AND deleted_at IS NULL")
    connection.execute("CREATE INDEX IF NOT EXISTS idx_segments_started_utc ON segments(started_utc)")


def _seed_default_master_data(connection: sqlite3.Connection) -> None:
    now = utc_now_iso()
    if connection.execute("SELECT COUNT(*) FROM categories").fetchone()[0] == 0:
        connection.executemany("INSERT INTO categories(id,payload_json,sort_order,updated_at) VALUES (?,?,?,?)", [(item["id"], json.dumps(item, ensure_ascii=False), index, now) for index, item in enumerate(default_categories())])
    if connection.execute("SELECT COUNT(*) FROM settings").fetchone()[0] == 0:
        connection.execute("INSERT INTO settings(id,payload_json,updated_at) VALUES (1,?,?)", (json.dumps({"weekStart": "monday"}), now))


def ensure_schema(ledger: Ledger, config: dict[str, Any]) -> dict[str, Any]:
    connection = ledger.connect()
    try:
        _migrate_p0_schema(connection)
        _ensure_schema_objects(connection)
        configured = str(config.get("timezone") or "")
        missing_utc = connection.execute(
            "SELECT COUNT(*) FROM segments WHERE started_utc IS NULL "
            "OR (ended_at IS NOT NULL AND ended_utc IS NULL)"
        ).fetchone()[0]
        chosen_configured, chosen_resolved = _choose_startup_timezone(
            connection, configured, missing_utc=int(missing_utc)
        )
        configure_record_timezone(chosen_configured, chosen_resolved)
        _backfill_and_validate_segments(connection)
        _upsert_timezone_state(connection, chosen_configured, chosen_resolved)
        _seed_default_master_data(connection)
        ensure_audit_schema(connection)
        connection.commit()
        config.update({"configuredTimezone": chosen_configured, **clock.record_timezone_state(), "currentSystemTimezone": current_system_timezone_name()})
        return config
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.close()


def reconcile_timezone_state(ledger: Ledger, config: dict[str, Any]) -> dict[str, Any]:
    connection = ledger.connect()
    try:
        configured = _state_value(connection, "record_timezone")
        resolved = _state_value(connection, "record_timezone_resolved")
    finally:
        connection.close()
    if configured is None or not resolved:
        raise RuntimeError("数据库缺少完整的记录时区恢复状态。")
    effective = configure_record_timezone(configured, resolved)
    config.update({"configuredTimezone": configured, "timezone": effective, "timezoneSource": clock.record_timezone_state()["timezoneSource"], "resolvedTimezone": clock.record_timezone_state()["resolvedTimezone"], "currentSystemTimezone": current_system_timezone_name()})
    _persist_record_timezone(ledger, config, configured)
    return config


def health_projection(ledger: Ledger, config: dict[str, Any]) -> dict[str, Any]:
    return {"dbPath": str(ledger.db_path), "resolvedTimezone": config.get("resolvedTimezone", ""), "currentSystemTimezone": config.get("currentSystemTimezone")}


def _persist_record_timezone(ledger: Ledger, config: dict[str, Any], configured: str) -> None:
    """把数据库已提交的时区意图原子回写到同一 runtime 的公开配置。"""
    config_path = ledger.db_path.parent.parent / "config.json"
    write_config(
        config_path,
        {
            "host": config["host"], "port": config["port"], "accessToken": config["accessToken"],
            "allowedHosts": list(config["allowedHosts"]), "timezone": configured,
            "timezoneSource": "config" if configured else "system",
        },
    )


def _nullable_text(payload: dict[str, Any], key: str, default: str | None = None) -> str | None:
    value = payload.get(key, default)
    if value is not None and not isinstance(value, str):
        raise DomainError("invalid_request", f"{key} 必须是字符串或 null。", status=400)
    return value


def _segment_fields(payload: dict[str, Any], connection: sqlite3.Connection, current: dict[str, Any] | None = None) -> dict[str, Any]:
    reject_unknown_fields(payload, SEGMENT_UPDATE_FIELDS if current else SEGMENT_CREATE_FIELDS, "时段请求")
    title = payload.get("title", current["title"] if current else "")
    if not isinstance(title, str) or not title.strip():
        raise DomainError("invalid_request", "title 不能为空且必须是字符串。", status=400)
    if "categoryName" in payload or current is None:
        category_name = payload.get("categoryName", "未归类")
        if not isinstance(category_name, str):
            raise DomainError("invalid_request", "categoryName 必须是字符串。", status=400)
        category = resolve_master(connection, "categories", category_name or "未归类", "unknown_category")
    else:
        category = current["category"]
    expected_nature = payload.get("expectedNature")
    if expected_nature is not None:
        if not isinstance(expected_nature, str) or expected_nature not in NATURES:
            raise DomainError("invalid_nature", f"expectedNature 只能是 {', '.join(NATURES)}。")
        if category.get("nature") != expected_nature:
            raise DomainError("category_nature_mismatch", "分类不符合用户明确指定的性质。", categoryName=category.get("name"), expectedNature=expected_nature, actualNature=category.get("nature"))
    project_name = current.get("projectName") if current else None
    if "projectName" in payload:
        raw_project = payload["projectName"]
        if raw_project is not None and not isinstance(raw_project, str):
            raise DomainError("invalid_request", "projectName 必须是字符串或 null。", status=400)
        project_name = None if raw_project is None or not raw_project.strip() else resolve_master(connection, "projects", raw_project, "unknown_project")["name"]
    source = payload.get("source", current["source"] if current else "agent")
    if not isinstance(source, str) or source.strip() not in SOURCES:
        raise DomainError("invalid_source", "source 必须是 agent、manual 或 import。", status=400)
    reference_now = datetime.now(record_timezone()[0]).replace(second=0, microsecond=0)
    started_at = payload.get("startedAt", current["startedAt"] if current else reference_now.strftime("%Y-%m-%dT%H:%M"))
    ended_at = payload.get("endedAt", current["endedAt"] if current else None)
    if not isinstance(started_at, str) or ended_at is not None and not isinstance(ended_at, str):
        raise DomainError("invalid_request", "startedAt/endedAt 必须是分钟字符串或 null。", status=400)
    started_utc = current.get("startedUtc") if current and started_at == current["startedAt"] else format_utc_minute(local_minute_to_utc(started_at, "startedAt", reference_now=reference_now))
    ended_utc = None if ended_at is None else (current.get("endedUtc") if current and ended_at == current["endedAt"] else format_utc_minute(local_minute_to_utc(ended_at, "endedAt", reference_now=reference_now)))
    deduction = int_field(payload, "deductionMinutes")
    deduction = deduction if deduction is not None else int(current.get("deductionMinutes", 0) if current else 0)
    tags = payload.get("tags", current.get("tags", []) if current else [])
    if not isinstance(tags, list) or any(not isinstance(tag, str) for tag in tags):
        raise DomainError("invalid_request", "tags 必须是字符串数组。", status=400)
    return {"title": title.strip(), "category": {"name": category["name"], "nature": category["nature"]}, "projectName": project_name, "startedAt": started_at, "endedAt": ended_at, "startedUtc": started_utc, "endedUtc": ended_utc, "deductionMinutes": deduction, "deductionNote": _nullable_text(payload, "deductionNote", current.get("deductionNote") if current else None), "tags": tags, "note": _nullable_text(payload, "note", current.get("note") if current else None), "source": source.strip()}


def _revision_actor(payload: dict[str, Any], source: str | None = None) -> str:
    operator = payload.get("operator")
    if isinstance(operator, str) and operator.strip():
        return operator.strip()
    resolved = str(payload.get("source") or source or "agent")
    return "dashboard" if resolved == "manual" else resolved


def create_segment_in_connection(
    payload: dict[str, Any], connection: sqlite3.Connection,
) -> tuple[dict[str, Any], dict[str, Any] | None, list[dict[str, Any]]]:
    fields, existing = _segment_fields(payload, connection), fetch_segments(connection)
    open_item = next((item for item in existing if item["endedAt"] is None), None)
    segment_id, now, events = uuid4().hex, utc_now_iso(), []
    closed_previous = None
    if fields["endedAt"] is None and open_item is not None:
        if parse_utc_minute(fields["startedUtc"]) <= parse_utc_minute(open_item["startedUtc"]):
            raise DomainError("auto_close_would_invert", "新时段开始时间必须晚于当前进行中时段。", openSegment=open_item)
        validate_candidate(open_item["startedAt"], fields["startedAt"], open_item["deductionMinutes"], existing, exclude_id=open_item["id"], started_utc=open_item["startedUtc"], ended_utc=fields["startedUtc"], too_long_code="open_segment_too_long")
        validate_candidate(fields["startedAt"], None, fields["deductionMinutes"], existing, exclude_id=open_item["id"], started_utc=fields["startedUtc"])
        connection.execute("UPDATE segments SET ended_at=?,ended_utc=?,updated_at=?,auto_closed_by=? WHERE id=?", (fields["startedAt"], fields["startedUtc"], now, segment_id, open_item["id"]))
        closed_previous = get_segment(connection, open_item["id"])
        events.append(append_record_revision(
            connection, occurred_at=utc_now_iso(), actor=_revision_actor(payload, fields["source"]),
            action="update", entity_type="segment", entity_id=open_item["id"],
            entity_name=open_item["title"], before=open_item, after=closed_previous,
            impact={"autoClosedBy": segment_id}, reason="新时段开始，自动收尾",
        ))
    else:
        validate_candidate(fields["startedAt"], fields["endedAt"], fields["deductionMinutes"], existing, started_utc=fields["startedUtc"], ended_utc=fields["endedUtc"])
    connection.execute("INSERT INTO segments(id,title,category_json,project_name,started_at,ended_at,started_utc,ended_utc,deduction_minutes,deduction_note,tags_json,note,source,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", (segment_id, fields["title"], json.dumps(fields["category"], ensure_ascii=False), fields["projectName"], fields["startedAt"], fields["endedAt"], fields["startedUtc"], fields["endedUtc"], fields["deductionMinutes"], fields["deductionNote"], json.dumps(fields["tags"], ensure_ascii=False), fields["note"], fields["source"], now, now))
    segment = get_segment(connection, segment_id)
    events.append(append_record_revision(
        connection, occurred_at=utc_now_iso(), actor=_revision_actor(payload, fields["source"]),
        action="create", entity_type="segment", entity_id=segment_id,
        entity_name=segment["title"], before=None, after=segment,
    ))
    return segment, closed_previous, events


def create_segment(ledger: Ledger, payload: dict[str, Any]) -> dict[str, Any]:
    with ledger.write_transaction() as connection:
        segment, closed, events = create_segment_in_connection(payload, connection)
        checkpoint = checkpoint_after_commit(connection, ledger, events[-1])
    result = {"segment": segment, "closedPrevious": closed, "operations": events}
    if checkpoint[0]: result["auditWarning"] = checkpoint[0]
    return result


def stop_segment(ledger: Ledger, segment_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    reject_unknown_fields(payload, {"endedAt", "deductionMinutes", "deductionNote"}, "stop 请求")
    with ledger.write_transaction() as connection:
        current = get_segment(connection, segment_id)
        if current["endedAt"] is not None:
            raise DomainError("invalid_range", "只有进行中时段可以收尾。")
        reference_now = datetime.now(record_timezone()[0]).replace(second=0, microsecond=0)
        if "endedAt" in payload:
            ended_at = payload["endedAt"]
            if not isinstance(ended_at, str): raise DomainError("invalid_request", "endedAt 必须是分钟字符串。", status=400)
            ended_utc = format_utc_minute(local_minute_to_utc(ended_at, "endedAt", reference_now=reference_now))
        else:
            start = parse_utc_minute(current["startedUtc"])
            end = max(start + timedelta(minutes=1), reference_now.astimezone(timezone.utc))
            ended_at, ended_utc = utc_to_local_minute(end), format_utc_minute(end)
        deduction = int_field(payload, "deductionMinutes") or 0
        validate_candidate(current["startedAt"], ended_at, deduction, fetch_segments(connection), exclude_id=segment_id, started_utc=current["startedUtc"], ended_utc=ended_utc, too_long_code="open_segment_too_long")
        connection.execute("UPDATE segments SET ended_at=?,ended_utc=?,deduction_minutes=?,deduction_note=?,updated_at=? WHERE id=?", (ended_at, ended_utc, deduction, _nullable_text(payload, "deductionNote"), utc_now_iso(), segment_id))
        segment = get_segment(connection, segment_id)
        event = append_record_revision(
            connection, occurred_at=utc_now_iso(), actor="dashboard", action="update",
            entity_type="segment", entity_id=segment_id, entity_name=segment["title"],
            before=current, after=segment, reason="时段收尾",
        )
        checkpoint = checkpoint_after_commit(connection, ledger, event)
    result = {"segment": segment, "operation": event}
    if checkpoint[0]: result["auditWarning"] = checkpoint[0]
    return result


def update_segment_in_connection(
    segment_id: str, payload: dict[str, Any], connection: sqlite3.Connection,
) -> tuple[dict[str, Any], dict[str, Any]]:
    immutable = {"source", "deletedAt", "id", "createdAt", "updatedAt", "startedUtc", "endedUtc"}.intersection(payload)
    if immutable: raise DomainError("immutable_field", f"不可修改字段：{', '.join(sorted(immutable))}。")
    current = get_segment(connection, segment_id)
    if current["endedAt"] is not None and payload.get("endedAt", current["endedAt"]) is None:
        raise DomainError("immutable_field", "闭合时段不能改回进行中。")
    fields = _segment_fields(payload, connection, current)
    validate_candidate(fields["startedAt"], fields["endedAt"], fields["deductionMinutes"], fetch_segments(connection), exclude_id=segment_id, started_utc=fields["startedUtc"], ended_utc=fields["endedUtc"])
    causal = current["autoClosedBy"] if fields["startedAt"] == current["startedAt"] and fields["endedAt"] == current["endedAt"] and "deductionMinutes" not in payload and "deductionNote" not in payload else None
    connection.execute("UPDATE segments SET title=?,category_json=?,project_name=?,started_at=?,ended_at=?,started_utc=?,ended_utc=?,deduction_minutes=?,deduction_note=?,tags_json=?,note=?,auto_closed_by=?,updated_at=? WHERE id=?", (fields["title"], json.dumps(fields["category"], ensure_ascii=False), fields["projectName"], fields["startedAt"], fields["endedAt"], fields["startedUtc"], fields["endedUtc"], fields["deductionMinutes"], fields["deductionNote"], json.dumps(fields["tags"], ensure_ascii=False), fields["note"], causal, utc_now_iso(), segment_id))
    updated = get_segment(connection, segment_id)
    event = append_record_revision(
        connection, occurred_at=utc_now_iso(), actor=_revision_actor(payload, current["source"]),
        action="update", entity_type="segment", entity_id=segment_id,
        entity_name=updated["title"], before=current, after=updated,
        reason=str(payload.get("reason") or "修改时段"),
    )
    return updated, event


def update_segment(ledger: Ledger, segment_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    with ledger.write_transaction() as connection:
        segment, event = update_segment_in_connection(segment_id, payload, connection)
        checkpoint = checkpoint_after_commit(connection, ledger, event)
    result = {"segment": segment, "operation": event}
    if checkpoint[0]: result["auditWarning"] = checkpoint[0]
    return result


def delete_segment_in_connection(segment_id: str, payload: dict[str, Any], connection: sqlite3.Connection) -> tuple[dict[str, Any], dict[str, Any] | None]:
    reject_unknown_fields(payload, {"reason", "operator", "revertAutoClose"}, "删除请求")
    reason, operator, revert = payload.get("reason", "删除时段"), payload.get("operator", "agent"), payload.get("revertAutoClose", False)
    if not isinstance(reason, str) or not isinstance(operator, str) or not isinstance(revert, bool): raise DomainError("invalid_request", "删除参数类型无效。", status=400)
    current, now = get_segment(connection, segment_id), utc_now_iso()
    connection.execute("UPDATE segments SET deleted_at=?,deleted_by=?,deletion_reason=?,updated_at=? WHERE id=?", (now, operator.strip() or "agent", reason.strip() or "删除时段", now, segment_id))
    deleted = segment_from_row(connection.execute("SELECT * FROM segments WHERE id=?", (segment_id,)).fetchone())
    if not revert: return deleted, None
    rows = connection.execute("SELECT * FROM segments WHERE auto_closed_by=? AND deleted_at IS NULL", (segment_id,)).fetchall()
    if len(rows) != 1: return deleted, None
    previous = segment_from_row(rows[0])
    if previous["endedUtc"] != deleted["startedUtc"]: return deleted, None
    validate_candidate(previous["startedAt"], None, previous["deductionMinutes"], fetch_segments(connection), exclude_id=previous["id"], started_utc=previous["startedUtc"])
    connection.execute("UPDATE segments SET ended_at=NULL,ended_utc=NULL,auto_closed_by=NULL,updated_at=? WHERE id=?", (now, previous["id"]))
    return deleted, get_segment(connection, previous["id"])


def delete_segment(ledger: Ledger, segment_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    with ledger.write_transaction() as connection:
        before = get_segment(connection, segment_id)
        deleted, restored = delete_segment_in_connection(segment_id, payload, connection)
        event = {
            "id": uuid4().hex, "occurredAt": utc_now_iso(), "actor": str(payload.get("operator") or "agent"),
            "action": "delete", "entityType": "segment", "entityId": segment_id, "entityName": before["title"],
            "impact": {"restoredPrevious": bool(restored)}, "payload": {"before": before, "after": deleted},
        }
        append_audit_event(connection, event)
        checkpoint = checkpoint_after_commit(connection, ledger, event)
    warning = checkpoint[0] or None
    result = {"segment": deleted, "restoredPrevious": restored, "operation": event}
    if warning:
        result["auditWarning"] = warning
    return result


def list_segments(ledger: Ledger, query: dict[str, list[str]] | None = None) -> dict[str, Any]:
    """按 UTC 区间做交叠筛选；本地日期边界统一由冻结时区解释。"""
    query = query or {}
    include_deleted = str(query.get("includeDeleted", [""])[0]).lower() in {"1", "true", "yes"}
    connection = ledger.connect()
    try:
        items = fetch_segments(connection, include_deleted=include_deleted)
    finally: connection.close()
    from_raw, to_raw = query.get("from", [None])[0], query.get("to", [None])[0]
    # 分钟形式的窗口边界走 local_minute_boundary_utc 而非 local_minute_to_utc：
    # 后者是**写入**语义，午夜前跳（America/Santiago）或午夜回拨（America/Havana）的时区里
    # 「那一天的 00:00」不存在或有两解，它一律 409 invalid_local_minute。
    # 而 gaps 与 summary/range 对同一天照常经 local_day_bounds_utc 给出 1380/1500 分钟的正确答案——
    # 于是服务端对「这一天的 00:00 是几点」有了两套答案，面板用分钟型 from/to 取当天数据，
    # 跳变日与其前一日连续两天的日视图直接打不开。筛选窗口是只读的，
    # 一个不存在的午夜在这里只是「从哪一瞬开始看」，降级不会污染任何数据。
    from_dt = (
        local_minute_boundary_utc(parse_minute(from_raw, "from")) if from_raw and "T" in from_raw
        else local_day_bounds_utc(parse_date(from_raw, "from"))[0] if from_raw else None
    )
    # 日期形式的 to 取**当天终点**（= 次日 00:00 的 UTC），与 summary/range 的闭区间同义。
    # 此前取 [0]（当天起点），整个 to 日被排除：`--from X --to X` 查单日恒为空数组，
    # 而 Skill 参考文档原样给出的正是这种命令——Agent 会把有记录的那天报成没有记录，
    # 「空白可追溯」在这里反过来凭空造出空白。
    # 分钟形式（含 T）保持排他瞬间语义不变：面板用的 `to=次日T00:00` 依赖它。
    to_dt = (
        local_minute_boundary_utc(parse_minute(to_raw, "to")) if to_raw and "T" in to_raw
        else local_day_bounds_utc(parse_date(to_raw, "to"))[1] if to_raw else None
    )
    if from_dt is not None and to_dt is not None and to_dt < from_dt:
        raise DomainError("invalid_range", "to 必须不早于 from。")
    current = clock.now_as_utc()
    filtered = []
    for item in items:
        start = item_utc(item, "started")
        end = item_utc(item, "ended") if item["endedAt"] else current
        if start is None or end is None or (from_dt and end <= from_dt) or (to_dt and start >= to_dt):
            continue
        if query.get("category") and normalize_name(item["category"]["name"]) != normalize_name(query["category"][0]):
            continue
        if query.get("project") and normalize_name(item.get("projectName")) != normalize_name(query["project"][0]):
            continue
        if query.get("source") and item["source"] != query["source"][0]:
            continue
        filtered.append(item)
    return {"segments": filtered, "total": len(filtered)}


def summary(ledger: Ledger, from_value: str, to_value: str) -> dict[str, Any]:
    connection = ledger.connect()
    try: return summarize_range(fetch_segments(connection), from_value, to_value)
    finally: connection.close()


def gaps(ledger: Ledger, date_value: str) -> dict[str, Any]:
    connection = ledger.connect()
    try: return compute_day_coverage(fetch_segments(connection), date_value)
    finally: connection.close()


def reconcile_segments(ledger: Ledger, payload: dict[str, Any]) -> dict[str, Any]:
    reject_unknown_fields(payload, {"operations"}, "reconcile 请求")
    operations = payload.get("operations")
    if not isinstance(operations, list) or not 1 <= len(operations) <= 32:
        raise DomainError("invalid_request", "operations 必须是包含 1–32 项的数组。", status=400)
    results, revision_events, checkpoint = [], [], []
    with ledger.write_transaction() as connection:
        for index, operation in enumerate(operations):
            if not isinstance(operation, dict) or not isinstance(operation.get("action"), str):
                raise DomainError("invalid_request", f"operations[{index}] 必须含 action。", status=400)
            action = operation["action"].strip()
            allowed = {"action", "payload"} if action == "create" else {"action", "id", "payload"}
            reject_unknown_fields(operation, allowed, f"operations[{index}]")
            body = operation.get("payload", {})
            if not isinstance(body, dict): raise DomainError("invalid_request", f"operations[{index}].payload 必须是对象。", status=400)
            if action == "create":
                segment, closed, events = create_segment_in_connection(body, connection)
                revision_events.extend(events)
                results.append({"action": action, "segment": segment, "closedPrevious": closed})
            elif action == "update":
                if not isinstance(operation.get("id"), str) or not operation["id"].strip(): raise DomainError("invalid_request", f"operations[{index}] 的 update 缺少 id。", status=400)
                segment, event = update_segment_in_connection(operation["id"].strip(), body, connection)
                revision_events.append(event)
                results.append({"action": action, "segment": segment, "operation": event})
            elif action == "delete":
                if not isinstance(operation.get("id"), str) or not operation["id"].strip(): raise DomainError("invalid_request", f"operations[{index}] 的 delete 缺少 id。", status=400)
                identifier = operation["id"].strip()
                # 与单条 DELETE 端点同一套审计契约：软删除会让记录从用户视野消失，
                # 是本域仅有的破坏性操作，必须留下 before/after 与检查点。
                # 此前批量路径两者皆无——而 P9 修 7-31 正是走 reconcile，
                # 「先快照再动手」这个恢复手段恰恰在最常用的那条路径上不存在。
                before = get_segment(connection, identifier)
                deleted, restored = delete_segment_in_connection(identifier, body, connection)
                event = {
                    "id": uuid4().hex, "occurredAt": utc_now_iso(), "actor": str(body.get("operator") or "agent"),
                    "action": "delete", "entityType": "segment", "entityId": identifier, "entityName": before["title"],
                    "impact": {"restoredPrevious": bool(restored), "viaReconcile": True},
                    "payload": {"before": before, "after": deleted},
                }
                append_audit_event(connection, event)
                revision_events.append(event)
                results.append({"action": action, "segment": deleted, "restoredPrevious": restored, "operation": event})
            else:
                raise DomainError("invalid_request", f"operations[{index}].action 只能是 create/update/delete。", status=400)
        # 整批是一个事务，中间态从未存在过，因此一批只登记一份快照：
        # 给每个事件各存一份是 N 份逐字节相同的副本，纯粹浪费磁盘。
        if revision_events:
            checkpoint = checkpoint_after_commit(connection, ledger, revision_events[-1])
    payload_out: dict[str, Any] = {"ok": True, "results": results}
    # 整批是一个事务，中间态从未存在过，因此一批只留一份快照：
    # 给每个事件各存一份是 N 份逐字节相同的副本，纯粹浪费磁盘。
    if checkpoint and checkpoint[0]:
        payload_out["auditWarning"] = checkpoint[0]
    return payload_out


def configuration(ledger: Ledger, config: dict[str, Any]) -> dict[str, Any]:
    connection = ledger.connect()
    try:
        row = connection.execute("SELECT payload_json FROM settings WHERE id=1").fetchone()
        settings = json.loads(row["payload_json"]) if row else {"weekStart": "monday"}
        # overlongSegmentMinutes 是给前端判定「进行中且已跑超阈值」的唯一来源，避免面板硬编码 480。
        return {"natures": list(NATURES), "categories": load_master(connection, "categories"), "projects": load_master(connection, "projects"), "settings": settings, "timezone": config.get("timezone"), "timezoneSource": config.get("timezoneSource"), "resolvedTimezone": config.get("resolvedTimezone"), "currentSystemTimezone": current_system_timezone_name(), "overlongSegmentMinutes": OVERLONG_SEGMENT_MINUTES}
    finally:
        connection.close()


def update_configuration(ledger: Ledger, config: dict[str, Any], payload: dict[str, Any]) -> dict[str, Any]:
    wrapped = any(key in payload for key in {"settings", "timezone", "historyMode"})
    if wrapped:
        reject_unknown_fields(payload, {"settings", "timezone", "historyMode"}, "配置请求")
        patch = payload.get("settings", {})
    else:
        patch = payload
    if not isinstance(patch, dict): raise DomainError("invalid_request", "settings 必须是对象。", status=400)
    reject_unknown_fields(patch, {"weekStart"}, "settings")
    if patch.get("weekStart") not in {None, "monday", "sunday"}: raise DomainError("invalid_request", "weekStart 只能是 monday 或 sunday。", status=400)
    timezone_requested = "timezone" in payload
    if "historyMode" in payload and not timezone_requested:
        raise DomainError("invalid_request", "historyMode 只能与 timezone 一起提交。", status=400)
    if timezone_requested and patch:
        raise DomainError("invalid_request", "记录时区与统计设置请分开保存。", status=400)
    if timezone_requested:
        timezone_value, history_mode = payload["timezone"], payload.get("historyMode")
        if not isinstance(timezone_value, str):
            raise DomainError("invalid_timezone", "timezone 必须是 IANA 时区名或空字符串。", status=400)
        if history_mode not in TIMEZONE_HISTORY_MODES:
            raise DomainError("invalid_request", "修改记录时区时必须明确选择 historyMode：convert（换算）或 preserve（保留）。", status=400)
        configured_timezone = timezone_value.strip()
        try:
            target_zone, target_effective, target_source, target_resolved = resolve_record_timezone(configured_timezone)
        except RuntimeError as exc:
            raise DomainError("invalid_timezone", str(exc), status=400) from exc
        source_configured = str(config.get("configuredTimezone") or "")
        event = {
            "id": uuid4().hex, "occurredAt": utc_now_iso(), "actor": "user", "action": "timezone_change",
            "entityType": "configuration", "entityId": "timezone", "entityName": "record timezone",
            "impact": {"historyMode": history_mode, "convertedSegments": 0},
            "payload": {
                "before": {"timezone": config.get("timezone"), "timezoneSource": config.get("timezoneSource"), "resolvedTimezone": config.get("resolvedTimezone")},
                "after": {"timezone": target_effective, "timezoneSource": target_source, "resolvedTimezone": target_resolved},
            },
        }
        backup_event = {**event, "id": uuid4().hex, "action": "timezone_change_backup"}
        try:
            checkpoint_database(ledger, backup_event)
        except Exception as exc:
            raise DomainError("configuration_backup_failed", f"历史时区变更前备份失败，未修改时区：{exc}", status=500) from exc
        with ledger.write_transaction() as connection:
            if history_mode == "preserve":
                target_now_local = datetime.now(target_zone).replace(second=0, microsecond=0, tzinfo=None)
                future_open = next(
                    (row for row in connection.execute("SELECT * FROM segments WHERE ended_at IS NULL AND deleted_at IS NULL")
                     if parse_minute(row["started_at"], "openSegment.startedAt") > target_now_local),
                    None,
                )
                if future_open is not None:
                    raise DomainError(
                        "timezone_preserve_open_segment", "保留钟面时间会让进行中时段落到新时区的未来；请先收尾，或改用 convert。",
                        status=409, openSegment=conflict_shape(future_open),
                    )
            if history_mode == "convert":
                updates = plan_timezone_conversion(connection, source_configured, configured_timezone, target_resolved)
                connection.executemany(
                    "UPDATE segments SET started_at=?, ended_at=? WHERE id=?",
                    [(started_at, ended_at, segment_id) for segment_id, started_at, ended_at in updates],
                )
                event["impact"]["convertedSegments"] = len(updates)
            else:
                anchored = plan_timezone_preservation(connection, configured_timezone, target_resolved)
                connection.executemany(
                    "UPDATE segments SET started_utc=?, ended_utc=? WHERE id=?",
                    [(started_utc, ended_utc, segment_id) for segment_id, started_utc, ended_utc in anchored],
                )
            append_audit_event(connection, event)
            checkpoint = checkpoint_after_commit(connection, ledger, event)
            _upsert_timezone_state(connection, configured_timezone, target_resolved)
        effective_timezone = configure_record_timezone(configured_timezone, target_resolved)
        config.update({"configuredTimezone": configured_timezone, "timezone": effective_timezone, "timezoneSource": clock.record_timezone_state()["timezoneSource"], "resolvedTimezone": clock.record_timezone_state()["resolvedTimezone"], "currentSystemTimezone": current_system_timezone_name()})
        try:
            _persist_record_timezone(ledger, config, configured_timezone)
        except OSError as exc:
            raise DomainError("configuration_write_failed", f"账本已提交新的记录时区，但配置文件写入失败；重启时会依据账本恢复：{exc}", status=500, recoverable=True) from exc
        # 时区已经落库，这里再抛 500 只会让调用方以为没保存成功而重试一次时区迁移。
        warning = checkpoint[0] or None
        result = {"timezone": effective_timezone, "timezoneSource": clock.record_timezone_state()["timezoneSource"], "resolvedTimezone": clock.record_timezone_state()["resolvedTimezone"], "currentSystemTimezone": current_system_timezone_name(), "historyMode": history_mode, "convertedSegments": event["impact"]["convertedSegments"]}
        if warning:
            result["auditWarning"] = warning
        return result
    with ledger.write_transaction() as connection:
        row = connection.execute("SELECT payload_json FROM settings WHERE id=1").fetchone()
        settings = json.loads(row["payload_json"]) if row else {"weekStart": "monday"}
        settings.update(patch)
        connection.execute("INSERT INTO settings(id,payload_json,updated_at) VALUES (1,?,?) ON CONFLICT(id) DO UPDATE SET payload_json=excluded.payload_json,updated_at=excluded.updated_at", (json.dumps(settings, ensure_ascii=False), utc_now_iso()))
    return {"settings": settings}


def habits(ledger: Ledger, query: str) -> dict[str, Any]:
    from collections import defaultdict
    from domains.time.clock import now_as_utc
    from domains.time.rules import item_utc, minute_delta, normalize_name
    normalized = normalize_name(query)
    if not normalized: raise DomainError("missing_query", "habits 需要非空 q 查询词。")
    connection = ledger.connect()
    try:
        items, categories = fetch_segments(connection), load_master(connection, "categories")
    finally:
        connection.close()
    matched_categories = {item["name"] for item in categories if any(normalized in normalize_name(word) or normalize_name(word) in normalized for word in item.get("keywords", []))}
    cutoff, now = now_as_utc() - timedelta(days=90), now_as_utc()
    matched = [item for item in items if item_utc(item, "started") and item_utc(item, "started") >= cutoff and (normalized in normalize_name(item["title"]) or normalize_name(item["title"]) in normalized or item["category"]["name"] in matched_categories)]
    category_counts, project_counts, durations = defaultdict(int), defaultdict(int), []
    for item in matched:
        category_counts[item["category"]["name"]] += 1
        if item.get("projectName"): project_counts[item["projectName"]] += 1
        start, end = item_utc(item, "started"), item_utc(item, "ended") if item["endedAt"] else now
        if start and end: durations.append(max(0, minute_delta(start, end)))
    total = len(matched)
    render = lambda values: [{"name": name, "share": round(count / total, 3)} for name, count in sorted(values.items(), key=lambda pair: (-pair[1], pair[0]))] if total else []
    return {"category": render(category_counts), "project": render(project_counts), "avgDurationMinutes": round(sum(durations) / total) if total else 0}
def audit_events(ledger: Ledger, limit: int | None = None) -> list[dict[str, Any]]:
    connection = ledger.connect()
    try:
        if limit is None: rows = connection.execute("SELECT * FROM audit_events ORDER BY occurred_at DESC").fetchall()
        else: rows = connection.execute("SELECT * FROM audit_events ORDER BY occurred_at DESC LIMIT ?", (max(limit, 1),)).fetchall()
    finally: connection.close()
    return [{"id": row["id"], "occurredAt": row["occurred_at"], "actor": row["actor"], "action": row["action"], "entityType": row["entity_type"], "entityId": row["entity_id"], "entityName": row["entity_name"], "impact": json.loads(row["impact_json"]), "payload": json.loads(row["payload_json"])} for row in rows]


def agent_operation(ledger: Ledger, request: dict[str, Any]) -> dict[str, Any]:
    """主数据写入强制带用户原话，并把 before/after 写入本账本审计链。"""
    reject_unknown_fields(request, {"userConfirmation", "entity", "entityType", "action", "payload", "data", "name", "targetName", "reason"}, "主数据请求")
    confirmation = request.get("userConfirmation")
    entity = request.get("entity", request.get("entityType"))
    payload = request.get("payload", request.get("data", {}))
    action = request.get("action")
    if not isinstance(confirmation, str) or not confirmation.strip(): raise DomainError("missing_user_confirmation", "AI 修改主数据前必须携带用户确认原话。")
    if entity not in {"category", "project"} or action not in {"create", "update", "delete"} or not isinstance(payload, dict): raise DomainError("invalid_request", "entity/action/payload 不受支持。", status=400)
    table = "categories" if entity == "category" else "projects"
    with ledger.write_transaction() as connection:
        records = load_master(connection, table, include_deleted=True)
        target_name = request.get("name", request.get("targetName", payload.get("currentName")))
        if target_name is not None and not isinstance(target_name, str): raise DomainError("invalid_request", "定位主数据的 name 必须是字符串。", status=400)
        from domains.time.rules import normalize_name
        target = next((item for item in records if normalize_name(item.get("name")) == normalize_name(target_name)), None)
        now, before = utc_now_iso(), {}
        if action == "create":
            allowed = {"name", "nature", "keywords"} if entity == "category" else {"name", "status"}
            reject_unknown_fields(payload, allowed, "主数据 payload")
            name = payload.get("name")
            if not isinstance(name, str) or not name.strip(): raise DomainError("invalid_request", "新主数据必须有 name。", status=400)
            if any(not item.get("deletedAt") and normalize_name(item.get("name")) == normalize_name(name) for item in records): raise DomainError("invalid_request", "同名主数据已存在。", status=409)
            entity_id = uuid4().hex
            if entity == "category":
                if payload.get("nature") not in NATURES or not isinstance(payload.get("keywords", []), list) or any(not isinstance(word, str) for word in payload.get("keywords", [])): raise DomainError("invalid_request", "分类需要有效 nature 与字符串 keywords。", status=400)
                target = {"id": entity_id, "name": name.strip(), "nature": payload["nature"], "keywords": payload.get("keywords", []), "builtin": False}
            else:
                status = payload.get("status", "active")
                if not isinstance(status, str) or not status.strip(): raise DomainError("invalid_request", "项目 status 必须是非空字符串。", status=400)
                target = {"id": entity_id, "name": name.strip(), "status": status.strip()}
            connection.execute(f"INSERT INTO {table}(id,payload_json,sort_order,updated_at) VALUES (?,?,?,?)", (entity_id, json.dumps(target, ensure_ascii=False), len(records), now))
        else:
            if target is None or target.get("deletedAt"): raise DomainError("not_found", "主数据不存在。", status=404)
            if entity == "category" and normalize_name(target["name"]) == normalize_name("未归类"): raise DomainError("immutable_field", "系统保留分类“未归类”不可修改或删除。")
            entity_id, before = target["id"], dict(target)
            if action == "delete":
                reason = request.get("reason", "Agent 删除")
                if not isinstance(reason, str): raise DomainError("invalid_request", "reason 必须是字符串。", status=400)
                target.update({"deletedAt": now, "deletedBy": "agent", "deletionReason": reason.strip() or "Agent 删除"})
            else:
                allowed = {"currentName", "name", "nature", "keywords"} if entity == "category" else {"currentName", "name", "status"}
                reject_unknown_fields(payload, allowed, "主数据 payload")
                changes = {key: value for key, value in payload.items() if key != "currentName"}
                if "name" in changes and (not isinstance(changes["name"], str) or not changes["name"].strip()): raise DomainError("invalid_request", "name 必须是非空字符串。", status=400)
                # 改名路径此前漏了重名校验（create 分支有、update 分支没有）。
                # 统计按 categoryName 聚合、resolve_master 又用 next() 取第一个匹配，
                # 一旦出现两条同名主数据，归属就变成不确定的。
                if "name" in changes and any(
                    other.get("id") != entity_id
                    and not other.get("deletedAt")
                    and normalize_name(other.get("name")) == normalize_name(changes["name"])
                    for other in records
                ):
                    raise DomainError("invalid_request", "新名称与现有主数据重名。", status=409)
                if "nature" in changes and changes["nature"] not in NATURES: raise DomainError("invalid_request", "nature 不在固定枚举中。", status=400)
                if "keywords" in changes and (not isinstance(changes["keywords"], list) or any(not isinstance(word, str) for word in changes["keywords"])): raise DomainError("invalid_request", "keywords 必须是字符串数组。", status=400)
                target.update(changes)
            connection.execute(f"UPDATE {table} SET payload_json=?,updated_at=? WHERE id=?", (json.dumps(target, ensure_ascii=False), now, entity_id))
        event = {"id": uuid4().hex, "occurredAt": now, "actor": "agent", "action": action, "entityType": entity, "entityId": entity_id, "entityName": target["name"], "impact": {}, "payload": {"before": before, "after": target, "userConfirmation": confirmation.strip()}}
        append_audit_event(connection, event)
        checkpoint = checkpoint_after_commit(connection, ledger, event)
    warning = checkpoint[0] or None
    result = {"ok": True, "operation": event, "entity": target}
    if warning:
        result["auditWarning"] = warning
    return result
