"""
[INPUT]: 依赖 finance 账户 JSON、交易行的账户快照与 currency 的本位币换算原语。
[OUTPUT]: 对外提供个人/公司双视图筛选、资产负债余额口径、跨币种聚合换算、
          category 形状投影、账户投影与余额调整交易 payload 构造。
[POS]: finance 的只读视图语义；报告、导出、护栏和 API 共用此处，避免多处各自解释账户归属与币种。
[PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
"""

from __future__ import annotations

import json
import sqlite3
from typing import Any

from domains.finance.constants import VALID_OWNERSHIPS
from domains.finance.currency import coerce_float, convert_to_base_currency, derive_currency_for_account
from domains.finance.store import load_ledger_settings, normalized_account_pair, raw_accounts


def normalize_ownership(value: object, fallback: str = "unspecified") -> str:
    return value.strip().lower() if isinstance(value, str) and value.strip().lower() in VALID_OWNERSHIPS else (fallback if fallback in VALID_OWNERSHIPS else "unspecified")


def infer_account_ownership(payload: dict[str, Any]) -> str:
    explicit = payload.get("ownership")
    if isinstance(explicit, str) and explicit.strip().lower() in VALID_OWNERSHIPS: return explicit.strip().lower()
    ui_type, name = str(payload.get("uiAccountType") or "").strip(), str(payload.get("name") or "").strip()
    if ui_type == "经营账户" or any(token in name for token in ("经营", "公司", "工资")): return "company"
    if ui_type in {"生活账户", "应急账户", "储蓄账户"} or any(token in name for token in ("生活", "应急", "储蓄", "微信", "支付宝")): return "personal"
    return "personal" if any(token in name.lower() for token in ("wechat", "alipay")) else "unspecified"


def infer_ledger_mode(connection: sqlite3.Connection) -> str:
    try:
        return "dual" if any(json.loads(row["payload_json"]).get("ownership") == "company" for row in connection.execute("SELECT payload_json FROM accounts")) else "personal"
    except (sqlite3.Error, json.JSONDecodeError, TypeError): return "personal"


def normalize_view_param(value: object) -> str:
    return value.strip().lower() if isinstance(value, str) and value.strip().lower() in {"company", "personal", "combined"} else "combined"


def account_ownership_map(connection: sqlite3.Connection) -> dict[str, str]:
    return {str(item.get("name")): infer_account_ownership(item) for item in raw_accounts(connection) if item.get("name")}


def transaction_belongs_to_view(transaction: dict[str, Any], view: str, ownership_map: dict[str, str]) -> bool:
    if view not in {"company", "personal"}: return True
    names = {transaction.get(key) for key in ("accountName", "fromAccountName", "toAccountName", "account_name", "from_account_name", "to_account_name")}
    return any(ownership_map.get(str(name)) == view for name in names if name)


def category_id_and_name(value: object) -> tuple[str, str]:
    """把任意形状的 category 投影成 (id, name)。

    category 是用户与 Agent 可控的 JSON，落库前没有形状闸：传成裸字符串、数组或
    数字都会原样进 category_json。此前护栏与报告都直接 `.get("name")`，
    于是「类别传成字符串」在写入面炸成 internal_error（Agent 拿不到 422 的
    issues/valid/agentInstruction，「先问后写」的机制整条失效），
    在读取面炸掉预算、习惯和整个 dashboard。导出层一直是 isinstance 兜底的——
    全仓唯一没被打穿的地方，这里把同一份兜底收成护栏与报告共用的唯一口径。
    裸字符串按「只给了名字」解释——名字正是全域聚合真正依赖的键。
    """
    if isinstance(value, dict): return str(value.get("id") or "").strip(), str(value.get("name") or "").strip()
    if isinstance(value, str): return "", value.strip()
    return ("", "") if value is None or isinstance(value, bool) else ("", str(value).strip())


def category_name(value: object) -> str:
    return category_id_and_name(value)[1]


def exchange_context(connection: sqlite3.Connection, settings: dict[str, Any] | None = None) -> tuple[str, dict[str, Any]]:
    """取出本位币代码与汇率表；任何跨账户、跨币种的聚合都必须先经过这一层。"""
    config = (settings if isinstance(settings, dict) else load_ledger_settings(connection)).get("exchangeRates") or {}
    return str(config.get("baseCurrency") or "CNY").upper(), config.get("rates") or {}


def convert_from_base_currency(amount: float, currency: str, base_currency: str, rates: dict[str, Any]) -> float:
    """convert_to_base_currency 的逆向：把本位币金额落回目标币种。

    汇率表的语义是「1 单位外币 = rate 单位本位币」，因此回落是除法。
    汇率缺失时原样返回，与正向换算保持同一种降级姿态——读取路径不该因配置不全而抛错。
    """
    if not currency or currency.upper() == base_currency.upper(): return amount
    rate = rates.get(currency.upper())
    return amount if not isinstance(rate, (int, float)) or isinstance(rate, bool) or rate <= 0 else amount / float(rate)


def transaction_amount_in_base(item: dict[str, Any], base_currency: str, rates: dict[str, Any]) -> float:
    """一笔交易在本位币下的金额。

    优先用写入时冻结的 amount_in_base_currency 快照——那是记账当天的汇率，
    重算会用今天的汇率改写历史。只有历史行（快照列尚未存在时写入）才按当前汇率兜底。
    """
    snapshot = item.get("amountInBaseCurrency")
    if snapshot is not None: return coerce_float(snapshot)
    return convert_to_base_currency(coerce_float(item.get("amount")), str(item.get("currency") or base_currency).upper(), base_currency, rates)


def account_balance_in_base(account: dict[str, Any], base_currency: str, rates: dict[str, Any]) -> float:
    """账户余额是账户自己的币种；跨账户求和（净资产）前必须先落到本位币。"""
    return convert_to_base_currency(coerce_float(account.get("currentBalance")), str(account.get("currency") or base_currency).upper(), base_currency, rates)


def _leg_amount(row: sqlite3.Row, account_currency: str, base_currency: str, rates: dict[str, Any]) -> float:
    """把一笔交易换算成**该账户自己币种**的金额。

    一笔交易只有一个 amount 和一个 currency（转账取出账方的币种），但转账牵涉两个账户。
    1000 USD 从美元账户转进人民币账户时，人民币账户实际收到的是 7200 元；
    此前两端都按 1000 记，净资产凭空蒸发 6200 且服务端不报错不提示。
    收入/支出只碰一个账户，币种恒等于账户币种，走同币种分支原样返回——
    单账户内的原币累加本来就是对的，不能被换算引入误差。
    """
    amount = float(row["amount"] or 0)
    row_currency = str(row["currency"] or account_currency).upper()
    if row_currency == account_currency: return amount
    snapshot = row["amount_in_base_currency"]
    base = coerce_float(snapshot) if snapshot is not None else convert_to_base_currency(amount, row_currency, base_currency, rates)
    return round(convert_from_base_currency(base, account_currency, base_currency, rates), 2)


def current_balance_for_account(connection: sqlite3.Connection, account_name: str, opening_balance: float, classification: str = "asset", *, account_currency: str | None = None, settings: dict[str, Any] | None = None) -> float:
    """账户当前余额，恒以**该账户自己的币种**表达（openingBalance 也是该币种）。"""
    rows = connection.execute("SELECT kind,amount,currency,amount_in_base_currency,account_name,from_account_name,to_account_name FROM transactions WHERE deleted_at IS NULL AND (account_name=? OR from_account_name=? OR to_account_name=?)", (account_name, account_name, account_name)).fetchall()
    currency = str(account_currency or derive_currency_for_account(connection, account_name)).upper()
    base_currency, rates = exchange_context(connection, settings)
    delta = 0.0
    for row in rows:
        from_name, to_name = normalized_account_pair(row); amount = _leg_amount(row, currency, base_currency, rates)
        if row["kind"] == "income" and to_name == account_name: delta += amount
        elif row["kind"] == "expense" and from_name == account_name: delta -= amount
        elif row["kind"] == "transfer":
            if from_name == account_name: delta -= amount
            if to_name == account_name: delta += amount
    return opening_balance - delta if classification == "liability" else opening_balance + delta


def build_adjustment_payload(account_name: str, delta: float, classification: str, occurred_at: str) -> dict[str, Any]:
    """构造一条「余额调整」交易 payload（FinOS 基线 :1732-1772 函数级平移）。

    用户在设置页修改账户当前余额时被自动调用，把账实差额写成一条可追溯的
    income / expense 交易，让黑洞资金在账本和桑基图里可见。缺了它，用户的对账
    动作会变成一次静默的数字覆盖——差额既不在流水里，也不在审计链里。

    资产账户：余额↑ → income（找回的钱），↓ → expense（丢失的钱）
    负债账户：余额↑ → expense（发现的额外欠款），↓ → income（账外还款）
    """
    kind = ("expense" if delta > 0 else "income") if classification == "liability" else ("income" if delta > 0 else "expense")
    return {
        "title": "余额调整",
        "amount": abs(delta),
        "kind": kind,
        "occurredAt": occurred_at,
        "category": {
            "id": "adjustment-blackhole",
            "name": "余额调整",
            "systemImage": "scalemass",
            "tintHex": "#7c7d6e",
            "keywords": [],
            "direction": "支出" if kind == "expense" else "收入",
            "group": "黑洞资金",
            "note": "用户对账时系统自动写入",
        },
        "tags": ["余额调整", "黑洞资金"],
        "accountName": account_name,
        "fromAccountName": account_name if kind == "expense" else None,
        "toAccountName": account_name if kind == "income" else None,
        "merchant": "余额调整",
        "projectName": "",
        "note": "系统记录的账户对账差额（黑洞资金）",
        "reimbursementStatus": "notApplicable",
        "source": "adjustment",
        "sourceName": "余额调整",
    }


def list_accounts(connection: sqlite3.Connection) -> list[dict[str, Any]]:
    items = []
    settings = load_ledger_settings(connection)  # 汇率表只读一次，逐账户重复加载没有意义
    for payload in raw_accounts(connection):
        opening = coerce_float(payload.get("openingBalance")); payload["threshold"] = coerce_float(payload.get("threshold"))
        zones = payload.get("thresholdZones") if isinstance(payload.get("thresholdZones"), dict) else {}
        low, mid = coerce_float(zones.get("low")), coerce_float(zones.get("mid"))
        if payload["threshold"] > 0 and (low <= 0 or mid <= 0): low, mid = low or round(payload["threshold"] * .6, 2), mid or round(payload["threshold"] * .85, 2)
        payload["thresholdZones"], payload["ownership"] = {"low": low, "mid": mid}, infer_account_ownership(payload)
        classification = payload.get("classification") if payload.get("classification") in {"asset", "liability"} else ("liability" if payload.get("type") == "creditCard" else "asset")
        payload["classification"], payload["creditLimit"] = classification, coerce_float(payload.get("creditLimit")) if classification == "liability" else 0.0
        payload["currentBalance"] = current_balance_for_account(connection, str(payload.get("name") or ""), opening, classification, account_currency=payload.get("currency"), settings=settings)
        if classification == "liability" and payload["creditLimit"] > 0: payload["availableCredit"] = round(payload["creditLimit"] - payload["currentBalance"], 2)
        items.append(payload)
    return items
