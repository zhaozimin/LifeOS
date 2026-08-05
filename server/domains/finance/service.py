"""
[INPUT]: 依赖 finance Ledger、各财务算法模块、core 审计和 DomainError。
[OUTPUT]: 对外提供 finance schema、附件域内路径的降级式归一化、事务编排、
           含账户改名传播与余额调整补差的配置写入、单币种/周期暂停 MVP 闸、
           新建路径独有的重复提交时间窗闸，以及账目的不可覆盖前后版本。
[POS]: finance 的应用服务层；每个写操作只开 finance.write_transaction，绝不导入或锁住 time 账本。
[PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
"""

from __future__ import annotations

import base64
import json
import mimetypes
import sqlite3
import sys
from datetime import datetime

from core.clock import now_record_iso, record_timezone
from pathlib import Path
from typing import Any
from uuid import uuid4

from core.audit import append_audit_event, append_record_revision, checkpoint_after_commit
from core.errors import DomainError
from core.sqlite import Ledger
from domains.finance.constants import (
    ATTACHMENT_MAX_BYTES, IMPORT_MAX_BYTES, REIMBURSEMENT_STATUSES,
    MVP_BASE_CURRENCY, MVP_RECURRING_PAUSED, MVP_SINGLE_CURRENCY,
    VALID_LEDGER_MODES, default_ledger_settings,
)
from domains.finance.currency import (
    coerce_bool, coerce_float, fetch_exchange_rates_from_api, normalize_exchange_rates,
    rescale_base_snapshot, resolve_amount_in_base, resolve_transaction_currency, utc_now_iso,
)
from domains.finance.guardrails import assert_not_recent_duplicate, assert_unique_master_names, require_user_confirmation, validate_agent_transaction_refs
from domains.finance.export_xlsx import build_export_workbook, build_tax_report_workbook
from domains.finance.importer import commit_import_transactions_in_connection, parse_import_content
from domains.finance.recurring import (
    catchup_recurring_rules_in_connection, normalize_recurring_payload, recurring_row_to_dict,
)
from domains.finance.reimbursement import (
    assert_income, revert_for_deleted_income_in_connection,
    set_reimbursement_status_in_connection, settle_in_connection,
)
from domains.finance.reports import (
    budget_status as report_budget_status, dashboard_overview,
    habits as report_habits, monthly_summary,
)
from domains.finance.store import (
    attachments_for_transactions, ensure_schema_in_connection, get_transaction, insert_transaction,
    list_categories, load_ledger_settings, raw_accounts, row_to_transaction, save_ledger_settings,
    seed_default_master_data_in_connection, update_transaction as update_transaction_in_connection,
)
from domains.finance.views import (
    build_adjustment_payload, current_balance_for_account, list_accounts, normalize_ownership,
)


def ensure_schema(ledger: Ledger) -> None:
    with ledger.write_transaction() as connection:
        ensure_schema_in_connection(connection)
        _normalize_attachment_paths_in_connection(ledger, connection)
        seed_default_master_data_in_connection(connection)


def _attachment_relative_path(value: object) -> Path:
    """只接受 finance 域内 `attachments/` 的相对路径，阻断历史绝对路径越界。"""
    relative = Path(str(value or ""))
    if relative.is_absolute() or ".." in relative.parts or not relative.parts or relative.parts[0] != "attachments":
        raise DomainError("invalid_attachment_path", "附件路径必须位于财务账本的 attachments 目录。", status=500)
    return relative


def _attachment_file_path(ledger: Ledger, value: object) -> Path:
    """将已验证的相对路径投影为当前 finance runtime 内的唯一文件位置。"""
    root = ledger.db_path.parent.resolve()
    target = (root / _attachment_relative_path(value)).resolve()
    try:
        target.relative_to(root)
    except ValueError as error:
        raise DomainError("invalid_attachment_path", "附件路径越出财务运行目录。", status=500) from error
    return target


def _legacy_attachment_relative_path(value: object) -> Path:
    """从封存旧库的绝对路径提取 `attachments/` 后缀；映射不唯一时交由调用方降级。"""
    source = Path(str(value or ""))
    if not source.is_absolute():
        return _attachment_relative_path(source)
    markers = [index for index, part in enumerate(source.parts) if part == "attachments"]
    if len(markers) != 1:
        raise DomainError(
            "ambiguous_attachment_path", "旧附件路径无法唯一映射到 finance/attachments。", status=500
        )
    return _attachment_relative_path(Path(*source.parts[markers[0]:]))


def _normalize_attachment_paths_in_connection(ledger: Ledger, connection: sqlite3.Connection) -> None:
    """把历史绝对路径收敛为域内相对路径。

    此处刻意**不**因单条附件异常而中止启动。这是单进程综合体：抛错会连时间域
    一起掀掉，而一条孤儿附件记录只是数据质量问题，不是拒绝提供时间统计的理由。
    更要命的是本项目的审计快照只备份 .sqlite3、不备份 attachments/，用快照回滚
    后必然进入这个状态——fail-closed 在这里会把恢复手段本身变成故障源。
    无法归一或文件缺失的行原样保留，读取该附件时自然 404。
    """
    rows = connection.execute("SELECT id,stored_path FROM attachments ORDER BY id").fetchall()
    unresolved: list[str] = []
    for row in rows:
        try:
            relative = _legacy_attachment_relative_path(row["stored_path"])
            target = _attachment_file_path(ledger, relative)
        except DomainError:
            unresolved.append(f"{row['id']}（路径无法归一：{row['stored_path']}）")
            continue
        if not target.is_file():
            unresolved.append(f"{row['id']}（文件缺失：{relative.as_posix()}）")
            continue
        normalized = relative.as_posix()
        if row["stored_path"] != normalized:
            connection.execute("UPDATE attachments SET stored_path=? WHERE id=?", (normalized, row["id"]))
    if unresolved:
        print(
            f"[LifeOS] 财务附件有 {len(unresolved)} 条无法定位，已跳过归一化："
            f"{'、'.join(unresolved[:5])}{' …' if len(unresolved) > 5 else ''}",
            file=sys.stderr,
            flush=True,
        )


def health_projection(ledger: Ledger) -> dict[str, Any]:
    connection = ledger.connect()
    try: value = load_ledger_settings(connection).get("lastIngestedAt")
    finally: connection.close()
    return {"dbPath": str(ledger.db_path), "lastIngestedAt": value}


def normalize_projects(items: object) -> list[dict[str, Any]]:
    if not isinstance(items, list): return default_ledger_settings()["projects"]
    out = []
    for index, item in enumerate(items):
        if not isinstance(item, dict): continue
        goal = item.get("goal") if isinstance(item.get("goal"), dict) else None; target = coerce_float((goal or {}).get("targetAmount"))
        out.append({"id": item.get("id") or f"project-{index+1}", "name": str(item.get("name") or f"项目 {index+1}").strip() or f"项目 {index+1}", "direction": "收入" if item.get("direction") == "收入" else "支出", "group": str(item.get("group") or item.get("name") or f"项目 {index+1}").strip(), "note":str(item.get("note") or ""), "trackingEnabled":coerce_bool(item.get("trackingEnabled")), "goal": {"targetAmount":target,"targetDate":str(goal.get("targetDate") or "")[:10] or None,"sourceAccountId":str(goal.get("sourceAccountId") or ""),"description":str(goal.get("description") or "")} if target > 0 else None, "expectedCost":coerce_float(item.get("expectedCost")), "expectedRevenue":coerce_float(item.get("expectedRevenue")), "startDate":str(item.get("startDate") or "")[:10] or None,"endDate":str(item.get("endDate") or "")[:10] or None})
    return out or default_ledger_settings()["projects"]


def normalize_finance_sources(items: object) -> list[dict[str, Any]]:
    if not isinstance(items, list): return default_ledger_settings()["financeSources"]
    return [{"id":item.get("id") or f"source-{index+1}","name":str(item.get("name") or f"资金来源 {index+1}").strip() or f"资金来源 {index+1}","defaultAccountId":str(item.get("defaultAccountId") or ""),"note":str(item.get("note") or ""),"tintHex":str(item.get("tintHex") or "#87B99B"),"deletedAt":item.get("deletedAt") or None,"deletedBy":item.get("deletedBy") or None,"deletionReason":item.get("deletionReason") or None} for index,item in enumerate(items) if isinstance(item,dict)] or default_ledger_settings()["financeSources"]


def normalize_counterparties(items: object) -> list[dict[str, Any]]:
    if not isinstance(items, list): return []
    return [{"id":item.get("id") or f"counterparty-{index+1}","name":str(item.get("name") or f"对手方 {index+1}").strip() or f"对手方 {index+1}","kind":item.get("kind") if item.get("kind") in {"client","vendor","employer","other"} else "client","tintHex":str(item.get("tintHex") or "#7F91D6"),"defaultAccountId":str(item.get("defaultAccountId") or ""),"note":str(item.get("note") or ""),"contactInfo":str(item.get("contactInfo") or "")} for index,item in enumerate(items) if isinstance(item,dict)]


def _existing(row: sqlite3.Row | None, key: str, default: Any = None) -> Any:
    if row is None: return default
    try: return row[key]
    except IndexError: return default


def _normalize_iso(value: object, fallback: str) -> str:
    if not value: return fallback
    try: return datetime.fromisoformat(str(value).replace("Z", "+00:00")).isoformat()
    except ValueError: return fallback


def _base_snapshot(payload: dict[str, Any], existing_row: sqlite3.Row | None, connection: sqlite3.Connection, currency_in: object, account: str) -> object:
    """决定本位币快照该沿用、缩放还是重算。

    此前这里直接把库里的旧值当成「调用方显式指定」原样交给 resolve_amount_in_base，
    于是编辑金额或币种后本位币永不更新——而面板的收支合计优先取这个字段。
    """
    if "amountInBaseCurrency" in payload:
        return payload["amountInBaseCurrency"]          # 调用方明说了，照办
    if existing_row is None:
        return None                                     # 新建：按当前汇率算
    previous_currency = str(_existing(existing_row, "currency", "") or "")
    if resolve_transaction_currency(connection, currency_in, account) != previous_currency:
        return None                                     # 换了币种：旧汇率不适用，重算
    if "amount" not in payload:
        return _existing(existing_row, "amount_in_base_currency")   # 金额没动：快照原样保留
    return rescale_base_snapshot(
        _existing(existing_row, "amount", 0),
        _existing(existing_row, "amount_in_base_currency"),
        payload["amount"],
    )


def transaction_row_from_payload(connection: sqlite3.Connection, payload: dict[str, Any], *, now: str | None = None, transaction_id: str | None = None, existing_row: sqlite3.Row | None = None) -> dict[str, Any]:
    # now 是机器时刻（created_at/updated_at）；occurred_at 是用户墙钟时刻，两者语义不同不可共用一个值。
    # 曾经共用 utc_now_iso()：记录时区 Asia/Shanghai 的用户在北京 19:43 记的账，
    # 落库成 11:43+00:00，前端按字符串切片渲染就显示 11:43，北京 00:00–08:00 的账更会退到前一天。
    now = now or utc_now_iso()
    try: category = json.loads(_existing(existing_row,"category_json","") or "{}")
    except json.JSONDecodeError: category = None
    try: tags = json.loads(_existing(existing_row,"tags_json","") or "[]")
    except json.JSONDecodeError: tags = []
    category = payload.get("category") or category or {"id":str(uuid4()),"name":"未分类","systemImage":"tray","tintHex":"#607D8B","keywords":[]}; tags = payload.get("tags") if isinstance(payload.get("tags"), list) else tags
    title = str(payload.get("title") or _existing(existing_row,"title","") or payload.get("merchant") or "未命名账单"); merchant = str(payload.get("merchant") or _existing(existing_row,"merchant","") or title)
    kind = str(payload.get("type") or payload.get("kind") or _existing(existing_row,"kind","expense")); account = str(payload.get("accountName") or _existing(existing_row,"account_name","默认账户") or "默认账户")
    from_account = payload.get("fromAccountName") if "fromAccountName" in payload else _existing(existing_row,"from_account_name"); to_account = payload.get("toAccountName") if "toAccountName" in payload else _existing(existing_row,"to_account_name")
    # 显式 accountName 必须压过库里残留的方向字段：调用方明说了账户，
    # 旧值只是上一次写入留下的、本次尚未被覆盖的痕迹。
    # 此前顺序反了——更新一笔支出时只传 accountName 会被旧 from_account_name 顶掉，
    # 写入静默无效，而回执照常渲染「↻ 已更正」，参考文档还要求 Agent 逐字转达。
    stated_account = str(payload["accountName"]).strip() if str(payload.get("accountName") or "").strip() else None
    if kind == "income":
        if "toAccountName" not in payload and stated_account: to_account = stated_account
        from_account, to_account, account = None, to_account or account, str(to_account or account)
    elif kind == "expense":
        if "fromAccountName" not in payload and stated_account: from_account = stated_account
        from_account, to_account, account = from_account or account, None, str(from_account or account)
    elif kind == "transfer": from_account, to_account, account = from_account or account, to_account or payload.get("targetAccountName") or merchant or "", str(from_account or account)
    currency_in = payload.get("currency") if "currency" in payload else _existing(existing_row,"currency"); settings = load_ledger_settings(connection)
    return {"id":transaction_id or _existing(existing_row,"id") or str(uuid4()),"title":title,"amount":float(payload.get("amount",_existing(existing_row,"amount",0)) or 0),"kind":kind,"occurred_at":_normalize_iso(payload.get("occurredAt"),_existing(existing_row,"occurred_at",now_record_iso())),"category_json":json.dumps(category,ensure_ascii=False),"tags_json":json.dumps(tags if isinstance(tags,list) else [],ensure_ascii=False),"account_name":account,"from_account_name":from_account,"to_account_name":to_account,"merchant":merchant,"project_name":payload.get("projectName") if "projectName" in payload else _existing(existing_row,"project_name"),"note":str(payload.get("note",_existing(existing_row,"note","")) or ""),"reimbursement_status":str(payload.get("reimbursementStatus",_existing(existing_row,"reimbursement_status","notApplicable")) or "notApplicable"),"source":str(payload.get("source",_existing(existing_row,"source","openClaw")) or "openClaw"),"source_name":payload.get("sourceName") if "sourceName" in payload else _existing(existing_row,"source_name"),"counterparty_id":(payload.get("counterpartyId") if "counterpartyId" in payload else _existing(existing_row,"counterparty_id")) or None,"invoice_issued":int(coerce_bool(payload.get("invoiceIssued"),False) if "invoiceIssued" in payload else bool(_existing(existing_row,"invoice_issued",0))),"invoice_attachment_id":(payload.get("invoiceAttachmentId") if "invoiceAttachmentId" in payload else _existing(existing_row,"invoice_attachment_id")) or None,"tax_category":payload.get("taxCategory") if payload.get("taxCategory") in {"business-income","business-expense-deductible","business-expense-nondeductible","personal","transfer"} else (_existing(existing_row,"tax_category") or "personal"),"currency":resolve_transaction_currency(connection,currency_in,account),"amount_in_base_currency":resolve_amount_in_base(connection,_base_snapshot(payload,existing_row,connection,currency_in,account),payload.get("amount",_existing(existing_row,"amount",0)),currency_in,account,settings),"created_at":_existing(existing_row,"created_at",now),"updated_at":now}


def _amount(payload: dict[str, Any]) -> None:
    if "amount" not in payload or payload["amount"] is None: return
    value = coerce_float(payload["amount"], float("nan"))
    if value != value or value < 0: raise DomainError("invalid_amount","amount 必须是有限的非负数。",status=400)


def _touch_settings(connection: sqlite3.Connection, now: str) -> None:
    settings = load_ledger_settings(connection); settings["lastIngestedAt"] = now; settings["updatedAt"] = now; save_ledger_settings(connection,settings,now)


def _revision_actor(source: object) -> str:
    resolved = str(source or "openClaw")
    if resolved == "manual": return "dashboard"
    if resolved == "openClaw": return "agent"
    return resolved


def _require_mvp_currency(
    row: dict[str, Any], *, existing: sqlite3.Row | None = None, payload: dict[str, Any] | None = None,
) -> None:
    """MVP 只允许人民币；历史外币记录可改标题/备注，但不能继续改金额或币种。"""
    if not MVP_SINGLE_CURRENCY or str(row.get("currency") or MVP_BASE_CURRENCY).upper() == MVP_BASE_CURRENCY:
        return
    changing_money = existing is None or any(
        key in (payload or {})
        for key in ("amount", "currency", "accountName", "fromAccountName", "toAccountName")
    )
    if changing_money:
        raise DomainError(
            "mvp_single_currency_only", "当前 MVP 只支持人民币 CNY；多币种已暂停。", status=409,
        )


def _foreign_account_money_changed(item: dict[str, Any], previous: dict[str, Any] | None) -> bool:
    """判断外币账户的持久化金额语义是否改变，忽略投影层补出的 0.0。"""
    if previous is None:
        return True
    return any((
        str(item.get("currency") or MVP_BASE_CURRENCY).upper()
        != str(previous.get("currency") or MVP_BASE_CURRENCY).upper(),
        coerce_float(item.get("openingBalance")) != coerce_float(previous.get("openingBalance")),
        coerce_float(item.get("creditLimit")) != coerce_float(previous.get("creditLimit")),
        _classification_of(item) != _classification_of(previous),
        str(item.get("type") or "") != str(previous.get("type") or ""),
    ))


def create_transaction(ledger: Ledger, payload: dict[str, Any]) -> dict[str, Any]:
    _amount(payload); now = utc_now_iso()
    with ledger.write_transaction() as connection:
        row = transaction_row_from_payload(connection,payload,now=now,transaction_id=payload.get("id") or str(uuid4())); _require_mvp_currency(row, payload=payload); validate_agent_transaction_refs(connection,row); assert_not_recent_duplicate(connection,row,payload); insert_transaction(connection,row); _touch_settings(connection,now)
        created = row_to_transaction(row)
        event = append_record_revision(
            connection, occurred_at=utc_now_iso(), actor=_revision_actor(created.get("source")),
            action="create", entity_type="transaction", entity_id=created["id"],
            entity_name=created["title"], before=None, after=created,
        )
        checkpoint = checkpoint_after_commit(connection, ledger, event)
    if checkpoint[0]: created["auditWarning"] = checkpoint[0]
    return created


def update_transaction(ledger: Ledger, transaction_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    _amount(payload); now = utc_now_iso()
    with ledger.write_transaction() as connection:
        existing = get_transaction(connection,transaction_id); before = row_to_transaction(existing)
        row = transaction_row_from_payload(connection,payload,now=now,transaction_id=transaction_id,existing_row=existing); _require_mvp_currency(row, existing=existing, payload=payload); validate_agent_transaction_refs(connection,row,existing); update_transaction_row(connection,row); _touch_settings(connection,now)
        updated = row_to_transaction(row)
        event = append_record_revision(
            connection, occurred_at=utc_now_iso(), actor=_revision_actor(updated.get("source")),
            action="update", entity_type="transaction", entity_id=transaction_id,
            entity_name=updated["title"], before=before, after=updated,
            reason=str(payload.get("reason") or "修改账目"),
        )
        checkpoint = checkpoint_after_commit(connection, ledger, event)
    if checkpoint[0]: updated["auditWarning"] = checkpoint[0]
    return updated


def update_transaction_row(connection: sqlite3.Connection, row: dict[str, Any]) -> None: update_transaction_in_connection(connection,row)


def list_transactions(ledger: Ledger, query: dict[str, str]) -> list[dict[str, Any]]:
    connection = ledger.connect()
    try:
        rows = connection.execute("SELECT * FROM transactions ORDER BY occurred_at DESC,created_at DESC").fetchall(); attachments = attachments_for_transactions(connection,[row["id"] for row in rows])
        items = [row_to_transaction(row,attachments.get(row["id"],[])) for row in rows]
    finally: connection.close()
    if query.get("includeDeleted") not in {"1","true","yes"}: items=[item for item in items if not item.get("deletedAt")]
    for key, field in (("kind","kind"),("reimbursementStatus","reimbursementStatus"),("accountName","accountName")):
        if query.get(key): items=[item for item in items if item.get(field)==query[key]]
    if query.get("month"): items=[item for item in items if item["occurredAt"][:7]==query["month"]]
    if query.get("tag"): items=[item for item in items if query["tag"] in item["tags"]]
    if query.get("categoryId"): items=[item for item in items if item["category"].get("id")==query["categoryId"]]
    if query.get("q"):
        needle=query["q"].lower(); items=[item for item in items if needle in " ".join([str(item.get(key) or "") for key in ("title","accountName","merchant","projectName","note","sourceName")]+item["tags"]+[item["category"].get("name","")]).lower()]
    try: return items[:max(int(query["limit"]),0)] if query.get("limit") else items
    except ValueError: return items


def delete_transaction(ledger: Ledger, transaction_id: str, *, actor: str = "dashboard", reason: str = "删除流水") -> dict[str, Any]:
    now, operation = utc_now_iso(), str(uuid4())
    with ledger.write_transaction() as connection:
        tx = row_to_transaction(get_transaction(connection,transaction_id))
        if tx.get("deletedAt"): raise DomainError("already_deleted","流水已删除。",status=409)
        connection.execute("UPDATE transactions SET deleted_at=?,deleted_by=?,deletion_reason=?,deletion_operation_id=?,updated_at=? WHERE id=?",(now,actor,reason,operation,now,transaction_id)); cascaded=0
        if tx["kind"] == "income": cascaded=revert_for_deleted_income_in_connection(connection,transaction_id,now)
        deleted = row_to_transaction(get_transaction(connection, transaction_id))
        event={"id":operation,"occurredAt":now,"actor":actor,"action":"delete","entityType":"transaction","entityId":transaction_id,"entityName":tx["title"],"impact":{"amount":tx["amount"],"kind":tx["kind"],"accountName":tx["accountName"],"reimbursementsUnsettled":cascaded},"payload":{"before":tx,"after":deleted,"reason":reason}}; append_audit_event(connection,event); _touch_settings(connection,now); checkpoint = checkpoint_after_commit(connection, ledger, event)
    warning = checkpoint[0] or None
    result = {"ok": True, "id": transaction_id, "operation": event}
    if warning:
        result["auditWarning"] = warning
    return result


def update_reimbursement(ledger: Ledger, transaction_id: str, status: str) -> dict[str, Any]:
    if status not in REIMBURSEMENT_STATUSES: raise DomainError("invalid_status","报销状态无效。",status=400)
    with ledger.write_transaction() as connection:
        row=get_transaction(connection,transaction_id)
        set_reimbursement_status_in_connection(connection,transaction_id,status,row["reimbursed_by"],utc_now_iso())
    return {"ok":True,"id":transaction_id,"status":status}


def settle_reimbursement(ledger: Ledger, payload: dict[str, Any]) -> dict[str, Any]:
    income_id=str(payload.get("incomeId") or ""); settle=[str(item) for item in payload.get("settleIds") or [] if item]; unsettle=[str(item) for item in payload.get("unsettleIds") or [] if item]
    if not income_id: raise DomainError("invalid_request","缺少 incomeId。",status=400)
    if not settle and not unsettle: raise DomainError("invalid_request","没有可核销项。",status=400)
    with ledger.write_transaction() as connection:
        assert_income(get_transaction(connection,income_id))
        outcome=settle_in_connection(connection,income_id,settle,unsettle,utc_now_iso())
    return {"ok":True,"incomeId":income_id,**outcome}


def recurring(ledger: Ledger, method: str, rule_id: str | None = None, payload: dict[str, Any] | None = None) -> Any:
    payload=payload or {}
    if MVP_RECURRING_PAUSED:
        if method == "list": return []
        raise DomainError("mvp_recurring_paused", "周期账目在当前 MVP 中已暂停。", status=409)
    if method == "list":
        connection=ledger.connect()
        try: return [recurring_row_to_dict(row) for row in connection.execute("SELECT * FROM recurring_rules ORDER BY enabled DESC,next_due_at,created_at").fetchall()]
        finally: connection.close()
    if method == "delete":
        with ledger.write_transaction() as connection:
            if connection.execute("DELETE FROM recurring_rules WHERE id=?",(rule_id,)).rowcount==0: raise DomainError("not_found","周期规则不存在。",status=404)
        return {"ok":True,"id":rule_id}
    normalized=normalize_recurring_payload(payload); now=utc_now_iso(); identifier=rule_id or str(payload.get("id") or uuid4())
    with ledger.write_transaction() as connection:
        if method == "create": connection.execute("INSERT INTO recurring_rules (id,name,template_payload_json,frequency,interval_n,day_of_period,start_date,end_date,next_due_at,last_run_at,enabled,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,NULL,?,?,?)",(identifier,normalized["name"],normalized["template_payload_json"],normalized["frequency"],normalized["interval_n"],normalized["day_of_period"],normalized["start_date"],normalized["end_date"],normalized["next_due_at"],normalized["enabled"],now,now))
        else:
            if connection.execute("SELECT 1 FROM recurring_rules WHERE id=?",(identifier,)).fetchone() is None: raise DomainError("not_found","周期规则不存在。",status=404)
            connection.execute("UPDATE recurring_rules SET name=?,template_payload_json=?,frequency=?,interval_n=?,day_of_period=?,start_date=?,end_date=?,next_due_at=?,enabled=?,updated_at=? WHERE id=?",(*normalized.values(),now,identifier))
        row=connection.execute("SELECT * FROM recurring_rules WHERE id=?",(identifier,)).fetchone()
    # 周期规则是 E9 的特殊写入：规则本身可能新建一个已到期债务，必须在同一请求
    # 中立即兑现。路由层因此不再在规则 create/update 前重复调用通用 catchup。
    catchup(ledger)
    return recurring_row_to_dict(row)


def catchup(ledger: Ledger) -> dict[str, Any]:
    """按 E9 追平到期的周期交易。

    先用只读连接确认「确实有到期规则」再开写事务：E9 把触发点铺到了每一次财务写入
    与每一次打开财务看板，若无条件开 BEGIN IMMEDIATE，等于每刷一次看板就抢一把
    写锁。这里不做时间窗 debounce——E9 已经把触发点收窄过一轮，再加时间窗会让
    「写请求前必定追平」这条契约变成概率事件。

    （此前这里有一个 force 形参，接收后从未使用；调用方注释还依赖它表达语义。）
    """
    if MVP_RECURRING_PAUSED:
        return {"generated": 0, "paused": True}
    today = datetime.now(record_timezone()[0]).date().isoformat()  # 业务日按记录时区，不问宿主系统
    connection = ledger.connect()
    try:
        due = connection.execute(
            "SELECT 1 FROM recurring_rules WHERE enabled=1 AND next_due_at<=? LIMIT 1", (today,)
        ).fetchone()
    finally:
        connection.close()
    if due is None:
        return {"generated": 0}
    with ledger.write_transaction() as connection:
        generated = catchup_recurring_rules_in_connection(connection, transaction_row_from_payload)
    return {"generated": generated}


def import_preview(ledger: Ledger, payload: dict[str, Any]) -> dict[str, Any]:
    encoded=payload.get("content")
    if not isinstance(encoded,str) or not encoded: raise DomainError("invalid_import","content 必须是 base64 字符串。",status=400)
    try: raw=base64.b64decode(encoded,validate=True)
    except Exception as exc: raise DomainError("invalid_import","content 不是有效 base64。",status=400) from exc
    if len(raw)>IMPORT_MAX_BYTES: raise DomainError("payload_too_large","账单文件超过 20MB。",status=413)
    connection=ledger.connect()
    try: return parse_import_content(connection,str(payload.get("template") or "generic"),raw)
    finally: connection.close()


def _guarded_import_row(connection: sqlite3.Connection, payload: dict[str, Any], **kwargs: Any) -> dict[str, Any]:
    """导入落库前套上与单笔写入相同的两道闸。

    此前 commit 直接调 transaction_row_from_payload，既不校验金额也不过 AI 引用护栏——
    它是全仓唯一不校验金额的写路径：负数落库会让「账户余额推导 == 流水之和」的恒等关系破裂，
    inf 落库更狠，dashboard 直接 500、三个只读端点吐出裸 Infinity（不是合法 JSON），
    面板 response.json().catch(() => null) 于是把 200 响应静默变成 null，整个财务区无法自救。

    引用护栏保留 source_requires_guardrail 的原有豁免：source="import" 是真实银行账单，
    本来就该允许未知账户先落库再由用户归并；被堵的是把 source 写成 AI 来源混进这条路径。
    """
    _amount(payload)
    row = transaction_row_from_payload(connection, payload, **kwargs)
    _require_mvp_currency(row, payload=payload)
    validate_agent_transaction_refs(connection, row)
    return row


def import_commit(ledger: Ledger, payload: dict[str, Any]) -> dict[str, Any]:
    transactions=payload.get("transactions")
    if not isinstance(transactions,list) or not transactions: raise DomainError("invalid_import","transactions 必须是非空数组。",status=400)
    with ledger.write_transaction() as connection: return commit_import_transactions_in_connection(connection,transactions,_guarded_import_row)


def configuration(ledger: Ledger) -> dict[str, Any]:
    connection=ledger.connect()
    try: return {"categories":list_categories(connection),"accounts":list_accounts(connection),"settings":load_ledger_settings(connection)}
    finally: connection.close()


def _scrub_account_ref(value: object, valid_ids: set[str]) -> str:
    """悬空的 defaultAccountId 一律清空，避免设置页引用一个已被删掉的账户。"""
    candidate = str(value or "")
    return candidate if candidate in valid_ids else ""


def _normalized_category(item: dict[str, Any], index: int, valid_account_ids: set[str]) -> dict[str, Any]:
    """归一化一条类别，同时保住基线里存在、面板正在编辑的扩展字段。

    这里刻意先 dict(item) 再覆盖：曾经的写法是从固定八个键新建字典，
    结果 group / defaultAccountId / projectId / note 每次保存都被静默抹掉——
    面板上「默认账户」「项目归属」永远存不住，导出 XLSX 的「分组」列永久变空。
    """
    identifier = item.get("id") or f"category-{index + 1}"
    name = str(item.get("name") or "未分类").strip() or "未分类"
    normalized = dict(item)
    normalized.update({
        "id": identifier,
        "name": name,
        "systemImage": item.get("systemImage", "tray"),
        "tintHex": item.get("tintHex", "#607D8B"),
        "keywords": item.get("keywords") if isinstance(item.get("keywords"), list) else [],
        "direction": "收入" if item.get("direction") == "收入" else "支出",
        "group": str(item.get("group") or ""),
        "defaultAccountId": _scrub_account_ref(item.get("defaultAccountId"), valid_account_ids),
        "projectId": str(item.get("projectId") or ""),
        "note": str(item.get("note") or ""),
        "monthlyBudget": coerce_float(item.get("monthlyBudget")),
        "deletedAt": item.get("deletedAt") or None,
        "deletedBy": item.get("deletedBy") or None,
        "deletionReason": item.get("deletionReason") or None,
    })
    return normalized


def _classification_of(item: dict[str, Any]) -> str:
    if item.get("classification") in {"asset", "liability"}:
        return str(item["classification"])
    return "liability" if item.get("type") == "creditCard" else "asset"


def _plan_account_write(
    connection: sqlite3.Connection, item: dict[str, Any], index: int, existing_by_id: dict[str, dict[str, Any]]
) -> tuple[dict[str, Any], tuple[str, str] | None, dict[str, Any] | None]:
    """把一条账户提交拆成「要落库的 payload / 改名对 / 待写的余额调整」。

    对**已存在**的账户，openingBalance 永远保持基线不受 PUT 影响：面板那个输入框
    绑定的是 currentBalance（用户期望的当前余额），语义是「请把账做平到这个数」，
    不是「改初始余额」。差额必须落成一条 adjustment 交易，否则用户的对账动作会变成
    一次静默覆盖——而且因为 currentBalance 每次读取都由交易重算，界面上那个数还会弹回去。
    """
    identifier = item.get("id") or f"account-{index + 1}"
    name = str(item.get("name") or f"账户{index + 1}").strip() or f"账户{index + 1}"
    classification = _classification_of(item)
    previous = existing_by_id.get(str(identifier))
    rename: tuple[str, str] | None = None
    adjustment: dict[str, Any] | None = None

    if previous is not None:
        opening = coerce_float(previous.get("openingBalance"))
        old_name = str(previous.get("name") or "").strip()
        if old_name and old_name != name:
            rename = (old_name, name)
        # 改名后历史交易此刻仍挂在旧名下，余额必须按旧名查；
        # 按新名查会得 0，被误判成「余额被清空」而生成一条虚假的巨额调整交易。
        lookup_name = old_name or name
        if "currentBalance" in item:
            intended = coerce_float(item.get("currentBalance"))
            delta = intended - current_balance_for_account(connection, lookup_name, opening, classification)
            if abs(delta) > 0.005:
                adjustment = {"account_name": name, "delta": round(delta, 2), "classification": classification}
    else:
        opening = coerce_float(
            item.get("currentBalance"),
            coerce_float(item.get("openingBalance"), coerce_float(item.get("balance"))),
        )

    normalized = dict(item)
    normalized.pop("currentBalance", None)  # 派生值，落库会与交易重算结果打架
    normalized.update({
        "id": identifier,
        "name": name,
        "openingBalance": opening,
        "ownership": normalize_ownership(item.get("ownership"), "personal"),
        "classification": classification,
    })
    return normalized, rename, adjustment


def _propagate_account_rename(connection: sqlite3.Connection, old_name: str, new_name: str, now: str) -> int:
    """账户改名时把历史交易的三列一起搬过去。

    交易按**账户名**引用账户（account_name TEXT，不是外键），余额也按名聚合。
    少了这一步，改一次名就等于让该账户的全部历史失去归属：新账户余额从 0 起算，
    旧名下的交易变成孤儿，净资产与账户图表全错，而旧名此刻已从 accounts 表删除，不可逆。
    """
    affected = 0
    for column in ("account_name", "from_account_name", "to_account_name"):
        affected += connection.execute(
            f"UPDATE transactions SET {column}=?, updated_at=? WHERE {column}=?",
            (new_name, now, old_name),
        ).rowcount
    return affected


def update_configuration(ledger: Ledger, payload: dict[str, Any]) -> dict[str, Any]:
    if not all(isinstance(payload.get(key), list) for key in ("categories", "accounts")):
        raise DomainError("invalid_request", "configuration 需要 categories 和 accounts 数组。", status=400)
    now = utc_now_iso()
    categories = payload["categories"]
    accounts = payload["accounts"]
    settings = payload.get("settings") or default_ledger_settings()
    # 落库前先查重名：这一路径 DELETE 后整表重写，一旦写进两条同名账户，
    # 余额按名字聚合会让净资产翻倍，而流水里查不到任何对应的那一笔。
    assert_unique_master_names(accounts, "账户")
    assert_unique_master_names(categories, "分类")
    valid_account_ids = {
        str(item.get("id") or f"account-{index + 1}")
        for index, item in enumerate(accounts)
        if isinstance(item, dict)
    }
    operation_id = str(uuid4())

    with ledger.write_transaction() as connection:
        # 整表重写前先留底：这条路径 DELETE FROM accounts/categories 之后原样重灌，
        # 空数组一次就能把全部主数据物理抹掉（不是软删），此后 Agent 记任何一笔都 422，
        # 账本只能读不能写。而此前审计事件只记新状态的条数，payload 里没有任何被销毁内容，
        # 检查点又在 commit 之后跑——存下来的是毁后状态，主数据无从复原。
        before_accounts = raw_accounts(connection)
        before_categories = list_categories(connection)
        before_settings = load_ledger_settings(connection)
        if before_accounts and not any(isinstance(item, dict) for item in accounts):
            raise DomainError("configuration_would_wipe_accounts", "提交的账户列表为空，将抹掉全部账户；已删除账户应保留在列表中并带 deletedAt。", status=409)
        if before_categories and not any(isinstance(item, dict) for item in categories):
            raise DomainError("configuration_would_wipe_categories", "提交的分类列表为空，将抹掉全部分类；已删除分类应保留在列表中并带 deletedAt。", status=409)
        existing_by_id = {str(item.get("id")): item for item in before_accounts if item.get("id")}
        account_rows: list[tuple[str, str, int, str]] = []
        renames: list[tuple[str, str]] = []
        adjustments: list[dict[str, Any]] = []
        for index, item in enumerate(accounts):
            if not isinstance(item, dict):
                continue
            previous = existing_by_id.get(str(item.get("id") or ""))
            currency = str(item.get("currency") or MVP_BASE_CURRENCY).upper()
            foreign_money_changed = _foreign_account_money_changed(item, previous)
            if previous is not None and "currentBalance" in item:
                previous_classification = _classification_of(previous)
                current = current_balance_for_account(
                    connection,
                    str(previous.get("name") or ""),
                    coerce_float(previous.get("openingBalance")),
                    previous_classification,
                    account_currency=previous.get("currency"),
                    settings=before_settings,
                )
                foreign_money_changed = foreign_money_changed or abs(coerce_float(item.get("currentBalance")) - current) > 0.005
            if MVP_SINGLE_CURRENCY and currency != MVP_BASE_CURRENCY and foreign_money_changed:
                raise DomainError(
                    "mvp_single_currency_only",
                    "当前 MVP 只支持人民币 CNY；历史外币账户只能修改非金额信息。",
                    status=409,
                )
            normalized, rename, adjustment = _plan_account_write(connection, item, index, existing_by_id)
            account_rows.append((str(normalized["id"]), json.dumps(normalized, ensure_ascii=False), index, now))
            if rename is not None:
                renames.append(rename)
            if adjustment is not None:
                adjustments.append(adjustment)

        connection.execute("DELETE FROM categories")
        connection.execute("DELETE FROM accounts")
        for index, item in enumerate(categories):
            if not isinstance(item, dict):
                continue
            normalized = _normalized_category(item, index, valid_account_ids)
            connection.execute(
                "INSERT INTO categories(id,payload_json,sort_order,updated_at) VALUES(?,?,?,?)",
                (str(normalized["id"]), json.dumps(normalized, ensure_ascii=False), index, now),
            )
        connection.executemany(
            "INSERT INTO accounts(id,payload_json,sort_order,updated_at) VALUES(?,?,?,?)", account_rows
        )

        requested_default_currency = str(settings.get("defaultCurrency") or MVP_BASE_CURRENCY).upper()
        previous_default_currency = str(before_settings.get("defaultCurrency") or MVP_BASE_CURRENCY).upper()
        requested_rates = normalize_exchange_rates(settings.get("exchangeRates"))
        previous_rates = normalize_exchange_rates(before_settings.get("exchangeRates"))
        if MVP_SINGLE_CURRENCY and (
            (requested_default_currency != MVP_BASE_CURRENCY and requested_default_currency != previous_default_currency)
            or requested_rates != previous_rates
        ):
            raise DomainError(
                "mvp_single_currency_only",
                "当前 MVP 只支持人民币 CNY；默认币种与汇率设置已暂停。",
                status=409,
            )

        merged = default_ledger_settings()
        merged.update(settings)
        merged.update({
            "projects": normalize_projects(settings.get("projects")),
            "financeSources": normalize_finance_sources(settings.get("financeSources")),
            "counterparties": normalize_counterparties(settings.get("counterparties")),
            "exchangeRates": normalize_exchange_rates(settings.get("exchangeRates")),
            "ledgerMode": settings.get("ledgerMode") if settings.get("ledgerMode") in VALID_LEDGER_MODES else "personal",
            "updatedAt": now,
        })
        for reference_list in ("financeSources", "counterparties"):
            for entry in merged.get(reference_list) or []:
                if isinstance(entry, dict):
                    entry["defaultAccountId"] = _scrub_account_ref(entry.get("defaultAccountId"), valid_account_ids)
        save_ledger_settings(connection, merged, now)

        # 改名是按名匹配的顺序 UPDATE，一旦本次提交里出现 A→B 且 B→A 这种互换，
        # 第一条会把 A 的历史并进 B，第二条再把「B + 原 A」整体搬走，数据就搅死了。
        # 这种编辑极其罕见且必然是刻意为之，明确拒绝比悄悄搅乱安全。
        rename_sources = {old for old, _ in renames}
        if any(new in rename_sources for _, new in renames):
            raise DomainError("account_rename_cycle", "本次提交中出现账户名互换，请分两次保存。", status=409)

        # 先搬历史再补差额：调整交易用的是新账户名，两者必须落到同一个账户上。
        moved = sum(_propagate_account_rename(connection, old, new, now) for old, new in renames)
        for adjustment in adjustments:
            row = transaction_row_from_payload(
                connection,
                build_adjustment_payload(
                    adjustment["account_name"], adjustment["delta"], adjustment["classification"], now
                ),
                now=now,
                transaction_id=str(uuid4()),
            )
            insert_transaction(connection, row)

        event = {
            "id": operation_id,
            "occurredAt": now,
            "actor": "dashboard",
            "action": "update",
            "entityType": "configuration",
            "entityId": "configuration",
            "entityName": "财务主数据",
            "impact": {
                "categories": len(categories),
                "accounts": len(account_rows),
                "renamedAccounts": [{"from": old, "to": new} for old, new in renames],
                "movedTransactions": moved,
                "balanceAdjustments": adjustments,
            },
            "payload": {
                "renames": renames,
                "adjustments": adjustments,
                # 被整表替换掉的原主数据；没有它，这次写入在审计链上只剩一个条数，
                # 无法回答「原来有哪些账户、叫什么、余额基线是多少」。
                "before": {"accounts": before_accounts, "categories": before_categories},
            },
        }
        append_audit_event(connection, event)
        _touch_settings(connection, now)
        checkpoint = checkpoint_after_commit(connection, ledger, event)

    warning = checkpoint[0] or None
    result = configuration(ledger)
    if warning:
        result["auditWarning"] = warning
    return result


def reports(ledger: Ledger, kind: str, query: dict[str,str]) -> dict[str, Any]:
    connection=ledger.connect()
    try:
        if kind=="summary": return monthly_summary(connection,query.get("month"),query.get("view","combined"))
        if kind=="budget": return report_budget_status(connection,query.get("month"))
        if kind=="habits": return report_habits(connection,query.get("q", ""),query.get("category", ""))
        return dashboard_overview(connection,query.get("view","combined"))
    finally: connection.close()


def audit_events(ledger: Ledger, limit: int) -> list[dict[str,Any]]:
    connection=ledger.connect()
    try: rows=connection.execute("SELECT * FROM audit_events ORDER BY occurred_at DESC LIMIT ?",(min(max(limit,1),500),)).fetchall()
    finally: connection.close()
    return [{"id":row["id"],"occurredAt":row["occurred_at"],"actor":row["actor"],"action":row["action"],"entityType":row["entity_type"],"entityId":row["entity_id"],"entityName":row["entity_name"],"impact":json.loads(row["impact_json"]),"payload":json.loads(row["payload_json"])} for row in rows]


def refresh_rates(ledger: Ledger) -> dict[str, Any]:
    """按基线保留用户手动小币种，再以 provider 的反转汇率覆盖已获取币种。"""
    if MVP_SINGLE_CURRENCY:
        raise DomainError("mvp_single_currency_only", "当前 MVP 只支持人民币 CNY；汇率刷新已暂停。", status=409)
    connection = ledger.connect()
    try: base = normalize_exchange_rates(load_ledger_settings(connection).get("exchangeRates")).get("baseCurrency", "CNY")
    finally: connection.close()
    fetched, error = fetch_exchange_rates_from_api(str(base))
    now = utc_now_iso()
    with ledger.write_transaction() as connection:
        settings = load_ledger_settings(connection); rates = normalize_exchange_rates(settings.get("exchangeRates"))
        if error: rates["lastFetchError"] = error
        else:
            merged = dict(rates.get("rates") or {}); merged.update(fetched); merged[rates["baseCurrency"]] = 1.0
            rates.update({"rates": merged, "lastFetchSource": rates.get("provider") or "open.er-api.com", "lastFetchError": None, "updatedAt": now})
        settings["exchangeRates"], settings["updatedAt"] = rates, now; save_ledger_settings(connection, settings, now)
    if error: raise DomainError("rate_provider_failed", error, status=502, rates=rates)
    return rates


def upload_attachment(ledger: Ledger, transaction_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    encoded = payload.get("data")
    if not isinstance(encoded, str): raise DomainError("invalid_attachment", "data 必须是 base64 字符串。", status=400)
    try: raw = base64.b64decode(encoded, validate=True)
    except Exception as exc: raise DomainError("invalid_attachment", "data 不是有效 base64。", status=400) from exc
    if not raw: raise DomainError("invalid_attachment", "附件不能为空。", status=400)
    if len(raw) > ATTACHMENT_MAX_BYTES: raise DomainError("payload_too_large", "附件超过 10MB。", status=413)
    attachment_id, now = str(uuid4()), utc_now_iso(); mime = str(payload.get("mime") or "application/octet-stream"); name = str(payload.get("filename") or "attachment")
    relative = Path("attachments") / transaction_id / f"{attachment_id}{mimetypes.guess_extension(mime) or ''}"
    stored = _attachment_file_path(ledger, relative)
    with ledger.write_transaction() as connection:
        # 建目录必须排在流水校验之后：mkdir 一旦跑在前面，404 的请求回执说「什么都没发生」，
        # 账本数据根却已多出一个以流水 id 命名的空目录。面板重试删掉的流水、
        # Agent 拿过期 id 重传票据，都会在 attachments/ 下持续堆积无法回收的空壳。
        get_transaction(connection, transaction_id)
        stored.parent.mkdir(parents=True, exist_ok=True)
        stored.write_bytes(raw)
        connection.execute("INSERT INTO attachments(id,transaction_id,mime,size_bytes,original_name,stored_path,created_at) VALUES(?,?,?,?,?,?,?)", (attachment_id, transaction_id, mime, len(raw), name, relative.as_posix(), now))
    return {"id": attachment_id, "transactionId": transaction_id, "mime": mime, "sizeBytes": len(raw), "originalName": name, "createdAt": now}


def read_attachment(ledger: Ledger, attachment_id: str) -> tuple[dict[str, Any], bytes]:
    connection = ledger.connect()
    try: row = connection.execute("SELECT mime,original_name,stored_path FROM attachments WHERE id=?", (attachment_id,)).fetchone()
    finally: connection.close()
    if row is None: raise DomainError("not_found", "附件不存在。", status=404)
    path = _attachment_file_path(ledger, row["stored_path"])
    if not path.exists(): raise DomainError("not_found", "附件文件不存在。", status=404)
    return {"mime": row["mime"] or "application/octet-stream", "originalName": row["original_name"] or "attachment"}, path.read_bytes()


def delete_attachment(ledger: Ledger, attachment_id: str) -> dict[str, Any]:
    with ledger.write_transaction() as connection:
        row = connection.execute("SELECT stored_path FROM attachments WHERE id=?", (attachment_id,)).fetchone()
        if row is None: raise DomainError("not_found", "附件不存在。", status=404)
        connection.execute("DELETE FROM attachments WHERE id=?", (attachment_id,))
    try: _attachment_file_path(ledger, row["stored_path"]).unlink(missing_ok=True)
    except OSError: pass
    return {"ok": True, "id": attachment_id}


def agent_operation(ledger: Ledger, payload: dict[str, Any], actor_header: str = "agent") -> dict[str, Any]:
    """FinOS 主数据状态机的单账本移植：确认原话与审计快照同一次提交。"""
    entity_type, action = str(payload.get("entityType") or "").strip(), str(payload.get("action") or "").strip()
    if entity_type not in {"account", "category", "financeSource"} or action not in {"create", "update", "delete", "restore"}: raise DomainError("invalid_agent_operation", "不支持的主数据操作。", status=400)
    confirmation, actor, identifier = require_user_confirmation(payload), str(payload.get("actor") or actor_header or "agent").strip(), str(payload.get("id") or "").strip()
    patch, now, operation_id = payload.get("data") if isinstance(payload.get("data"), dict) else {}, utc_now_iso(), str(uuid4())
    with ledger.write_transaction() as connection:
        settings = load_ledger_settings(connection)
        if entity_type in {"account", "category"}:
            table = "accounts" if entity_type == "account" else "categories"; records = [dict(json.loads(row["payload_json"]), id=row["id"], _sort=row["sort_order"]) for row in connection.execute(f"SELECT id,payload_json,sort_order FROM {table} ORDER BY sort_order,id")]
        else: table = None; records = [dict(item, _sort=index) for index,item in enumerate(settings.get("financeSources", []))]
        target = next((item for item in records if item.get("id") == identifier), None) if identifier else None
        if action == "create":
            identifier = identifier or f"{entity_type}-{uuid4()}"
            if target: raise DomainError("conflict", "主数据 ID 已存在。", status=409)
            assert_unique_master_names(records + [{"name": patch.get("name") or f"新{entity_type}"}], entity_type)
            target = {"id": identifier, **patch, "_sort": len(records), "name": patch.get("name") or f"新{entity_type}"}
            if entity_type == "account": target.update({key:value for key,value in {"type":"cash","currency":"CNY","openingBalance":0.0,"ownership":"unspecified","classification":"asset","systemImage":"wallet.pass","tintHex":"#607D8B"}.items() if key not in target})
            elif entity_type == "category": target.update({key:value for key,value in {"systemImage":"tray","tintHex":"#607D8B","keywords":[],"direction":"支出"}.items() if key not in target})
            records.append(target); previous = {}
        else:
            if target is None: raise DomainError("not_found", "主数据不存在。", status=404)
            previous = dict(target)
            if action == "update":
                if target.get("deletedAt"): raise DomainError("conflict", "请先恢复已删除主数据。", status=409)
                target.update(patch)
                # 改名撞车比新建撞车更隐蔽：账户数量不变，用户只是「改了个名字」，
                # 余额却因为按名字聚合而被两条记录各算一遍。
                assert_unique_master_names([item for item in records if item is not target] + [target], entity_type)
            elif action == "delete":
                if target.get("deletedAt"): raise DomainError("conflict", "主数据已删除。", status=409)
                target.update({"deletedAt":now,"deletedBy":actor,"deletionReason":str(payload.get("reason") or "Agent 删除")})
                if entity_type == "account":
                    classification = target.get("classification") or ("liability" if target.get("type") == "creditCard" else "asset"); balance=current_balance_for_account(connection,str(target.get("name") or ""),coerce_float(target.get("openingBalance")),classification)
                    target["deletionImpact"]={"balance":round(balance,2),"assetDelta":round(-balance,2) if classification=="asset" else 0.0,"liabilityDelta":round(-balance,2) if classification=="liability" else 0.0,"netWorthDelta":round(-balance if classification=="asset" else balance,2)}
            else:
                for key in ("deletedAt","deletedBy","deletionReason","deletionImpact"): target.pop(key,None)
        if entity_type == "account" and action in {"create", "update"}:
            currency = str(target.get("currency") or MVP_BASE_CURRENCY).upper()
            foreign_money_changed = _foreign_account_money_changed(target, previous if action == "update" else None)
            if MVP_SINGLE_CURRENCY and currency != MVP_BASE_CURRENCY and foreign_money_changed:
                raise DomainError(
                    "mvp_single_currency_only",
                    "当前 MVP 只支持人民币 CNY；历史外币账户只能修改非金额信息。",
                    status=409,
                )
        target.pop("_sort", None)
        if table:
            if action == "create": connection.execute(f"INSERT INTO {table}(id,payload_json,sort_order,updated_at) VALUES(?,?,?,?)", (identifier,json.dumps(target,ensure_ascii=False),len(records)-1,now))
            else: connection.execute(f"UPDATE {table} SET payload_json=?,updated_at=? WHERE id=?", (json.dumps(target,ensure_ascii=False),now,identifier))
        else:
            settings["financeSources"]=[{key:value for key,value in item.items() if key!="_sort"} for item in records]; settings["updatedAt"]=now; save_ledger_settings(connection,settings,now)
        event={"id":operation_id,"occurredAt":now,"actor":actor,"action":action,"entityType":entity_type,"entityId":identifier,"entityName":str(target.get("name") or identifier),"userConfirmation":confirmation,"impact":target.get("deletionImpact",{}),"payload":{"userConfirmation":confirmation,"before":{key:value for key,value in previous.items() if key!="_sort"},"after":target}}; append_audit_event(connection,event); checkpoint = checkpoint_after_commit(connection, ledger, event)
    warning = checkpoint[0] or None
    result = {"ok": True, "operation": event, "entity": target}
    if warning:
        result["auditWarning"] = warning
    return result


def export_xlsx(ledger: Ledger, query: dict[str, str]) -> bytes:
    from_date, to_date = query.get("from") or None, query.get("to") or None
    if from_date and (len(from_date) != 10 or from_date[4] != "-" or from_date[7] != "-"): raise DomainError("invalid_range", "from 必须是 YYYY-MM-DD。", status=400)
    if to_date and (len(to_date) != 10 or to_date[4] != "-" or to_date[7] != "-"): raise DomainError("invalid_range", "to 必须是 YYYY-MM-DD。", status=400)
    connection = ledger.connect()
    try: return build_export_workbook(connection, query.get("view", "combined"), from_date, to_date)
    finally: connection.close()


def export_tax_report(ledger: Ledger, query: dict[str, str]) -> bytes:
    try: year = int(query.get("year") or datetime.now(record_timezone()[0]).year)
    except ValueError as exc: raise DomainError("invalid_range", "year 必须是年份。", status=400) from exc
    try: quarter = int(query["quarter"]) if query.get("quarter") else None
    except ValueError as exc: raise DomainError("invalid_range", "quarter 必须是 1-4。", status=400) from exc
    if quarter not in {None,1,2,3,4}: raise DomainError("invalid_range", "quarter 必须是 1-4。", status=400)
    connection = ledger.connect()
    try: return build_tax_report_workbook(connection, year, quarter)
    finally: connection.close()
