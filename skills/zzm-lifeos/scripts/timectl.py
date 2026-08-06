"""
[INPUT]: 依赖 time_commands 的受护栏命令服务、timeview 的 display 组装与 lifeconn 的单一连接边界。
[OUTPUT]: 提供 time 的 record/switch/start/stop/cancel/update/delete/reconcile、查询和业务时钟命令。
[POS]: LifeOS Skill 的时间 CLI；所有写入固定走 `/v1/time/*`，命令参数把日期、空白与撤销安全边界从 Agent 收归脚本。
[PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any, Callable

from lifeconn import LifeOSHTTPError, LifeOSTransportError, request_api
from time_commands import (
    TimeOSError,
    business_clock,
    cancel,
    delete,
    locate,
    raw_request,
    record,
    reconcile,
    recent_segments,
    stop,
    switch,
    update,
)
from timeview import attach_display


def _print(value: Any) -> None:
    print(json.dumps(value, ensure_ascii=False))


def _guards(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--today", required=True, help="Agent 声明的业务日期；与服务端冻结时区不符即拒绝写入。")
    parser.add_argument("--expect-timezone", help="可选的具体 IANA 时区断言；禁止使用 system。")


def _activity(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--title", required=True)
    parser.add_argument("--category", required=True)
    parser.add_argument("--nature", dest="expected_nature", choices=("core", "support", "recovery", "leisure"))
    parser.add_argument("--project")
    parser.add_argument("--note")
    parser.add_argument("--days-ago", type=int, default=0, help="短钟点属于几天前；范围由 timeclock 限制为 0–400。")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="LifeOS 时间账本安全命令。")
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("locate")
    commands.add_parser("health")
    commands.add_parser("configuration")
    clock = commands.add_parser("clock"); clock.add_argument("--expect-timezone")

    record_parser = commands.add_parser("record", help="记录补录或开始活动。")
    _activity(record_parser)
    start_group = record_parser.add_mutually_exclusive_group(required=True)
    start_group.add_argument("--start", "--from", dest="started_at")
    start_group.add_argument("--now", dest="use_now", action="store_true")
    record_parser.add_argument("--end", "--to", dest="ended_at")
    _guards(record_parser)

    switch_parser = commands.add_parser("switch", aliases=["start"], help="以单一边界切换活动；必要时原子对齐 Agent 前驱。")
    _activity(switch_parser)
    boundary_group = switch_parser.add_mutually_exclusive_group(required=True)
    boundary_group.add_argument("--at", "--start", "--from", dest="boundary")
    boundary_group.add_argument("--now", dest="use_now", action="store_true")
    switch_parser.add_argument("--allow-gap", action="store_true", help="明确承认边界前的未记录空白。")
    _guards(switch_parser)

    stop_parser = commands.add_parser("stop", help="结束唯一进行中时段。")
    stop_parser.add_argument("--id", dest="segment_id")
    end_group = stop_parser.add_mutually_exclusive_group(required=True)
    end_group.add_argument("--at", "--end", "--to", dest="ended_at")
    end_group.add_argument("--now", dest="use_now", action="store_true")
    stop_parser.add_argument("--deduction-minutes", type=int, default=0)
    _guards(stop_parser)

    cancel_parser = commands.add_parser("cancel", help="仅撤销本轮刚误开的 Agent 进行中时段。")
    cancel_parser.add_argument("--expect-start", required=True, help="从上一条回执原样复制的完整分钟。")
    cancel_parser.add_argument("--reason", default="AI 本轮误开撤销")
    _guards(cancel_parser)

    update_parser = commands.add_parser("update")
    update_parser.add_argument("--id", dest="segment_id", required=True)
    update_parser.add_argument("--title"); update_parser.add_argument("--category")
    update_parser.add_argument("--nature", dest="expected_nature", choices=("core", "support", "recovery", "leisure"))
    project_group = update_parser.add_mutually_exclusive_group(); project_group.add_argument("--project"); project_group.add_argument("--clear-project", action="store_true")
    update_parser.add_argument("--start", dest="started_at"); update_parser.add_argument("--end", dest="ended_at")
    note_group = update_parser.add_mutually_exclusive_group(); note_group.add_argument("--note"); note_group.add_argument("--clear-note", action="store_true")
    _guards(update_parser)

    delete_parser = commands.add_parser("delete")
    delete_parser.add_argument("--id", dest="segment_id", required=True); delete_parser.add_argument("--reason", required=True)

    reconcile_parser = commands.add_parser("reconcile")
    reconcile_parser.add_argument("--plan-file", required=True)
    reconcile_parser.add_argument("--verify-from"); reconcile_parser.add_argument("--verify-to")
    _guards(reconcile_parser)

    segments = commands.add_parser("segments")
    segments.add_argument("--from", dest="from_value"); segments.add_argument("--to", dest="to_value"); segments.add_argument("--include-deleted", action="store_true")
    gaps = commands.add_parser("gaps"); gaps.add_argument("--date")
    request = commands.add_parser("request")
    request.add_argument("method", choices=("GET", "POST", "PUT", "DELETE")); request.add_argument("path"); request.add_argument("--payload-file")
    return parser


WRITE_HANDLERS: dict[str, Callable[[Any], dict[str, Any]]] = {
    "record": record, "switch": switch, "start": switch, "stop": stop,
    "cancel": cancel, "update": update, "delete": delete, "reconcile": reconcile,
}


def _read_payload(path: str | None) -> dict[str, Any] | None:
    if not path:
        return None
    try:
        payload = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise TimeOSError("payload 文件必须是 JSON 对象。") from exc
    if not isinstance(payload, dict):
        raise TimeOSError("payload 文件必须是 JSON 对象。")
    return payload


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        if args.command == "locate":
            result = locate()
        elif args.command == "health":
            result = request_api("GET", "/v1/health", domain="time")
        elif args.command == "configuration":
            result = request_api("GET", "/v1/time/configuration", domain="time")
        elif args.command == "clock":
            result = business_clock(args.expect_timezone)
        elif args.command in WRITE_HANDLERS:
            result = attach_display(args.command, WRITE_HANDLERS[args.command](args))
        elif args.command == "segments":
            query = {"from": args.from_value, "to": args.to_value, "includeDeleted": "true" if args.include_deleted else None}
            from urllib.parse import urlencode
            path = "/v1/time/segments" + ("?" + urlencode({key: value for key, value in query.items() if value}) if any(query.values()) else "")
            result = request_api("GET", path, domain="time")
        elif args.command == "gaps":
            target = args.date or business_clock()["currentLocalDate"]
            result = request_api("GET", f"/v1/time/gaps?date={target}", domain="time")
        else:
            result = raw_request(args.method, args.path, _read_payload(args.payload_file))
    except (TimeOSError, LifeOSHTTPError, LifeOSTransportError, OSError, ValueError) as exc:
        _print({"ok": False, "message": str(exc)})
        return 2
    _print(result)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
