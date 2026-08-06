"""
[INPUT]: 依赖 finance.sqlite3 连接、核心 DomainError 与 finance 静态默认值。
[OUTPUT]: 对外提供 schema 演进、主数据/交易行投影和连接内读写原语；主键撞车统一收成 409 duplicate_record。
[POS]: finance 的持久化适配层；service 将复合操作放在同一 Ledger.write_transaction 中调用这里，永不跨域连接。
[PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
"""

from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timezone
from typing import Any, Iterable

from core.audit import ensure_audit_schema
from core.clock import utc_now_iso
from core.errors import DomainError
from domains.finance.constants import default_accounts, default_categories, default_ledger_settings


TRANSACTION_COLUMNS = """id, title, amount, kind, occurred_at, category_json, tags_json,
account_name, from_account_name, to_account_name, merchant, project_name, note,
reimbursement_status, source, source_name, counterparty_id, invoice_issued,
invoice_attachment_id, tax_category, currency, amount_in_base_currency, created_at, updated_at"""


def ensure_column(connection: sqlite3.Connection, table: str, column_name: str, definition: str) -> None:
    columns = {row["name"] for row in connection.execute(f"PRAGMA table_info({table})").fetchall()}
    if column_name not in columns: connection.execute(f"ALTER TABLE {table} ADD COLUMN {column_name} {definition}")


def ensure_schema_in_connection(connection: sqlite3.Connection) -> None:
    # P0 的认亲最小表使用 key/value；P2 需切换到 FinOS 的单行 JSON 设置表。
    # 先搬走旧表是唯一安全转换：SQLite 不能把 TEXT 主键原地改成 id=1 约束。
    legacy_settings: str | None = None
    settings_columns = {row["name"] for row in connection.execute("PRAGMA table_info(ledger_settings)").fetchall()}
    if settings_columns and "id" not in settings_columns:
        row = connection.execute("SELECT value FROM ledger_settings WHERE key='lastIngestedAt'").fetchone()
        legacy_settings = row["value"] if row else None
        connection.execute("ALTER TABLE ledger_settings RENAME TO ledger_settings_p0_legacy")
    connection.executescript("""
        CREATE TABLE IF NOT EXISTS transactions (
            id TEXT PRIMARY KEY, title TEXT NOT NULL, amount REAL NOT NULL, kind TEXT NOT NULL,
            occurred_at TEXT NOT NULL, category_json TEXT NOT NULL, tags_json TEXT NOT NULL,
            account_name TEXT NOT NULL, from_account_name TEXT, to_account_name TEXT,
            merchant TEXT NOT NULL, note TEXT NOT NULL, reimbursement_status TEXT NOT NULL,
            source TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS categories (id TEXT PRIMARY KEY, payload_json TEXT NOT NULL, sort_order INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY, payload_json TEXT NOT NULL, sort_order INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS ledger_settings (id INTEGER PRIMARY KEY CHECK (id = 1), payload_json TEXT NOT NULL, updated_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS attachments (id TEXT PRIMARY KEY, transaction_id TEXT NOT NULL, mime TEXT, size_bytes INTEGER NOT NULL DEFAULT 0, original_name TEXT, stored_path TEXT NOT NULL, created_at TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS idx_attachments_tx ON attachments(transaction_id);
        CREATE TABLE IF NOT EXISTS recurring_rules (id TEXT PRIMARY KEY, name TEXT NOT NULL, template_payload_json TEXT NOT NULL, frequency TEXT NOT NULL, interval_n INTEGER NOT NULL DEFAULT 1, day_of_period INTEGER, start_date TEXT NOT NULL, end_date TEXT, next_due_at TEXT NOT NULL, last_run_at TEXT, enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS idx_recurring_due ON recurring_rules(enabled, next_due_at);
    """)
    # P0 空账本已有同名最小 accounts/categories/transactions。P2 只追加列并给历史
    # 行填兼容默认，保留可能已被隔离测试写入的数据，而不是重建或丢弃。
    for table in ("accounts", "categories"):
        for name, definition in (("payload_json", "TEXT"), ("sort_order", "INTEGER NOT NULL DEFAULT 0"), ("updated_at", "TEXT")):
            ensure_column(connection, table, name, definition)
        names = {row["name"] for row in connection.execute(f"PRAGMA table_info({table})").fetchall()}
        select_name = "name" if "name" in names else "'' AS name"
        for row in connection.execute(f"SELECT id,{select_name} FROM {table} WHERE payload_json IS NULL").fetchall():
            connection.execute(f"UPDATE {table} SET payload_json=?,updated_at=? WHERE id=?", (json.dumps({"id": row["id"], "name": row["name"]}, ensure_ascii=False), utc_now_iso(), row["id"]))
    transaction_defaults = (("title", "TEXT NOT NULL DEFAULT '未命名账单'"), ("kind", "TEXT NOT NULL DEFAULT 'expense'"), ("category_json", "TEXT NOT NULL DEFAULT '{}'"), ("tags_json", "TEXT NOT NULL DEFAULT '[]'"), ("account_name", "TEXT NOT NULL DEFAULT '默认账户'"), ("from_account_name", "TEXT"), ("to_account_name", "TEXT"), ("merchant", "TEXT NOT NULL DEFAULT '未命名账单'"), ("project_name", "TEXT"), ("note", "TEXT NOT NULL DEFAULT ''"), ("reimbursement_status", "TEXT NOT NULL DEFAULT 'notApplicable'"), ("source", "TEXT NOT NULL DEFAULT 'manual'"), ("source_name", "TEXT"), ("counterparty_id", "TEXT"), ("invoice_issued", "INTEGER NOT NULL DEFAULT 0"), ("invoice_attachment_id", "TEXT"), ("tax_category", "TEXT"), ("currency", "TEXT"), ("amount_in_base_currency", "REAL"), ("created_at", "TEXT NOT NULL DEFAULT ''"), ("updated_at", "TEXT NOT NULL DEFAULT ''"), ("deleted_at", "TEXT"), ("deleted_by", "TEXT"), ("deletion_reason", "TEXT"), ("deletion_operation_id", "TEXT"), ("reimbursed_by", "TEXT"))
    for name, definition in transaction_defaults: ensure_column(connection, "transactions", name, definition)
    if legacy_settings:
        settings = default_ledger_settings(); settings["lastIngestedAt"] = legacy_settings
        connection.execute("INSERT INTO ledger_settings(id,payload_json,updated_at) VALUES(1,?,?)", (json.dumps(settings, ensure_ascii=False), utc_now_iso()))
    ensure_audit_schema(connection)


def seed_default_master_data_in_connection(connection: sqlite3.Connection) -> None:
    now = utc_now_iso()
    if connection.execute("SELECT COUNT(*) AS count FROM categories").fetchone()["count"] == 0:
        connection.executemany("INSERT INTO categories (id,payload_json,sort_order,updated_at) VALUES (?,?,?,?)", [(item["id"], json.dumps(item, ensure_ascii=False), i, now) for i, item in enumerate(default_categories())])
    if connection.execute("SELECT COUNT(*) AS count FROM accounts").fetchone()["count"] == 0:
        connection.executemany("INSERT INTO accounts (id,payload_json,sort_order,updated_at) VALUES (?,?,?,?)", [(item["id"], json.dumps(item, ensure_ascii=False), i, now) for i, item in enumerate(default_accounts())])
    if connection.execute("SELECT COUNT(*) AS count FROM ledger_settings").fetchone()["count"] == 0:
        connection.execute("INSERT INTO ledger_settings (id,payload_json,updated_at) VALUES (1,?,?)", (json.dumps(default_ledger_settings(), ensure_ascii=False), now))
    ensure_fallback_category_in_connection(connection, now)


def ensure_fallback_category_in_connection(connection: sqlite3.Connection, now: "str | None" = None) -> None:
    """保证兜底分类「未分类」始终存在——它是通道而不是用户数据。

    上面三段只在表为空时补种，所以在此之前建立的账本永远等不到新增的默认项。而 service 的
    行构造与分类归一都以「未分类」为缺省：它缺席时，一笔归不进任何现有分类的消费无论传不传
    category 都会撞上 unknown_master_data 而写不进去——用户说了一句话，账本却什么都没记。

    只补这一条，且按名字判存（用户可能自己建过同名的，那就用他的）。其余分类仍然遵守
    「AI 不得静默创建主数据」：这一条不是 AI 想建的，是系统在保证兜底通道可用。
    """
    stamp = now or utc_now_iso()
    existing = {str(item.get("name") or "").strip() for item in list_categories(connection)}
    for item in default_categories():
        if item.get("name") == "未分类" and "未分类" not in existing:
            order = (connection.execute("SELECT COALESCE(MAX(sort_order), -1) AS top FROM categories").fetchone()["top"]) + 1
            connection.execute(
                "INSERT OR IGNORE INTO categories (id,payload_json,sort_order,updated_at) VALUES (?,?,?,?)",
                (item["id"], json.dumps(item, ensure_ascii=False), order, stamp),
            )


def list_categories(connection: sqlite3.Connection) -> list[dict[str, Any]]:
    return [json.loads(row["payload_json"]) for row in connection.execute("SELECT payload_json FROM categories ORDER BY sort_order,id").fetchall()]


def raw_accounts(connection: sqlite3.Connection) -> list[dict[str, Any]]:
    return [json.loads(row["payload_json"]) for row in connection.execute("SELECT payload_json FROM accounts ORDER BY sort_order,id").fetchall()]


def load_ledger_settings(connection: sqlite3.Connection) -> dict[str, Any]:
    from domains.finance.views import infer_ledger_mode
    from domains.finance.service import normalize_counterparties, normalize_finance_sources, normalize_projects
    row = connection.execute("SELECT payload_json FROM ledger_settings WHERE id=1").fetchone()
    if row is None: return default_ledger_settings()
    try: payload = json.loads(row["payload_json"])
    except (json.JSONDecodeError, TypeError): return default_ledger_settings()
    defaults = default_ledger_settings()
    defaults.update({key: value for key, value in payload.items() if key != "projects"})
    defaults["projects"] = normalize_projects(payload.get("projects"))
    defaults["financeSources"] = normalize_finance_sources(payload.get("financeSources"))
    defaults["counterparties"] = normalize_counterparties(payload.get("counterparties"))
    defaults["ledgerMode"] = payload.get("ledgerMode") if payload.get("ledgerMode") in {"personal", "dual"} else infer_ledger_mode(connection)
    return defaults


def save_ledger_settings(connection: sqlite3.Connection, settings: dict[str, Any], now: str) -> None:
    connection.execute("UPDATE ledger_settings SET payload_json=?,updated_at=? WHERE id=1", (json.dumps(settings, ensure_ascii=False), now))


def normalized_account_pair(row: sqlite3.Row | dict[str, Any]) -> tuple[str | None, str | None]:
    value = lambda key, default=None: row.get(key, default) if isinstance(row, dict) else row[key]
    kind, account = value("kind"), value("account_name")
    from_account, to_account = value("from_account_name"), value("to_account_name")
    if kind == "income": return from_account, to_account or account
    if kind == "expense": return from_account or account, to_account
    if kind == "transfer": return from_account or account, to_account
    return from_account, to_account or account


def _safe(row: sqlite3.Row | dict[str, Any], key: str, default: Any = None) -> Any:
    if isinstance(row, dict): return row.get(key, default)
    try: return row[key]
    except IndexError: return default


def row_to_transaction(row: sqlite3.Row | dict[str, Any], attachments: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    from_account, to_account = normalized_account_pair(row)
    value = lambda key, default=None: _safe(row, key, default)
    return {"id": value("id"), "title": value("title"), "amount": value("amount"), "kind": value("kind"), "occurredAt": value("occurred_at"), "category": json.loads(value("category_json") or "{}"), "tags": json.loads(value("tags_json") or "[]"), "accountName": value("account_name"), "fromAccountName": from_account, "toAccountName": to_account, "merchant": value("merchant"), "projectName": value("project_name"), "note": value("note"), "reimbursementStatus": value("reimbursement_status"), "reimbursedBy": value("reimbursed_by"), "source": value("source"), "sourceName": value("source_name"), "counterpartyId": value("counterparty_id"), "invoiceIssued": bool(value("invoice_issued", 0)), "invoiceAttachmentId": value("invoice_attachment_id"), "taxCategory": value("tax_category") or "personal", "currency": value("currency"), "amountInBaseCurrency": value("amount_in_base_currency"), "deletedAt": value("deleted_at"), "deletedBy": value("deleted_by"), "deletionReason": value("deletion_reason"), "deletionOperationId": value("deletion_operation_id"),
            # createdAt/updatedAt 在 transactions 表里一直存在，只是从未被投影出来。
            # finview 靠二者是否相等区分「已入账 ✓」与「已更正 ↻」，缺了它们那条分支恒不成立。
            "createdAt": value("created_at"), "updatedAt": value("updated_at"),
            "attachments": attachments or []}


def get_transaction(connection: sqlite3.Connection, transaction_id: str, *, include_deleted: bool = True) -> sqlite3.Row:
    row = connection.execute("SELECT * FROM transactions WHERE id=?" + ("" if include_deleted else " AND deleted_at IS NULL"), (transaction_id,)).fetchone()
    if row is None: raise DomainError("not_found", "流水不存在。", status=404)
    return row


def attachments_for_transactions(connection: sqlite3.Connection, transaction_ids: Iterable[str]) -> dict[str, list[dict[str, Any]]]:
    ids = list(transaction_ids)
    if not ids: return {}
    rows = connection.execute(f"SELECT id,transaction_id,mime,size_bytes,original_name,created_at FROM attachments WHERE transaction_id IN ({','.join('?' * len(ids))}) ORDER BY created_at", ids).fetchall()
    out: dict[str, list[dict[str, Any]]] = {}
    for row in rows: out.setdefault(row["transaction_id"], []).append({"id": row["id"], "mime": row["mime"], "sizeBytes": row["size_bytes"], "originalName": row["original_name"], "createdAt": row["created_at"]})
    return out


def insert_transaction(connection: sqlite3.Connection, row: dict[str, Any]) -> None:
    """写入一行流水；主键撞车收成 409 而不是让裸 IntegrityError 冒出去。

    带已存在 id 重发是**最确定**的一种失败：那一行原封不动躺在库里，本次一个字节都没写进去。
    可裸 IntegrityError 会被 core/httpd.py 的 `except Exception` 兜成 500，而 lifeconn
    把一切 5xx 翻译成「写入结果未知；禁止重试，请先只读核查」——最确定的失败被降级成
    最不确定的一种，Agent 于是去翻账本，而不是直接告诉用户「这笔早就记过了」。
    只有主键确实已存在才改判；NOT NULL 之类的约束破裂是代码缺陷，仍应原样炸成 500。
    """
    try:
        connection.execute(f"INSERT INTO transactions ({TRANSACTION_COLUMNS}) VALUES ({','.join(':'+field.strip() for field in TRANSACTION_COLUMNS.split(','))})", row)
    except sqlite3.IntegrityError as exc:
        existing = connection.execute("SELECT id FROM transactions WHERE id=?", (row.get("id"),)).fetchone()
        if existing is None: raise
        raise DomainError(
            "duplicate_record", f"流水 {existing['id']} 已存在，本次未写入任何内容。", status=409,
            existingId=existing["id"],
            agentInstruction="这是明确的「未写入」，禁止重试。先用只读查询核对既有那一笔，再向用户确认是补记新的一笔还是改这一笔。",
        ) from exc


def update_transaction(connection: sqlite3.Connection, row: dict[str, Any]) -> None:
    fields = [item.strip() for item in TRANSACTION_COLUMNS.split(",") if item.strip() not in {"id", "created_at"}]
    connection.execute(f"UPDATE transactions SET {','.join(field+'=:'+field for field in fields)} WHERE id=:id", row)
    # reimbursed_by 不在 TRANSACTION_COLUMNS 里，任何常规更新都碰不到它。
    # 于是把状态改成 notApplicable 后，它仍指向原来那笔回款；随后删除该回款时，
    # revert_for_deleted_income_in_connection 按 reimbursed_by 匹配，
    # 把用户明确声明「与报销无关」的支出强行翻回 draft，pendingReimbursement 凭空长回来。
    # 这里把不变量收在唯一写入口：只有 reimbursed 状态才配持有 reimbursed_by。
    connection.execute(
        "UPDATE transactions SET reimbursed_by=NULL WHERE id=:id AND reimbursement_status<>'reimbursed'", row
    )
