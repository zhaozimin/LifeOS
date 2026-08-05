"""
[INPUT]: 依赖 time Ledger 和 store 的本账本项目、时段只读投影。
[OUTPUT]: 对外提供 projects_summary 进程内只读函数。
[POS]: 未来时间×金钱交叉视图的接缝；E10 禁止将它复活为 HTTP 端点或把 finance 数据拉入 time.sqlite3。
[PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
"""

from __future__ import annotations

from collections import defaultdict
from typing import Any

from core.sqlite import Ledger
from domains.time.store import fetch_segments, load_master


def projects_summary(ledger: Ledger) -> list[dict[str, Any]]:
    """给同进程未来视图提供项目名称与活动时段数，不建立跨库关系。"""
    connection = ledger.connect()
    try:
        projects, segments = load_master(connection, "projects"), fetch_segments(connection)
    finally:
        connection.close()
    counts: dict[str, int] = defaultdict(int)
    for segment in segments:
        if segment.get("projectName"):
            counts[str(segment["projectName"])] += 1
    return [{"id": project["id"], "name": project["name"], "status": project.get("status", "active"), "segmentCount": counts[project["name"]]} for project in projects]
