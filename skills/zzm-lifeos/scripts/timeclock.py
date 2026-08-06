#!/usr/bin/env python3
"""
[INPUT]: 只依赖标准库 re/datetime；业务当前分钟由调用方从 LifeOS health 冻结后传入，本模块不发起任何网络请求。
[OUTPUT]: 对外提供 LifeOSTimeError（兼容导出 TimeOSError）、带 0–400 天回溯边界的 HH:MM 与完整分钟解析（resolve_minute/require_full_minute）、业务日期核对、切换边界无缝断言与进行中段写入年龄计算。
[POS]: skills/zzm-lifeos/scripts 的时间领域纯函数层，被 timectl.py 消费；把“哪个钟点属于哪一天”的裁定权从 Agent 收归代码，歧义一律硬失败而非猜测。
[PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
"""

from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone
from typing import Any


MINUTE_FULL_PATTERN = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$")
MINUTE_SHORT_PATTERN = re.compile(r"^(\d{1,2}):(\d{2})$")
# 用户报的钟点可能比业务时钟快几分钟（设备时钟偏差、说话时向上取整）。这点偏差
# 收敛到当前分钟只差几分钟，若当成“昨天的这个钟点”则整整错一天。
CLOCK_SKEW_TOLERANCE_MINUTES = 10
# 短钟点向后推定的跨度上限。逼近 1440 时“同一天的更晚钟点”与“次日同一钟点”
# 已无从区分，服务端 1440 上限恰好放行 1440，不能当安全网。
MAX_SHORT_SPAN_MINUTES = 960


class LifeOSTimeError(RuntimeError):
    """表示时间事实无法安全定位，或时间写入护栏拒绝继续。"""


# 兼容 TimeOS 金样和仍在迁移中的 timectl import；新代码优先使用 LifeOSTimeError。
TimeOSError = LifeOSTimeError


# ==============================================================================
# 分钟格式
# ==============================================================================


def format_minute_value(value: datetime) -> str:
    return value.strftime("%Y-%m-%dT%H:%M")


def parse_full_minute(value: str, field: str) -> datetime:
    if not MINUTE_FULL_PATTERN.fullmatch(value):
        raise LifeOSTimeError(f"{field} 必须是 YYYY-MM-DDTHH:MM 或 HH:MM。")
    try:
        return datetime.strptime(value, "%Y-%m-%dT%H:%M")
    except ValueError as exc:
        raise LifeOSTimeError(f"{field} 不是有效分钟：{value}") from exc


def require_full_minute(raw: str, field: str) -> str:
    """要求完整分钟：修改历史时段没有“现在”可参照，短钟点必然落到错误的一天。"""
    value = str(raw).strip()
    if not MINUTE_FULL_PATTERN.fullmatch(value):
        raise LifeOSTimeError(
            f"{field} 必须写完整的 YYYY-MM-DDTHH:MM。被修改的时段没有“现在”作参照，"
            f"只写 {raw!r} 这样的钟点会落到错误的一天；请先用 segments 查出它的真实日期。"
        )
    parse_full_minute(value, field)
    return value


# ==============================================================================
# 钟点解析：日期算术属于脚本，不属于 Agent
# ==============================================================================


def resolve_minute(
    raw: str,
    clock: dict[str, str],
    *,
    after: str | None = None,
    days_ago: int = 0,
    field: str = "时间",
) -> tuple[str, str]:
    """把用户口述钟点解析为业务时区绝对分钟，并返回可回显的解析轨迹。

    完整分钟按用户显式日期原样采用。`HH:MM` 的自然日由业务时钟推定：给出
    `after` 时取其后第一次出现的该钟点，跨零点因此自然落到次日；否则取不晚于
    业务当前分钟的最近一次，即用户所说的“刚刚”。

    两处刻意的硬失败守住整日歧义：钟点与参照分钟完全相同时，无法区分“这段其实
    没发生”与“整整过了一天”；短钟点推出的跨度超过 MAX_SHORT_SPAN_MINUTES 时同样
    两解并存。宁可要求调用方带完整日期重来，也不把歧义静默写成横跨整天的幽灵时段。
    """
    value = str(raw).strip()
    if MINUTE_FULL_PATTERN.fullmatch(value):
        parse_full_minute(value, field)
        return value, f"{raw} → {value}（完整日期原样采用）"

    short = MINUTE_SHORT_PATTERN.fullmatch(value)
    if not short:
        raise LifeOSTimeError(f"{field} 必须是 YYYY-MM-DDTHH:MM 或 HH:MM，收到 {raw!r}。")
    hour, minute = int(short.group(1)), int(short.group(2))
    if hour > 23 or minute > 59:
        raise LifeOSTimeError(f"{field} 不是有效钟点：{raw}")

    if not 0 <= days_ago <= 400:
        raise LifeOSTimeError("--days-ago 只接受 0–400；补录更早的记录请给出完整 YYYY-MM-DDTHH:MM。")
    anchor = parse_full_minute(clock["currentLocalMinute"], "业务当前分钟") - timedelta(days=days_ago)

    if after is None:
        candidate = anchor.replace(hour=hour, minute=minute)
        note = ""
        if days_ago:
            # 调用方已显式声明目标自然日，钟点就落在那一天。此处再做“当天尚未到达
            # 所以退一天”的推断会多退一天，把前天的事写到三天前。
            note = "；自然日由 --days-ago 显式指定"
        elif candidate > anchor:
            skew = int((candidate - anchor).total_seconds() // 60)
            if skew <= CLOCK_SKEW_TOLERANCE_MINUTES:
                candidate = anchor
                note = f"；比业务当前分钟快 {skew} 分钟，已收敛到 {format_minute_value(anchor)}"
            else:
                candidate -= timedelta(days=1)
                note = "；该钟点当天尚未到达，按前一日解析"
        resolved = format_minute_value(candidate)
        basis = f"业务时钟回溯 {days_ago} 天推定" if days_ago else "业务时钟推定"
        return resolved, f"{raw} → {resolved}（{basis}{note}）"

    lower = parse_full_minute(after, "参照分钟")
    candidate = lower.replace(hour=hour, minute=minute)
    if candidate == lower:
        raise LifeOSTimeError(
            f"{field} 与参照的开始分钟 {after} 是同一钟点，无法区分“这段其实没有发生”与“整整过了一天”。"
            "若用户表示该活动未发生或记错了，请撤销该时段；确实跨日请给出完整 YYYY-MM-DDTHH:MM。"
        )
    if candidate < lower:
        candidate += timedelta(days=1)
    span = int((candidate - lower).total_seconds() // 60)
    if span > MAX_SHORT_SPAN_MINUTES:
        raise LifeOSTimeError(
            f"{field} 自 {after} 向后推出 {span} 分钟，超过 {MAX_SHORT_SPAN_MINUTES} 分钟；"
            "这个跨度上的短钟点已有整日歧义。请改用完整 YYYY-MM-DDTHH:MM 明确结束日期。"
        )
    resolved = format_minute_value(candidate)
    crossed = "，跨零点落到次日" if candidate.date() != lower.date() else ""
    return resolved, f"{raw} → {resolved}（自 {after} 向后推定{crossed}）"


# ==============================================================================
# 写入护栏
# ==============================================================================


def assert_business_date(declared: str, clock: dict[str, str]) -> None:
    """核对 Agent 声明的业务日期，拒绝把宿主机日期或模型幻觉写进账本。"""
    actual = clock["currentLocalDate"]
    if str(declared).strip() != actual:
        raise LifeOSTimeError(
            f"业务日期不符：Agent 声明今天是 {declared}，{clock['timezone']} 实际是 {actual}。"
            "请按真实业务日期重建时间线后重试；禁止沿用旧日期继续写入。"
        )


def assert_seamless(response: Any, boundary: str) -> dict[str, Any]:
    """证明切换只产生一个边界：旧段结束分钟必须等于新段开始分钟。

    没有前驱时不谎称无缝，也不静默放行：返回 openedWithoutPredecessor，由调用方
    补上“距上一条已闭合记录之间有多少空白”这一事实，避免把数小时空白回显成切换。
    """
    if not isinstance(response, dict):
        raise LifeOSTimeError("服务端未返回可校验的写入回执。")
    segment = response.get("segment")
    if not isinstance(segment, dict) or segment.get("startedAt") != boundary:
        raise LifeOSTimeError(f"新时段起点不是预期边界 {boundary}，已放弃回显成功。")
    closed = response.get("closedPrevious")
    if closed is None:
        return {"boundary": boundary, "closedPrevious": None, "openedWithoutPredecessor": True}
    if not isinstance(closed, dict) or closed.get("endedAt") != boundary:
        raise LifeOSTimeError(
            f"上一时段结束于 {closed.get('endedAt') if isinstance(closed, dict) else '未知'}，"
            f"与新时段起点 {boundary} 不一致；账本可能留下空白，请立即核查。"
        )
    return {"boundary": boundary, "closedPrevious": closed, "seamless": True}


def parse_audit_time(raw: Any, field: str) -> datetime:
    """解析服务端 UTC 审计时间；无法确认时间即视为不可判定，直接失败。"""
    if not isinstance(raw, str) or not raw.strip():
        raise LifeOSTimeError(f"时段缺少 {field}，无法确认它的写入时间。")
    text = raw.strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError as exc:
        raise LifeOSTimeError(f"无法解析 {field}：{raw}") from exc
    return parsed if parsed.tzinfo is not None else parsed.replace(tzinfo=timezone.utc)


def open_segment_age_minutes(segment: dict[str, Any], reference: datetime | None = None) -> int:
    """按 UTC 审计时间计算该时段写入至今的分钟数。

    刻意 fail-closed：createdAt 缺失或不可解析时抛错而非放行。这个数字是“AI 自我
    纠错”与“删除用户既有数据”之间唯一的闸门，确认不了年龄就不该删任何东西。
    """
    created = parse_audit_time(segment.get("createdAt"), "createdAt")
    current = reference or datetime.now(timezone.utc)
    return int((current - created).total_seconds() // 60)
