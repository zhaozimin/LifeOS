"""
[INPUT]: 依赖某一 Ledger 的 SQLite 数据库、审计根与已验证的审计事件。
[OUTPUT]: 对外提供 audit_events 建表、统一的记录版本事件、按 event id 不可覆盖的数据库快照，
           以及提交后调用、失败只告警不反噬写入的 checkpoint_or_warn。
[POS]: core 的跨域通用审计器；调用方传入自己的 Ledger，因此快照和审计流不会越过账本边界。
[PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
"""

from __future__ import annotations

import json
import os
import re
import shutil
import sqlite3
import sys
from pathlib import Path
from typing import Any
from uuid import uuid4

from core.sqlite import Ledger


def ensure_audit_schema(connection: sqlite3.Connection) -> None:
    connection.execute(
        """
        CREATE TABLE IF NOT EXISTS audit_events (
            id TEXT PRIMARY KEY,
            occurred_at TEXT NOT NULL,
            actor TEXT NOT NULL,
            action TEXT NOT NULL,
            entity_type TEXT NOT NULL,
            entity_id TEXT NOT NULL,
            entity_name TEXT NOT NULL,
            impact_json TEXT NOT NULL,
            payload_json TEXT NOT NULL
        )
        """
    )
    connection.execute("CREATE INDEX IF NOT EXISTS idx_audit_events_time ON audit_events(occurred_at DESC)")


def append_audit_event(connection: sqlite3.Connection, event: dict[str, Any]) -> None:
    connection.execute(
        """
        INSERT INTO audit_events (
            id, occurred_at, actor, action, entity_type, entity_id, entity_name, impact_json, payload_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            event["id"], event["occurredAt"], event["actor"], event["action"], event["entityType"],
            event["entityId"], event["entityName"],
            json.dumps(event.get("impact", {}), ensure_ascii=False, sort_keys=True),
            json.dumps(event.get("payload", {}), ensure_ascii=False, sort_keys=True),
        ),
    )


def append_record_revision(
    connection: sqlite3.Connection,
    *,
    occurred_at: str,
    actor: str,
    action: str,
    entity_type: str,
    entity_id: str,
    entity_name: str,
    before: dict[str, Any] | None,
    after: dict[str, Any] | None,
    impact: dict[str, Any] | None = None,
    reason: str | None = None,
) -> dict[str, Any]:
    """追加一条不可覆盖的业务记录版本，完整保存修改前后内容。"""
    event = {
        "id": uuid4().hex,
        "occurredAt": occurred_at,
        "actor": actor.strip() or "agent",
        "action": action,
        "entityType": entity_type,
        "entityId": entity_id,
        "entityName": entity_name,
        "impact": impact or {},
        "payload": {"before": before, "after": after, "reason": reason},
    }
    append_audit_event(connection, event)
    return event


def checkpoint_after_commit(connection: Any, ledger: Ledger, event: dict[str, Any]) -> list[str]:
    """在写事务内登记检查点，提交后仍持锁时执行；返回可读取警告的列表。

    调用方在 with 块内登记，块结束后读列表：

        with ledger.write_transaction() as connection:
            ...
            append_audit_event(connection, event)
            warnings = checkpoint_after_commit(connection, ledger, event)
        if warnings[0]: ...

    非要在锁内的理由：快照按 event id 命名且不可覆盖，若在锁外拍，
    提交到拍摄之间的并发写入会被算进这个事件的快照，事件与快照不再一一对应。
    """
    warnings: list[str] = []
    connection.after_commit_tasks.append(lambda: warnings.append(checkpoint_or_warn(ledger, event) or ""))
    return warnings


def checkpoint_or_warn(ledger: Ledger, event: dict[str, Any]) -> str | None:
    """快照失败不得反噬已提交的写入。

    checkpoint 在写事务之外运行：此刻业务数据与 audit_events 行都已 commit。
    若在这里抛错，调用方会返回 500，而 SOUL 托管块的全域纪律是「没有 display
    就是没写成功」——用户会被告知没记上，其实已经记上了。所以这里把失败降级为
    随回执带出的警告，审计链（audit_events 表）本身不受影响，缺的只是那份可选的
    整库快照副本。
    """
    try:
        checkpoint_database(ledger, event)
        return None
    except Exception as exc:  # noqa: BLE001 — 任何快照故障都不能吃掉已成功的写入
        warning = f"{ledger.name} 账本快照未能创建：{exc}"
        print(f"[LifeOS] {warning}", file=sys.stderr, flush=True)
        return warning


def checkpoint_database(ledger: Ledger, event: dict[str, Any]) -> Path:
    """通过 SQLite backup 创建不可覆盖的单账本快照；不依赖 Git 才保证正确性。"""
    event_id = str(event.get("id", ""))
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", event_id):
        raise RuntimeError("审计事件 id 无效，拒绝创建检查点。")
    snapshots = ledger.audit_root / "snapshots"
    snapshots.mkdir(parents=True, exist_ok=True)
    os.chmod(ledger.audit_root, 0o700)
    os.chmod(snapshots, 0o700)
    snapshot = snapshots / f"{event_id}.sqlite3"
    if snapshot.exists():
        raise RuntimeError(f"审计事件 {event_id} 的不可变检查点已存在。")
    temporary = snapshots / f".{event_id}.{os.getpid()}.tmp"
    source = destination = None
    try:
        source = sqlite3.connect(ledger.db_path)
        destination = sqlite3.connect(temporary)
        source.backup(destination)
    finally:
        if destination is not None:
            destination.close()
        if source is not None:
            source.close()
    os.chmod(temporary, 0o600)
    temporary.replace(snapshot)
    latest = ledger.audit_root / f"{ledger.name}.sqlite3"
    shutil.copyfile(snapshot, latest)
    os.chmod(latest, 0o600)
    audit_log = ledger.audit_root / "audit-events.jsonl"
    with audit_log.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps({**event, "snapshot": f"snapshots/{snapshot.name}"}, ensure_ascii=False) + "\n")
    os.chmod(audit_log, 0o600)
    return snapshot
