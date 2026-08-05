"""
[INPUT]: 依赖 finance 的周期规则表、交易行构造器和单账本连接。
[OUTPUT]: 对外提供周期规则归一化（含月/年锚点固化）、带锚点的 advance_due_date 与连接内 catchup。
[POS]: finance 的 E9 周期子域；service 决定什么时候调用，本模块绝不在启动或普通读取中自行触发。
[PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
"""

from __future__ import annotations

import json
import sqlite3
from calendar import monthrange
from datetime import date, datetime, timedelta, timezone
from typing import Any
from uuid import uuid4

from domains.finance.constants import RECURRING_FREQUENCIES
from core.clock import record_timezone
from domains.finance.currency import coerce_bool, coerce_float
from domains.finance.store import insert_transaction, utc_now_iso


def anchor_day_of(value: object) -> int | None:
    """把 day_of_period 收敛成合法的「几号」；越界值一律当作没设过。"""
    try: day = int(value)  # type: ignore[arg-type]
    except (TypeError, ValueError): return None
    return day if 1 <= day <= 31 else None


def normalize_recurring_payload(item: dict[str, Any], *, today: str | None = None) -> dict[str, Any]:
    name = str(item.get("name") or "").strip() or "周期账目"
    template = item.get("template") if isinstance(item.get("template"), dict) else {}
    frequency = item.get("frequency") if item.get("frequency") in RECURRING_FREQUENCIES else "monthly"
    interval = max(1, int(coerce_float(item.get("intervalN"), 1)))
    today = today or datetime.now(record_timezone()[0]).date().isoformat()
    start, next_due = str(item.get("startDate") or today)[:10], str(item.get("nextDueAt") or item.get("startDate") or today)[:10]

    # 锚点优先级：nextDueAt 的「几号」 > 显式 dayOfPeriod。
    #
    # 「几号」确实是规则的锚点而非游标属性——游标被 clamp 一次（1/31 → 2/29）就再也回不去，
    # 此后每月提前 2–3 天出账且无告警，这是本缺陷的根。但锚点**不能**冻结在建规则那天：
    # 面板根本没有 dayOfPeriod 控件（recurring.tsx 只有 name/frequency/intervalN/
    # startDate/nextDueAt/endDate/enabled），而 add() 把 nextDueAt 硬编码成今天，
    # updateRule 又一律回传 {...rule, ...patch}，把库里的旧 dayOfPeriod 原样送回。
    # 若让显式值优先，用户改「下次触发」为 1/31 也改不动锚点——房租会按建规则那天出账，
    # 误差从 1–2 天放大到近一个月，且用户在界面上无从纠正：锚点成了写一次就不可达的隐藏状态。
    # nextDueAt 是用户唯一能表达「几号」的字段，因此它在场时就是锚点的真源；
    # 需要让锚点与首次触发日不同的调用方，省略 nextDueAt 再给 dayOfPeriod 即可。
    day = None
    if frequency in {"monthly", "yearly"}:
        if item.get("nextDueAt"):
            try: day = date.fromisoformat(next_due).day
            except ValueError: day = None
        if day is None and item.get("dayOfPeriod") not in {None, "", 0}:
            day = anchor_day_of(item.get("dayOfPeriod"))
        if day is None:
            try: day = date.fromisoformat(next_due).day
            except ValueError: day = None
    return {"name": name, "template_payload_json": json.dumps(template, ensure_ascii=False), "frequency": frequency, "interval_n": interval, "day_of_period": day, "start_date": start, "end_date": str(item.get("endDate"))[:10] if item.get("endDate") else None, "next_due_at": next_due, "enabled": int(coerce_bool(item.get("enabled"), True))}


def recurring_row_to_dict(row: sqlite3.Row) -> dict[str, Any]:
    try: template = json.loads(row["template_payload_json"] or "{}")
    except (json.JSONDecodeError, TypeError): template = {}
    return {"id": row["id"], "name": row["name"], "template": template, "frequency": row["frequency"], "intervalN": int(row["interval_n"] or 1), "dayOfPeriod": row["day_of_period"], "startDate": row["start_date"], "endDate": row["end_date"], "nextDueAt": row["next_due_at"], "lastRunAt": row["last_run_at"], "enabled": bool(row["enabled"]), "createdAt": row["created_at"], "updatedAt": row["updated_at"]}


def advance_due_date(date_str: str, frequency: str, interval_n: int, anchor_day: object = None) -> str:
    """从 4778a6b 函数级平移：月/年缺失日期一律取当月最后一天。

    anchor_day 是规则的原始「几号」。clamp 本身没错——二月没有 31 号；错的是
    把 clamp 的结果当成新锚点：1/31 的月度规则跨过一次二月后永久变成每月 28/29 号，
    yearly 的闰日锚点退到 2/28 后也再回不到 2/29。锚点必须来自规则，不能来自游标。
    不传 anchor_day 时逐步语义与基线完全一致。
    """
    base, interval = datetime.fromisoformat(date_str).date(), max(1, interval_n)
    anchor = anchor_day_of(anchor_day) or base.day
    if frequency == "daily": return (base + timedelta(days=interval)).isoformat()
    if frequency == "weekly": return (base + timedelta(weeks=interval)).isoformat()
    if frequency == "monthly":
        year, month = base.year, base.month + interval
        while month > 12: month, year = month - 12, year + 1
        return f"{year:04d}-{month:02d}-{min(anchor, monthrange(year, month)[1]):02d}"
    if frequency == "yearly": return f"{base.year + interval:04d}-{base.month:02d}-{min(anchor, monthrange(base.year + interval, base.month)[1]):02d}"
    return (base + timedelta(days=1)).isoformat()


def catchup_recurring_rules_in_connection(connection: sqlite3.Connection, transaction_builder: Any, *, today: str | None = None) -> int:
    """生成所有到期交易，逐规则单连接原子推进；最多 120 次防异常规则无限循环。"""
    today = today or datetime.now(record_timezone()[0]).date().isoformat(); generated = 0  # 追平判据是业务日
    rules = connection.execute("SELECT * FROM recurring_rules WHERE enabled=1 AND next_due_at<=?", (today,)).fetchall()
    for rule in rules:
        try: template = json.loads(rule["template_payload_json"] or "{}")
        except (json.JSONDecodeError, TypeError): template = {}
        # 锚点取自规则，不取自游标：游标每跨一次短月就会被 clamp，拿它当锚点等于让锚点单调下滑。
        cursor, last_run, anchor = rule["next_due_at"], rule["last_run_at"], rule["day_of_period"]
        for _ in range(120):
            if cursor > today or (rule["end_date"] and cursor > rule["end_date"]): break
            payload = dict(template); payload["occurredAt"], payload["source"] = f"{cursor}T12:00:00+00:00", template.get("source") or "recurring"
            tags = list(template.get("tags") or [])
            if "周期账目" not in tags: tags.append("周期账目")
            payload["tags"] = tags
            insert_transaction(connection, transaction_builder(connection, payload, now=utc_now_iso(), transaction_id=str(uuid4())))
            last_run, generated = payload["occurredAt"], generated + 1
            cursor = advance_due_date(cursor, rule["frequency"] or "monthly", int(rule["interval_n"] or 1), anchor)
        connection.execute("UPDATE recurring_rules SET next_due_at=?,last_run_at=?,updated_at=? WHERE id=?", (cursor, last_run, utc_now_iso(), rule["id"]))
    return generated
