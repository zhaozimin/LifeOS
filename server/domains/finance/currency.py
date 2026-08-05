"""
[INPUT]: 依赖 finance 的 ledger_settings、账户主数据与 FinOS 基线汇率约定。
[OUTPUT]: 对外提供汇率反转、配置归一化及交易写入时本位币快照。
[POS]: finance 的货币语义层；所有换算均在 finance 单连接内完成，避免历史汇率被后续设置改写。
[PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
"""

from __future__ import annotations

from core.clock import utc_now_iso

import json
import sqlite3
import urllib.error
import urllib.request
from datetime import datetime, timezone
from typing import Any

from domains.finance.constants import default_exchange_rates


def coerce_float(value: object, default: float = 0.0) -> float:
    try:
        result = default if value in {None, ""} else float(value)
    except (TypeError, ValueError):
        return default
    return default if result != result or result in (float("inf"), float("-inf")) else result


def coerce_bool(value: object, default: bool = False) -> bool:
    if isinstance(value, bool): return value
    if value is None: return default
    if isinstance(value, str):
        if value.strip().lower() in {"1", "true", "yes", "on"}: return True
        if value.strip().lower() in {"0", "false", "no", "off"}: return False
    return bool(value)


def normalize_exchange_rates(value: object) -> dict[str, Any]:
    base = default_exchange_rates()
    if not isinstance(value, dict): return base
    if isinstance(value.get("baseCurrency"), str): base["baseCurrency"] = value["baseCurrency"].upper().strip() or base["baseCurrency"]
    if isinstance(value.get("rates"), dict):
        normalized: dict[str, float] = {}
        for code, rate in value["rates"].items():
            if isinstance(code, str) and code.upper().strip(): normalized[code.upper().strip()] = max(0.0, coerce_float(rate, 0.0))
        normalized[base["baseCurrency"]] = 1.0
        base["rates"] = normalized or base["rates"]
    for key in ("provider", "lastFetchSource", "lastFetchError", "updatedAt"):
        if isinstance(value.get(key), str): base[key] = value[key]
    if "autoFetch" in value: base["autoFetch"] = coerce_bool(value.get("autoFetch"), False)
    return base


def fetch_exchange_rates_from_api(base_currency: str = "CNY") -> tuple[dict[str, float], str | None]:
    """按 FinOS 4778a6b 原算法反转 provider 的 `1 base = N other` 汇率。"""
    base = (base_currency or "CNY").upper()
    try:
        request = urllib.request.Request(f"https://open.er-api.com/v6/latest/{base}", headers={"User-Agent": "FinanceNode/0.1"})
        with urllib.request.urlopen(request, timeout=8) as response:
            data = json.loads(response.read().decode("utf-8"))
    except urllib.error.URLError as exc:
        return {}, f"网络错误：{exc.reason}"
    except (json.JSONDecodeError, TimeoutError) as exc:
        return {}, f"响应解析失败：{exc}"
    except Exception as exc:  # pragma: no cover - provider boundary
        return {}, f"未知错误：{exc}"
    if data.get("result") != "success": return {}, f"API 返回失败：{data.get('error-type', 'unknown')}"
    converted = {base: 1.0}
    for code, value in (data.get("rates") or {}).items():
        try: rate = float(value)
        except (TypeError, ValueError): continue
        if rate > 0: converted[str(code).upper()] = round(1.0 / rate, 6)
    return converted, None


def convert_to_base_currency(amount: float, currency: str, base_currency: str, rates: dict[str, Any]) -> float:
    if not currency or currency.upper() == base_currency.upper(): return amount
    rate = rates.get(currency.upper())
    return amount if not isinstance(rate, (int, float)) or rate <= 0 else amount * float(rate)


def derive_currency_for_account(connection: sqlite3.Connection, account_name: str, fallback: str = "CNY") -> str:
    if not account_name: return fallback
    for row in connection.execute("SELECT payload_json FROM accounts").fetchall():
        try: payload = json.loads(row["payload_json"])
        except (json.JSONDecodeError, TypeError): continue
        if payload.get("name") == account_name: return str(payload.get("currency") or fallback).upper()
    return fallback


def resolve_transaction_currency(connection: sqlite3.Connection, currency_in: object, account_name: str) -> str:
    return currency_in.strip().upper() if isinstance(currency_in, str) and currency_in.strip() else derive_currency_for_account(connection, account_name)


def rescale_base_snapshot(previous_amount: object, previous_base: object, next_amount: object) -> float | None:
    """只改金额、不改币种时，按原比例缩放本位币快照，保住记账当时的汇率。

    快照的本意是冻结「记账那天的汇率」。一律重算会用今天的汇率改写历史；
    而此前的实现更糟：它把库里的旧快照当成调用方的显式值原样返回，
    于是一笔 100 USD/720 CNY 的账改成 200 USD 后，本位币永远停在 720，
    甚至改成 CNY 50 元后仍带着 720 —— 同一行的 currency/amount/base 三者互相矛盾。
    改币种时没有旧汇率可用（新币种在那一天的汇率不在账本里），只能回落到当前汇率重算。
    """
    try:
        before, base, after = float(previous_amount), float(previous_base), float(next_amount)
    except (TypeError, ValueError):
        return None
    if before == 0:
        return None
    return round(base / before * after, 4)


def resolve_amount_in_base(connection: sqlite3.Connection, explicit: object, amount: object, currency_in: object, account_name: str, settings: dict[str, Any]) -> float:
    try:
        if explicit is not None: return float(explicit)
    except (TypeError, ValueError): pass
    cfg = settings.get("exchangeRates") or {}
    return round(convert_to_base_currency(coerce_float(amount), resolve_transaction_currency(connection, currency_in, account_name), str(cfg.get("baseCurrency") or "CNY").upper(), cfg.get("rates") or {}), 4)
