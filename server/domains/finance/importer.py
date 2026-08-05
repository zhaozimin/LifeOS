"""
[INPUT]: 依赖 CSV 字节、finance 主数据与交易行构造器。
[OUTPUT]: 对外提供表头嗅探、金额/类型归类、建议和两步导入的连接内提交。
[POS]: finance 的账单导入子域；preview 只读，commit 保持基线的“无查库去重”语义。
[PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
"""

from __future__ import annotations

import csv
import io
import sqlite3
from datetime import datetime, timezone
from typing import Any
from uuid import uuid4

from domains.finance.store import insert_transaction, list_categories, load_ledger_settings
from domains.finance.views import list_accounts


ALIASES = {"occurredAt": ["交易时间", "日期", "交易日期", "时间", "记账日期", "操作时间", "交易日", "交易时间(北京时间)", "记账日", "transaction time", "date", "occurredat", "trans date", "trade date"], "amount": ["金额", "金额(元)", "支出金额", "收入金额", "金额（元）", "交易金额", "交易金额(元)", "金额（收入为正,支出为负）", "amount", "amt", "支出/收入", "收/支金额", "trans amount", "trade amount"], "kindLabel": ["收/支", "收支", "收入/支出", "type", "direction", "交易类型", "借贷标志", "借贷", "收支类型", "trans type"], "merchant": ["交易对方", "商户名称", "对方名称", "商品", "商品说明", "摘要", "对方账户名称", "对方户名", "对手户名", "对方账户", "merchant", "name", "payee", "交易摘要", "用途"], "note": ["备注", "remark", "note", "memo", "附言", "用途备注"], "category": ["分类", "交易分类", "category", "支出分类", "类型"], "accountName": ["支付方式", "账户", "支付账户", "card", "account", "支付方式 / 账户", "本方账户", "我的账户", "卡号"]}
SKIP_LINES = {"wechat": 16, "alipay": 4, "generic": 0}
INCOME, EXPENSE, TRANSFER = {"收入", "income", "credit", "+", "贷", "进账", "存入", "已收"}, {"支出", "expense", "debit", "-", "借", "出账", "支取", "已付"}, {"转账", "transfer", "划转", "内部转账"}


def _decode(raw: bytes) -> str:
    for encoding in ("utf-8-sig", "utf-8", "gbk", "gb18030"):
        try: return raw.decode(encoding)
        except UnicodeDecodeError: pass
    return raw.decode("utf-8", errors="replace")


def _column(headers: list[str], aliases: list[str]) -> int | None:
    lowered = [item.strip().lower() for item in headers]
    for alias in aliases:
        for index, heading in enumerate(lowered):
            if alias.lower() == heading or alias.lower() in heading: return index
    return None


def normalize_amount(value: str) -> tuple[float, str]:
    text = str(value or "").strip().replace(",", "").replace("¥", "").replace(" ", "")
    sign = "expense" if text.startswith("-") else "income" if text.startswith("+") else "unknown"
    try: return abs(float(text.lstrip("+-"))), sign
    except ValueError: return 0.0, "unknown"


def classify_kind(label: str, sign: str) -> str:
    text = (label or "").strip().lower()
    if any(token in text for token in INCOME): return "income"
    if any(token in text for token in EXPENSE): return "expense"
    if any(token in text for token in TRANSFER): return "transfer"
    return "income" if sign == "income" else "expense"


def _date(value: str) -> str:
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y/%m/%d %H:%M:%S", "%Y.%m.%d %H:%M:%S", "%Y-%m-%d %H:%M", "%Y/%m/%d %H:%M", "%Y-%m-%d", "%Y/%m/%d", "%Y%m%d"):
        try: return datetime.strptime(str(value).strip(), fmt).replace(tzinfo=timezone.utc).isoformat()
        except ValueError: pass
    try: return datetime.fromisoformat(str(value).replace("Z", "+00:00")).isoformat()
    except (TypeError, ValueError): return datetime.now(timezone.utc).isoformat()


def _suggest(merchant: str, note: str, categories: list[dict[str, Any]], accounts: list[dict[str, Any]], counterparties: list[dict[str, Any]]) -> tuple[dict[str, Any] | None, dict[str, Any] | None, dict[str, Any] | None]:
    text, best, score = f"{merchant} {note}".lower(), None, 0
    for category in categories:
        current = sum(len(str(word)) for word in category.get("keywords") or [] if word and str(word).lower() in text)
        if current > score: best, score = category, current
    account = next((item for item in accounts if any(word and str(word).lower() in text for word in item.get("keywords") or [])), None)
    counterparty = next((item for item in counterparties if (item.get("name") or "").lower() and ((item.get("name") or "").lower() in merchant.lower() or merchant.lower() in (item.get("name") or "").lower())), None)
    return best, account, counterparty


def parse_import_content(connection: sqlite3.Connection, template: str, raw: bytes) -> dict[str, Any]:
    key, lines = template if template in SKIP_LINES else "generic", _decode(raw).splitlines()
    if SKIP_LINES[key] and len(lines) > SKIP_LINES[key]:
        for offset in range(min(SKIP_LINES[key] + 5, len(lines))):
            if any(token in lines[offset] for token in ("交易时间", "日期", "金额", "Date", "Amount", "transaction")): lines = lines[offset:]; break
        else: lines = lines[SKIP_LINES[key]:]
    if not lines: return {"transactions": [], "warnings": ["文件为空或无可解析内容"], "detected_columns": {}}
    try: dialect = csv.Sniffer().sniff("\n".join(lines[:100]), delimiters=",\t;")
    except csv.Error: dialect = csv.excel
    rows = [row for row in csv.reader(io.StringIO("\n".join(lines)), dialect=dialect) if any((cell or "").strip() for cell in row)]
    if not rows: return {"transactions": [], "warnings": ["未识别到任何数据行"], "detected_columns": {}}
    headers, detected = [item.strip().strip('"').strip("'") for item in rows[0]], {key: _column([item.strip().strip('"').strip("'") for item in rows[0]], aliases) for key, aliases in ALIASES.items()}
    if detected["amount"] is None: return {"transactions": [], "warnings": ["未识别到金额列。请使用通用 CSV 模板手动选列。"], "detected_columns": detected, "headers": headers}
    warnings = [] if detected["occurredAt"] is not None else ["未识别到时间列，默认用导入时间。"]
    categories, accounts, settings = list_categories(connection), list_accounts(connection), load_ledger_settings(connection)
    transactions = []
    for row in rows[1:]:
        cell = lambda field: (row[detected[field]] or "").strip() if detected.get(field) is not None and detected[field] < len(row) else ""
        amount, sign = normalize_amount(cell("amount"))
        if amount <= 0: continue
        merchant, note = cell("merchant"), cell("note"); category, account, cp = _suggest(merchant, note, categories, accounts, settings.get("counterparties") or [])
        transactions.append({"title": merchant or "未命名账单", "amount": round(amount, 2), "kind": classify_kind(cell("kindLabel"), sign), "occurredAt": _date(cell("occurredAt")), "merchant": merchant, "note": note, "category": {"id": category.get("id"), "name": category.get("name"), "tintHex": category.get("tintHex")} if category else None, "accountName": (account or {}).get("name") or (accounts[0]["name"] if accounts else ""), "counterpartyId": (cp or {}).get("id"), "tags": ["导入", key], "source": f"import-{key}", "sourceName": key, "reimbursementStatus": "notApplicable"})
    return {"transactions": transactions, "warnings": warnings, "detected_columns": detected, "headers": headers, "template": key}


def commit_import_transactions_in_connection(connection: sqlite3.Connection, transactions: list[dict[str, Any]], transaction_builder: Any) -> dict[str, Any]:
    imported = failed = 0; errors: list[dict[str, Any]] = []
    for index, payload in enumerate(transactions):
        try: insert_transaction(connection, transaction_builder(connection, payload, transaction_id=str(uuid4()))) ; imported += 1
        except Exception as exc: failed += 1; errors.append({"index": index, "error": str(exc)})
    return {"imported": imported, "failed": failed, "errors": errors}
