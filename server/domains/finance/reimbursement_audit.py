"""
[INPUT]: 依赖 finance transactions 表、store 的行投影与 core 不可覆盖版本审计器。
[OUTPUT]: 对外提供报销变更前后版本捕获，以及核销/撤销/回款删除级联的逐笔审计追加。
[POS]: finance 报销状态机的证据层；reimbursement.py 只执行 SQL，service.py 只持有事务与快照边界。
[PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
"""

from __future__ import annotations

import sqlite3
from typing import Any, Iterable

from core.audit import append_record_revision
from domains.finance.store import row_to_transaction


def transaction_versions(connection: sqlite3.Connection, transaction_ids: Iterable[str]) -> dict[str, dict[str, Any]]:
    """读取指定流水的完整版本；不存在的 ID 由报销状态机归入 invalid。"""
    versions: dict[str, dict[str, Any]] = {}
    for transaction_id in dict.fromkeys(transaction_ids):
        row = connection.execute("SELECT * FROM transactions WHERE id=?", (transaction_id,)).fetchone()
        if row is not None:
            versions[transaction_id] = row_to_transaction(row)
    return versions


def linked_expense_versions(connection: sqlite3.Connection, income_id: str) -> dict[str, dict[str, Any]]:
    """捕获删除回款将级联撤销的所有有效支出。"""
    rows = connection.execute(
        "SELECT * FROM transactions WHERE reimbursed_by=? AND deleted_at IS NULL", (income_id,)
    ).fetchall()
    return {row["id"]: row_to_transaction(row) for row in rows}


def append_reimbursement_revisions(
    connection: sqlite3.Connection,
    before: dict[str, dict[str, Any]],
    after: dict[str, dict[str, Any]],
    *,
    occurred_at: str,
    actor: str,
    reason: str,
    income_id: str | None = None,
) -> list[dict[str, Any]]:
    """每笔受影响支出各留一个 before/after 版本，批量事务仍只拍一份整库快照。"""
    events: list[dict[str, Any]] = []
    for transaction_id, previous in before.items():
        current = after.get(transaction_id)
        if current is None or current == previous:
            continue
        events.append(append_record_revision(
            connection, occurred_at=occurred_at, actor=actor, action="update",
            entity_type="transaction", entity_id=transaction_id, entity_name=current["title"],
            before=previous, after=current,
            impact={"reimbursementStatus": current.get("reimbursementStatus"), "reimbursedBy": current.get("reimbursedBy"), "incomeId": income_id},
            reason=reason,
        ))
    return events
