"""
[INPUT]: 依赖 finance 交易、分类、账户主数据、双视图筛选与 views 的本位币换算原语。
[OUTPUT]: 对外提供月度汇总、预算双键、基于全部历史的 0.98^days 习惯投影及 dashboard 聚合。
[POS]: finance 的只读报告层；所有跨账户聚合一律以本位币结算，不触发周期记账，
       E9 由 service/routes 在唯一允许点调用。
[PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
"""

from __future__ import annotations

import json
import sqlite3
from collections import defaultdict
from datetime import datetime, timezone
from typing import Any

from domains.finance.currency import coerce_float
from core.clock import record_timezone
from domains.finance.store import list_categories, row_to_transaction
from domains.finance.views import (
    account_balance_in_base, account_ownership_map, category_id_and_name, category_name,
    exchange_context, list_accounts, normalize_view_param, transaction_amount_in_base,
    transaction_belongs_to_view,
)


def _month(value: str | None = None) -> str:
    if value and len(value) == 7 and value[4] == "-": return value
    # 「本月」是用户的月，不是宿主机器的月。记录时区 Asia/Shanghai、宿主 America/Los_Angeles 时，
    # 北京每月 1 号 0–8 点宿主还停在上个月：本月汇总、预算进度、12 个月趋势会整块查到上个月。
    now = datetime.now(record_timezone()[0]); return f"{now.year:04d}-{now.month:02d}"


def _transactions(connection: sqlite3.Connection, view: str = "combined") -> list[dict[str, Any]]:
    rows = connection.execute("SELECT * FROM transactions WHERE deleted_at IS NULL ORDER BY occurred_at DESC,created_at DESC").fetchall()
    items, ownership = [row_to_transaction(row) for row in rows], account_ownership_map(connection)
    return [item for item in items if transaction_belongs_to_view(item, normalize_view_param(view), ownership)]


def monthly_summary(connection: sqlite3.Connection, month: str | None, view: str = "combined") -> dict[str, Any]:
    """本月收支合计，一律以本位币结算。

    此前这里直接把各行的原币 amount 相加：多币种账本下 1000 CNY + 1000 USD 得 2000，
    而真值是 8200。服务端每写一笔就已经算好并冻结了 amount_in_base_currency，
    只是三个聚合口径谁都没用它。Agent 按这个数向用户汇报「本月收入」即错。
    """
    prefix, items = _month(month), [item for item in _transactions(connection, view) if item["occurredAt"][:7] == _month(month)]
    base_currency, rates = exchange_context(connection)
    amount = lambda item: transaction_amount_in_base(item, base_currency, rates)
    income, expense = round(sum(amount(item) for item in items if item["kind"] == "income"), 2), round(sum(amount(item) for item in items if item["kind"] == "expense"), 2)
    pending = round(sum(amount(item) for item in items if item["kind"] == "expense" and item.get("reimbursementStatus") in {"draft", "submitted", "rejected"}), 2)
    return {"month": prefix, "view": normalize_view_param(view), "income": income, "expense": expense, "balance": round(income-expense, 2), "pendingReimbursement": pending, "transactionCount": len(items)}


def budget_status(connection: sqlite3.Connection, month: str | None) -> dict[str, Any]:
    prefix, spent_by_id, spent_by_name = _month(month), defaultdict(float), defaultdict(float)
    base_currency, rates = exchange_context(connection)
    # 预算是跨账户口径（一个分类的支出可能来自多个币种的账户），必须按本位币结算；
    # 否则多币种下 1000 CNY + 1000 USD 记成 2000，预算进度条直接错。
    rows = connection.execute("SELECT category_json,amount,currency,amount_in_base_currency FROM transactions WHERE deleted_at IS NULL AND kind='expense' AND substr(occurred_at,1,7)=?", (prefix,)).fetchall()
    for row in rows:
        # category 是用户/Agent 可控的 JSON，形状没有落库闸：裸字符串、数组、数字都进得来。
        # 直接 .get 会让一条脏行炸掉整张预算表（AttributeError → 500），所以口径统一收在 views。
        try: category = json.loads(row["category_json"] or "{}")
        except (json.JSONDecodeError, TypeError): category = {}
        amount = transaction_amount_in_base(
            {"amount": row["amount"], "currency": row["currency"], "amountInBaseCurrency": row["amount_in_base_currency"]},
            base_currency, rates,
        )
        cid, name = category_id_and_name(category)
        if cid: spent_by_id[cid] += amount
        if name: spent_by_name[name] += amount
    items = []
    for category in list_categories(connection):
        budget = coerce_float(category.get("monthlyBudget"))
        if budget <= 0: continue
        cid, name = str(category.get("id") or ""), str(category.get("name") or "")
        spent = round(max(spent_by_id.get(cid, 0.0), spent_by_name.get(name, 0.0)), 2)
        items.append({"categoryId": cid, "name": name or "未命名分类", "budget": round(budget,2), "spent": spent, "remaining": round(budget-spent,2), "percentUsed": round(spent/budget*100,1), "color": category.get("tintHex") or "#7f91d6"})
    items.sort(key=lambda item: item["percentUsed"], reverse=True)
    total_budget, total_spent = sum(item["budget"] for item in items), sum(item["spent"] for item in items)
    return {"month": prefix, "items": items, "totalBudget": round(total_budget,2), "totalSpent": round(total_spent,2), "totalRemaining": round(total_budget-total_spent,2)}


def habits(connection: sqlite3.Connection, phrase: str, category: str) -> dict[str, Any]:
    rows = connection.execute("SELECT title,merchant,note,category_json,account_name,project_name,source_name,reimbursement_status,occurred_at FROM transactions WHERE deleted_at IS NULL AND source!='adjustment' ORDER BY occurred_at DESC").fetchall()
    now = datetime.now(timezone.utc)
    def aggregate(matches: list[tuple[sqlite3.Row, float, str]]) -> dict[str, Any]:
        dimensions: dict[str, dict[str, dict[str, Any]]] = {key: {} for key in ("account", "project", "source", "category", "reimbursement")}
        for row, weight, category_name in matches:
            values = {"account": str(row["account_name"] or ""), "project": str(row["project_name"] or ""), "source": str(row["source_name"] or ""), "category": category_name, "reimbursement": str(row["reimbursement_status"] or "notApplicable")}
            for dimension, value in values.items():
                if not value: continue
                bucket = dimensions[dimension].setdefault(value, {"weight": 0.0, "count": 0, "lastUsedAt": ""}); bucket["weight"] += weight; bucket["count"] += 1; bucket["lastUsedAt"] = max(bucket["lastUsedAt"], str(row["occurred_at"] or ""))
        result = {}
        for dimension, buckets in dimensions.items():
            total = sum(item["weight"] for item in buckets.values()) or 1.0
            result[dimension] = [{"value": value, "count": item["count"], "share": round(item["weight"]/total, 3), "lastUsedAt": item["lastUsedAt"]} for value,item in sorted(buckets.items(), key=lambda pair: pair[1]["weight"], reverse=True)[:3]]
        return result
    by_phrase, by_category = [], []
    for row in rows:
        try: name = category_name(json.loads(row["category_json"] or "{}"))
        except (json.JSONDecodeError, TypeError): name = ""
        try:
            dt = datetime.fromisoformat(str(row["occurred_at"]).replace("Z", "+00:00")); dt = dt.replace(tzinfo=timezone.utc) if dt.tzinfo is None else dt; days = max(0, (now-dt).days)
        except (ValueError, TypeError): days = 365
        matched = (row, .98 ** min(days,365), name); text = f"{row['title'] or ''} {row['merchant'] or ''} {row['note'] or ''}"
        if phrase and phrase in text: by_phrase.append(matched)
        if category and category == name: by_category.append(matched)
    return {"phrase": phrase, "category": category, "byPhrase": {"matches": len(by_phrase), **aggregate(by_phrase)}, "byCategory": {"matches": len(by_category), **aggregate(by_category)}, "hint": "byPhrase（用户原话词汇）命中时优先采用；其次 byCategory。share ≥ 0.7 视为强习惯，可按此补全并在回显中标注来源；share < 0.7 或零命中时向用户确认。单笔例外不会压过日常多数。"}


def dashboard_overview(connection: sqlite3.Connection, view: str = "combined") -> dict[str, Any]:
    """保持基线聚合口径的紧凑投影；前端所需的 KPI、趋势、流水均来自同一只读快照。

    跨账户的每一个合计（12 个月趋势、净现金流、跑道）都以本位币结算：账户余额用
    账户自己的币种是对的，把两种货币的余额裸加成一个带 ¥ 的数字则是错的。
    """
    items, accounts = _transactions(connection, view), list_accounts(connection); months = []
    base_currency, rates = exchange_context(connection)
    cursor = datetime.now(record_timezone()[0]).replace(day=1)  # 趋势的起点同样按记录时区
    for _ in range(12):
        months.append(f"{cursor.year:04d}-{cursor.month:02d}"); cursor = cursor.replace(year=cursor.year-1, month=12) if cursor.month == 1 else cursor.replace(month=cursor.month-1)
    months.reverse(); figures = {month: {"income":0.0,"expense":0.0} for month in months}
    for item in items:
        if item["occurredAt"][:7] in figures and item["kind"] in figures[item["occurredAt"][:7]]: figures[item["occurredAt"][:7]][item["kind"]] += transaction_amount_in_base(item, base_currency, rates)
    current, previous = months[-1], months[-2]; income, expense = figures[current]["income"], figures[current]["expense"]
    net_assets = sum((-1 if account.get("classification") == "liability" else 1) * account_balance_in_base(account, base_currency, rates) for account in accounts if not account.get("deletedAt"))
    recent = sum(figures[key]["expense"] for key in months[-6:]) / 6; runway = net_assets/recent if recent else 0
    change = lambda value, old: ("0.0%" if old == value == 0 else f"{(100 if old == 0 else (value-old)/abs(old)*100):+.1f}%", "up" if value >= old else "down")
    cash_change, cash_trend = change(income+(income-expense), figures[previous]["income"]+(figures[previous]["income"]-figures[previous]["expense"]))
    profit_change, profit_trend = change(income-expense, figures[previous]["income"]-figures[previous]["expense"])
    format_money = lambda value: f"¥{round(value):,.0f}"
    return {"health": {"status":"ok"}, "dashboard": {"kpis": {"currentCashFlow":{"value":round(net_assets,2),"display":format_money(net_assets),"change":cash_change,"trend":cash_trend}, "monthlyNetProfit":{"value":round(income-expense,2),"display":format_money(income-expense),"change":profit_change,"trend":profit_trend}, "opexRate":{"value":round(expense/income*100 if income else 0,2),"display":f"{expense/income*100 if income else 0:.1f}%","change":"0.0%","trend":"up"}, "emergencyRunway":{"value":round(runway,2),"display":f"{runway:.1f} 个月","change":"+0.0","trend":"up"}}, "trendData":{"months":[key[2:].replace("-","/") for key in months],"income":[round(figures[key]["income"],2) for key in months],"expense":[round(figures[key]["expense"],2) for key in months]}, "sunburstData":[], "roiData":{"projects":["暂无数据"],"cost":[0],"revenue":[0]}, "sankeyData":{"nodes":[],"links":[]}, "accounts":[{"name":item.get("name"),"amount":round((-1 if item.get("classification")=="liability" else 1)*float(item.get("currentBalance") or 0),2),"color":item.get("tintHex") or "#3B82F6"} for item in accounts if not item.get("deletedAt")], "suggestion":{"title":"智能财务建议","description":f"本月净现金流 {format_money(income-expense)}。", "actionLabel":"刷新看板"}}, "allTransactions": [{"id":item["id"],"date":item["occurredAt"][:10],"type":{"income":"收入","expense":"支出","transfer":"转账"}.get(item["kind"],item["kind"]),"amount":round(float(item["amount"] or 0),2)*(-1 if item["kind"]=="expense" else 1),"from":item.get("fromAccountName") or item.get("merchant") or "","to":item.get("toAccountName") or item.get("merchant") or "","note":item.get("note") or "","category":category_name(item.get("category")) or None,"project":(item.get("tags") or [None])[0],"tags":item.get("tags") or [],"accountName":item.get("accountName"),"merchant":item.get("merchant"),"reimbursementStatus":item.get("reimbursementStatus"),"source":item.get("source")} for item in items], "categories":sorted({item.get("name") for item in list_categories(connection) if item.get("name")}), "meta":{"month":current,"transactionCount":len(items),"rawTransactionCount":len(items)}}
