"""
[INPUT]: 依赖 finance 账本的 transactions 表与调用方开好的写连接。
[OUTPUT]: 对外提供报销状态写入、一对多核销与删除回款级联退回三个连接内原语。
[POS]: finance 的报销状态机；SQL 与 FinOS 基线 :4291-4454 逐字一致，事务边界由 service 持有。
[PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
"""

from __future__ import annotations

import sqlite3
from typing import Any

from core.errors import DomainError


# 只有这些状态的支出才允许被核销。notApplicable 与空值意味着「这笔跟报销无关」，
# 硬拦在这里，避免把普通消费误挂到一笔回款上。
SETTLEABLE_EXCLUDED_STATUSES = (None, "", "notApplicable")


def set_reimbursement_status_in_connection(
    connection: sqlite3.Connection, transaction_id: str, status: str, reimbursed_by: str | None, now: str
) -> None:
    """改单笔报销状态。非 reimbursed 一律清空 reimbursed_by，防止留下悬空回款引用。"""
    connection.execute(
        "UPDATE transactions SET reimbursement_status=?,reimbursed_by=?,updated_at=? WHERE id=?",
        (status, reimbursed_by if status == "reimbursed" else None, now, transaction_id),
    )


def settle_in_connection(
    connection: sqlite3.Connection, income_id: str, settle: list[str], unsettle: list[str], now: str
) -> dict[str, Any]:
    """一笔回款对多笔垫付支出的核销与撤销。

    撤销侧的 `AND reimbursed_by=?` 是防串账的关键：没有它，A 回款能撤掉
    B 回款核销过的支出。核销侧逐条查回行再更新，被拒的 ID 原样回给调用方，
    绝不静默跳过——用户需要知道哪几笔没核上。
    """
    settled = unsettled = 0
    invalid: list[str] = []
    for expense_id in settle:
        row = connection.execute(
            "SELECT id,kind,reimbursement_status,reimbursed_by,deleted_at FROM transactions WHERE id=?", (expense_id,)
        ).fetchone()
        # 已被**别的**回款核销过的支出不得改挂：UPDATE 会把 reimbursed_by 从 A 改成 B，
        # A 的核销事实在账本里彻底消失且不留痕；随后删除 B，这笔已由 A 报销到账的支出
        # 会被退回 draft，重新变成待回款。同一笔回款重复提交仍然放行（幂等重试是正常的）。
        already_settled_elsewhere = (
            row is not None
            and row["reimbursement_status"] == "reimbursed"
            and row["reimbursed_by"] not in (None, "", income_id)
        )
        if (
            row is None
            or row["deleted_at"]
            or row["kind"] != "expense"
            or row["reimbursement_status"] in SETTLEABLE_EXCLUDED_STATUSES
            or already_settled_elsewhere
        ):
            invalid.append(expense_id)
            continue
        connection.execute(
            "UPDATE transactions SET reimbursement_status='reimbursed',reimbursed_by=?,updated_at=? WHERE id=?",
            (income_id, now, expense_id),
        )
        settled += 1
    for expense_id in unsettle:
        unsettled += connection.execute(
            "UPDATE transactions SET reimbursement_status='draft',reimbursed_by=NULL,updated_at=? "
            "WHERE id=? AND reimbursed_by=?",
            (now, expense_id, income_id),
        ).rowcount
    return {"settled": settled, "unsettled": unsettled, "invalid": invalid}


def revert_for_deleted_income_in_connection(connection: sqlite3.Connection, income_id: str, now: str) -> int:
    """删除一笔回款时，把它核销过的支出退回 draft。

    否则会留下指向已删除收入的悬空 reimbursed_by，形成「幽灵已报销」：
    支出显示已核销，而那笔回款在账本里已经不存在了。
    """
    return connection.execute(
        "UPDATE transactions SET reimbursement_status='draft',reimbursed_by=NULL,updated_at=? "
        "WHERE reimbursed_by=? AND deleted_at IS NULL",
        (now, income_id),
    ).rowcount


def assert_income(row: sqlite3.Row) -> None:
    if row["deleted_at"]:
        raise DomainError("not_found", "收入流水不存在。", status=404)
    if row["kind"] != "income":
        raise DomainError("invalid_reimbursement_income", "incomeId 必须引用收入流水。", status=422)
