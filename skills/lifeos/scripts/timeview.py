#!/usr/bin/env python3
"""
[INPUT]: 依赖 timectl 各写命令构造的回执字典与其中的服务端时段字段（title/startedAt/endedAt/grossMinutes/pureMinutes）；只用标准库，不发网络请求、不读配置、不导入 timeclock 与 lifeconn。
[OUTPUT]: 对外提供 render(command, receipt) 与 attach_display(command, receipt)（兼容别名 attach），把任意写回执折叠成“上一格 + 当前格”两行成品文本挂在 display 字段上，并提供五个状态符常量；单参数 render 仅为迁移期 timectl 的兼容入口。
[POS]: skills/lifeos/scripts 的呈现纯函数层，与 timeclock 并列为第二个无副作用层；把回显正确性从提示词下沉到代码，让 Agent 只需转达而不必组织语言。渲染中的任何意外一律降级为不给 display，绝不把已落库的写入反报为失败。
[PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
"""

from __future__ import annotations

from datetime import datetime
from typing import Any

# ==============================================================================
# 状态符：五个封闭，各自只对应一种账本状态，与命令名无关
# ==============================================================================
# 回执报告的是账本变成了什么样，不是执行了哪条命令。命令名是系统的内部概念，
# 用户不关心；把符号绑在命令上，就会退回“一条命令一种模板”的老路。
GLYPH_CLOSED = "✓"     # 已封口的时间块
GLYPH_OPEN = "▶"       # 正在进行的时间块
GLYPH_GAP = "⚠"        # 未记录的时间块（空白也是一种块）
GLYPH_CANCELLED = "✗"  # 已撤销或已删除的时间块
GLYPH_HALTED = "⏸"     # 此后没有进行中活动

_SEP = " · "
_DASH = "–"  # en dash：与时间区间的排版习惯一致，不用 ASCII 连字符


# ==============================================================================
# 纯格式化
# ==============================================================================


def _clock(value: Any) -> str | None:
    """把完整分钟串取成 HH:MM；账本里的日期不属于回执，用户说的是钟点。"""
    if not isinstance(value, str):
        return None
    text = value.strip()
    if "T" in text:
        candidate = text.split("T", 1)[1][:5]
    else:
        candidate = text[:5]
    return candidate if len(candidate) == 5 and candidate[2] == ":" else None


def _duration(minutes: Any) -> str | None:
    """1h22m / 45m。有小时位时分钟补零，让多行回执的数字列自然对齐。"""
    if not isinstance(minutes, int) or isinstance(minutes, bool) or minutes < 0:
        return None
    hours, rest = divmod(minutes, 60)
    return f"{hours}h{rest:02d}m" if hours else f"{rest}m"


def _elapsed(started_at: Any, ended_at: Any) -> int | None:
    """服务端没给 grossMinutes 时的兜底；只做两个绝对分钟的减法，不涉业务时钟。"""
    if not isinstance(started_at, str) or not isinstance(ended_at, str):
        return None
    try:
        delta = datetime.fromisoformat(ended_at) - datetime.fromisoformat(started_at)
    except ValueError:
        return None
    seconds = delta.total_seconds()
    return int(seconds // 60) if seconds >= 0 else None


def _span(segment: dict[str, Any]) -> str | None:
    """闭合段给起止，进行中段只给起点——它还没有长度可言。"""
    start = _clock(segment.get("startedAt"))
    if start is None:
        return None
    end = _clock(segment.get("endedAt"))
    return f"{start}{_DASH}{end}" if end else f"{start} 起"


def _pure_suffix(segment: dict[str, Any]) -> str:
    """只有真的扣除过才显示纯时间。柳比歇夫的纯时间是这本账的心脏，扣掉了就该看见。"""
    gross = segment.get("grossMinutes")
    pure = segment.get("pureMinutes")
    if not isinstance(gross, int) or not isinstance(pure, int) or pure == gross:
        return ""
    text = _duration(pure)
    return f"（纯 {text}）" if text else ""


def _title(segment: dict[str, Any]) -> str:
    text = segment.get("title")
    return text.strip() if isinstance(text, str) and text.strip() else "未命名活动"


def _closed_line(segment: Any, *, suffix: str = "") -> str | None:
    """上行：刚刚封口的那一格。"""
    if not isinstance(segment, dict):
        return None
    span = _span(segment)
    if span is None:
        return None
    gross = segment.get("grossMinutes")
    if not isinstance(gross, int):
        gross = _elapsed(segment.get("startedAt"), segment.get("endedAt"))
    parts = [f"{GLYPH_CLOSED} {_title(segment)}", span]
    length = _duration(gross)
    if length:
        parts.append(length + _pure_suffix(segment))
    return _SEP.join(parts) + suffix


def _open_line(segment: Any, *, suffix: str = "") -> str | None:
    """下行：正在敞着的那一格，只有起点。"""
    if not isinstance(segment, dict):
        return None
    start = _clock(segment.get("startedAt"))
    if start is None:
        return None
    return f"{GLYPH_OPEN} {_title(segment)}{_SEP}{start} 起{suffix}"


def _halted_line(minute: Any = None) -> str:
    clock = _clock(minute)
    return f"{GLYPH_HALTED} {clock} 起不再记录" if clock else f"{GLYPH_HALTED} 当前没有进行中活动"


# ==============================================================================
# 各写命令的两行
# ==============================================================================


def _preceding_as_segment(preceding: dict[str, Any]) -> dict[str, Any]:
    """gap_before 的前驱摘要换成时段形状，让它能走同一条 ✓ 渲染路径。"""
    return {
        "title": preceding.get("previousTitle"),
        "startedAt": preceding.get("previousStartedAt"),
        "endedAt": preceding.get("previousEndedAt"),
        "grossMinutes": preceding.get("previousGrossMinutes"),
        "pureMinutes": preceding.get("previousPureMinutes"),
    }


def _preceding_line(receipt: dict[str, Any]) -> str | None:
    """没有前驱可收尾时，上行由“此前那一格到底是什么”来占。

    空白也是一种时间块：把它画在上行，用户才能当场看见账本缺了哪一段，而不是
    把一次带空白的开段误读成无缝切换。
    """
    preceding = receipt.get("precedingRecord")
    boundary = receipt.get("boundary")
    if not isinstance(preceding, dict):
        return None
    minutes = preceding.get("gapMinutes")
    if not isinstance(minutes, int):
        return None
    if minutes == 0:
        # 上一条正好结束在本次边界：账本本来就是连续的，照常画成已封口的一格。
        return _closed_line(_preceding_as_segment(preceding))
    start = _clock(preceding.get("previousEndedAt"))
    end = _clock(boundary)
    length = _duration(minutes)
    if start is None or end is None or length is None:
        return None
    # 当前护栏下只有「已确认不记」这一支到得了：超过 5 分钟的空白 switch 直接拒绝，
    # 只有 --allow-gap 才写得进来，而它必然带上 acknowledgedGapMinutes。
    # 另一支保留：它正确渲染「有空白且未被确认」这个状态，将来护栏若放宽即刻可用，
    # 无条件写死「已确认不记」反而会在那天把没确认过的空白说成确认过。
    tail = "（已确认不记）" if isinstance(receipt.get("acknowledgedGapMinutes"), int) else " ← 这段在做什么？"
    return f"{GLYPH_GAP} 未记录{_SEP}{start}{_DASH}{end}{_SEP}{length}{tail}"


def _render_switch(receipt: dict[str, Any]) -> list[str]:
    lines: list[str] = []
    closed = receipt.get("closedPrevious")
    if isinstance(closed, dict):
        suffix = ""
        aligned = receipt.get("alignedPrevious")
        if isinstance(aligned, dict):
            was, now = _clock(aligned.get("endedAtWas")), _clock(aligned.get("endedAtNow"))
            if was and now:
                suffix = f"（已由 {was} 对齐到 {now}）"
        lines.append(_closed_line(closed, suffix=suffix) or "")
    else:
        lines.append(_preceding_line(receipt) or "")
    lines.append(_open_line(receipt.get("segment")) or "")
    return [line for line in lines if line]


def _render_record(receipt: dict[str, Any]) -> list[str]:
    segment = receipt.get("segment")
    if not isinstance(segment, dict) or not segment.get("endedAt"):
        # 省略 --end 的 record 实际上就是开了一段，形状与 switch 相同。
        return _render_switch(receipt)
    lines = [_closed_line(segment) or ""]
    current = receipt.get("currentOpen")
    if isinstance(current, dict):
        lines.append(_open_line(current, suffix="（未变）") or "")
    elif receipt.get("currentOpenStatus") == "none":
        lines.append(_halted_line())
    return [line for line in lines if line]


def _render_stop(receipt: dict[str, Any]) -> list[str]:
    segment = receipt.get("segment")
    lines = [_closed_line(segment) or ""]
    if isinstance(segment, dict):
        lines.append(_halted_line(segment.get("endedAt")))
    return [line for line in lines if line]


def _render_cancel(receipt: dict[str, Any]) -> list[str]:
    cancelled = receipt.get("cancelled")
    lines: list[str] = []
    if isinstance(cancelled, dict):
        start = _clock(cancelled.get("startedAt"))
        if start:
            lines.append(f"{GLYPH_CANCELLED} 已撤销 {_title(cancelled)}{_SEP}{start} 那条")
    restored = receipt.get("restoredPrevious")
    if isinstance(restored, dict):
        lines.append(_open_line(restored, suffix="（已恢复为进行中）") or "")
    else:
        lines.append(_halted_line())
    return [line for line in lines if line]


def _render_single(receipt: dict[str, Any], suffix: str) -> list[str]:
    """update：只画被改动的那一条。它改的是历史，当前那一格并未变动。"""
    segment = receipt.get("segment")
    if not isinstance(segment, dict):
        return []
    line = (
        _closed_line(segment, suffix=suffix)
        if segment.get("endedAt")
        else _open_line(segment, suffix=suffix)
    )
    return [line] if line else []


def _render_delete(receipt: dict[str, Any]) -> list[str]:
    segment = receipt.get("segment")
    if not isinstance(segment, dict):
        return []
    span = _span(segment)
    return [f"{GLYPH_CANCELLED} 已删 {_title(segment)}{_SEP}{span}"] if span else []


def _render_reconcile(receipt: dict[str, Any]) -> list[str]:
    """复合对账是唯一允许超两行的：一句话纠三段错，压成两行就会丢事实。

    仍然守住“最后一行是当前那一格”——删除画在最前，其余按起点排序，进行中段
    因为起点最晚而自然落到末尾。
    """
    transaction = receipt.get("transaction")
    if not isinstance(transaction, dict):
        transaction = receipt
    results = transaction.get("results")
    if not isinstance(results, list):
        return []

    removed: list[str] = []
    kept: list[dict[str, Any]] = []
    for item in results:
        if not isinstance(item, dict):
            continue
        segment = item.get("segment")
        if not isinstance(segment, dict):
            continue
        if item.get("action") == "delete" or segment.get("deletedAt"):
            span = _span(segment)
            if span:
                removed.append(f"{GLYPH_CANCELLED} 已删 {_title(segment)}{_SEP}{span}")
        else:
            kept.append(segment)

    kept.sort(key=lambda item: str(item.get("startedAt") or ""))
    lines = list(removed)
    for segment in kept:
        line = _closed_line(segment) if segment.get("endedAt") else _open_line(segment)
        if line:
            lines.append(line)
    return lines


_RENDERERS = {
    "record": _render_record,
    "switch": _render_switch,
    "start": _render_switch,
    "stop": _render_stop,
    "cancel": _render_cancel,
    "update": lambda receipt: _render_single(receipt, "（已修改）"),
    "delete": _render_delete,
    "reconcile": _render_reconcile,
}


def _legacy_line(segment: dict[str, Any]) -> str:
    """保留简化版 timectl 尚未升级时的单参回显形状，避免迁移窗口误报。"""
    if segment.get("deletedAt"):
        symbol = GLYPH_CANCELLED
    elif segment.get("endedAt") is None:
        symbol = GLYPH_OPEN
    else:
        symbol = GLYPH_CLOSED
    start = str(segment.get("startedAt", ""))[-5:]
    end = str(segment.get("endedAt", ""))[-5:]
    span = f"{start}{_DASH}{end}" if segment.get("endedAt") else f"{start} 起"
    return f"{symbol} {span} {segment.get('title', '')}".strip()


def _legacy_render(receipt: Any) -> str | None:
    """迁移兼容入口；正式命令面必须调用二参 render/attach。"""
    try:
        if not isinstance(receipt, dict):
            return None
        if isinstance(receipt.get("results"), list):
            lines = [_legacy_line(item["segment"]) for item in receipt["results"] if isinstance(item, dict) and isinstance(item.get("segment"), dict)]
        else:
            lines = [_legacy_line(receipt[key]) for key in ("closedPrevious", "restoredPrevious", "segment") if isinstance(receipt.get(key), dict)]
        return "\n".join(lines) or None
    except Exception:  # noqa: BLE001 — 兼容层同样不得改写已提交事实
        return None


def render(command: str | dict[str, Any], receipt: Any = None) -> list[str] | str | None:
    """把一次写入的回执折叠成成品行；无法确定账本状态时宁可不给。

    正式调用为 ``render(command, receipt)``，返回文本行列表。单参调用只在 timectl
    命令面尚未完成平移时保持旧返回值，避免升级次序让已成功的写入被错误回报为失败。
    """
    if receipt is None:
        return _legacy_render(command)
    renderer = _RENDERERS.get(command) if isinstance(command, str) else None
    if renderer is None or not isinstance(receipt, dict):
        return None
    return renderer(receipt) or None


def attach(command: str, receipt: Any) -> Any:
    """把 display 挂到回执上并原样返回。

    呈现层不得改写事实：账本已经落库，这里的任何意外都只该让回执少一个字段，
    而不该让一次成功的写入被回报成失败。
    """
    if not isinstance(receipt, dict):
        return receipt
    try:
        lines = render(command, receipt)
    except Exception:  # noqa: BLE001 —— 见 docstring：呈现失败不得改写写入结果
        lines = None
    if isinstance(lines, list) and lines:
        receipt["display"] = lines
    return receipt


# timectl 以动作语义导入，外部旧金样仍可使用较短的 attach 名称。
attach_display = attach
