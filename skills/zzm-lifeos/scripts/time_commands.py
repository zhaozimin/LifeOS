"""
[INPUT]: 依赖 timeclock 的业务分钟护栏与 lifeconn 的域前缀安全传输。
[OUTPUT]: 对外提供 timectl 的业务时钟、record/switch/stop/cancel/update/delete/reconcile 命令服务。
[POS]: 时间命令编排层；只把已验证的用户事实转换为 `/v1/time/*` 请求，不保存 Token、不重写时间账本规则。
[PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
"""

from __future__ import annotations

import json
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any
from urllib.parse import urlencode
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from lifeconn import LifeOSHTTPError, LifeOSTransportError, connection, request_api, request_write_api
from timeclock import (
    TimeOSError,
    assert_business_date,
    assert_seamless,
    open_segment_age_minutes,
    parse_full_minute,
    require_full_minute,
    resolve_minute,
)


CANCEL_MAX_AGE_MINUTES = 15
GAP_ALIGN_LIMIT_MINUTES = 5
OPEN_LOOKBACK_DAYS = 2


def _query(path: str, values: dict[str, Any]) -> str:
    pairs = [(key, str(value)) for key, value in values.items() if value is not None and value != ""]
    return path + ("?" + urlencode(pairs) if pairs else "")


def _write(method: str, path: str, payload: dict[str, Any], action: str) -> dict[str, Any]:
    """4xx 表示明确未写；其他失败必须保留结果未知纪律。"""
    try:
        return request_write_api(method, path, domain="time", payload=payload)
    except LifeOSHTTPError as exc:
        raise TimeOSError(f"{action}被服务端明确拒绝，账本未写入：{exc}") from exc
    except LifeOSTransportError as exc:
        raise TimeOSError(f"{action}结果未知；禁止重试，请先执行 segments 只读核查：{exc}") from exc


def business_clock(expected_timezone: str | None = None) -> dict[str, str]:
    """只从双域 health 的 time 投影取冻结时区，绝不使用宿主默认时区。"""
    health = request_api("GET", "/v1/health", domain="time")
    time_domain = health.get("domains", {}).get("time", {}) if isinstance(health, dict) else {}
    resolved = str(time_domain.get("resolvedTimezone") or "").strip()
    if not resolved:
        raise TimeOSError("LifeOS health 缺少 domains.time.resolvedTimezone，无法安全推定业务日期。")
    if expected_timezone == "system":
        raise TimeOSError("--expect-timezone 必须是具体 IANA 时区，不能使用 system。")
    if expected_timezone and expected_timezone != resolved:
        raise TimeOSError(f"记录时区不符：当前为 {resolved}，要求为 {expected_timezone}。")
    try:
        current = datetime.now(ZoneInfo(resolved)).replace(second=0, microsecond=0)
    except (ValueError, ZoneInfoNotFoundError) as exc:
        raise TimeOSError(f"LifeOS 返回无效 resolvedTimezone：{resolved}") from exc
    minute = current.strftime("%Y-%m-%dT%H:%M")
    return {"timezone": resolved, "resolvedTimezone": resolved, "currentLocalMinute": minute, "currentLocalDate": minute[:10]}


def _configuration() -> dict[str, Any]:
    payload = request_api("GET", "/v1/time/configuration", domain="time")
    if not isinstance(payload, dict):
        raise TimeOSError("configuration 回执无效。")
    return payload


def validate_master_data(category: str | None, project: str | None, expected_nature: str | None = None) -> None:
    configuration = _configuration()
    categories = {
        str(item.get("name")): str(item.get("nature") or "")
        for item in configuration.get("categories", [])
        if isinstance(item, dict) and item.get("name")
    }
    if category and category not in categories:
        raise TimeOSError(f"分类不存在：{category}。")
    if category and expected_nature and categories[category] != expected_nature:
        raise TimeOSError(f"分类性质不符：{category} 是 {categories[category]}，不是 {expected_nature}。")
    projects = {str(item.get("name")) for item in configuration.get("projects", []) if isinstance(item, dict)}
    if project and project not in projects:
        raise TimeOSError(f"项目不存在：{project}。")


def recent_segments(clock: dict[str, str]) -> list[dict[str, Any]]:
    anchor = parse_full_minute(clock["currentLocalMinute"], "业务当前分钟")
    payload = request_api(
        "GET", _query("/v1/time/segments", {"from": (anchor - timedelta(days=OPEN_LOOKBACK_DAYS)).date().isoformat()}), domain="time"
    )
    values = payload.get("segments", []) if isinstance(payload, dict) else []
    return [item for item in values if isinstance(item, dict)]


def locate_open_segment(clock: dict[str, str]) -> dict[str, Any]:
    open_items = [item for item in recent_segments(clock) if item.get("endedAt") is None]
    if len(open_items) != 1:
        raise TimeOSError("未能唯一定位进行中时段；请先执行 segments 核查。")
    return open_items[0]


def _gap_before(boundary: str, segments: list[dict[str, Any]]) -> dict[str, Any] | None:
    edge, preceding = parse_full_minute(boundary, "边界分钟"), None
    for item in segments:
        end = item.get("endedAt")
        if item.get("deletedAt") or not isinstance(end, str):
            continue
        candidate = parse_full_minute(end, "existing.endedAt")
        if candidate <= edge and (preceding is None or candidate > preceding[0]):
            preceding = (candidate, item)
    if preceding is None:
        return None
    ended, item = preceding
    return {"segment": item, "minutes": int((edge - ended).total_seconds() // 60)}


def _activity_payload(args: Any, started_at: str) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "title": args.title,
        "categoryName": args.category,
        "startedAt": started_at,
        "source": "agent",
    }
    if args.expected_nature:
        payload["expectedNature"] = args.expected_nature
    if args.project:
        payload["projectName"] = args.project
    if args.note:
        payload["note"] = args.note
    return payload


def _record_boundary(args: Any, clock: dict[str, str], field: str) -> str:
    if getattr(args, "use_now", False):
        return clock["currentLocalMinute"]
    raw = getattr(args, field)
    if not raw:
        raise TimeOSError(f"缺少 {field}。")
    resolved, _trace = resolve_minute(raw, clock, days_ago=args.days_ago, field=f"--{field.replace('_', '-')}")
    return resolved


def record(args: Any) -> dict[str, Any]:
    clock = business_clock(args.expect_timezone)
    assert_business_date(args.today, clock)
    validate_master_data(args.category, args.project, args.expected_nature)
    if args.ended_at and args.use_now:
        raise TimeOSError("闭合补录必须明确提供 --start 与 --end，不能使用 --now。")
    started_at = _record_boundary(args, clock, "started_at")
    payload = _activity_payload(args, started_at)
    if args.ended_at:
        ended_at, _trace = resolve_minute(args.ended_at, clock, after=started_at, field="--end")
        payload["endedAt"] = ended_at
    return _write("POST", "/v1/time/segments", payload, "时间记录")


def _preceding_record(preceding: dict[str, Any]) -> dict[str, Any]:
    """把 _gap_before 的前驱摘要摊成 timeview 认得的形状。

    字段名必须与 timeview._preceding_line / _preceding_as_segment 逐字对应——
    这里是回执契约的另一端，改名等于把 ⚠ 行重新变成死代码。
    """
    item = preceding["segment"]
    return {
        "gapMinutes": int(preceding["minutes"]),
        "previousEndedAt": item.get("endedAt"),
        "previousStartedAt": item.get("startedAt"),
        "previousTitle": item.get("title"),
        "previousGrossMinutes": item.get("grossMinutes"),
        "previousPureMinutes": item.get("pureMinutes"),
    }


def switch(args: Any) -> dict[str, Any]:
    clock = business_clock(args.expect_timezone)
    assert_business_date(args.today, clock)
    validate_master_data(args.category, args.project, args.expected_nature)
    boundary = _record_boundary(args, clock, "boundary")
    segments = recent_segments(clock)
    open_item = next((item for item in segments if item.get("endedAt") is None), None)
    if open_item and open_item.get("startedAt") == boundary:
        raise TimeOSError("进行中时段与本次切换同一分钟开始；请撤销误开或等到下一分钟。")
    preceding = None if open_item else _gap_before(boundary, segments)
    if open_item or preceding is None or preceding["minutes"] == 0 or args.allow_gap:
        result = _write("POST", "/v1/time/segments", _activity_payload(args, boundary), "活动切换")
        assert_seamless(result, boundary)
        if preceding and preceding["minutes"]:
            result["acknowledgedGapMinutes"] = preceding["minutes"]
        if open_item is None and preceding is not None:
            # 没有前驱可收尾时，把「此前那一格是什么」原样交给 timeview 去画。
            # 这三个字段是 timeview._preceding_line 的全部输入；此前只回一个
            # acknowledgedGapMinutes 整数，而消费端读的是 precedingRecord 对象，
            # 生产者与消费者从未接上，⚠ 未记录 行因此从上线起就画不出来——
            # 而参考文档还在要求 Agent「原样转达 ⚠ 行、不要自己复述空白」，
            # 于是空白提示通道两头皆空，19 小时的记录中断也无人喊一声。
            result["openedWithoutPredecessor"] = True
            result["boundary"] = boundary
            result["precedingRecord"] = _preceding_record(preceding)
        return result
    previous = preceding["segment"]
    if preceding["minutes"] > GAP_ALIGN_LIMIT_MINUTES:
        raise TimeOSError(f"前一条记录与本次边界相差 {preceding['minutes']} 分钟，超过自动对齐上限；请先询问空白事实。")
    if previous.get("source") != "agent":
        raise TimeOSError("前一条记录不是 Agent 写入，拒绝自动延长；请先显式 update 并获得用户确认。")
    transaction = _write(
        "POST", "/v1/time/segments/reconcile",
        {"operations": [
            {"action": "update", "id": previous["id"], "payload": {"endedAt": boundary}},
            {"action": "create", "payload": _activity_payload(args, boundary)},
        ]},
        "对齐后切换",
    )
    results = transaction.get("results", [])
    aligned = next((item.get("segment") for item in results if isinstance(item, dict) and item.get("action") == "update"), None)
    created = next((item.get("segment") for item in results if isinstance(item, dict) and item.get("action") == "create"), None)
    if not isinstance(aligned, dict) or aligned.get("endedAt") != boundary or not isinstance(created, dict) or created.get("startedAt") != boundary:
        raise TimeOSError("对齐事务回执未能证明新时段起点；禁止按成功回显。")
    return {
        "transaction": transaction, "results": results, "segment": created, "closedPrevious": aligned,
        "alignedPrevious": {"endedAtWas": previous.get("endedAt"), "endedAtNow": boundary},
    }


def stop(args: Any) -> dict[str, Any]:
    clock = business_clock(args.expect_timezone)
    assert_business_date(args.today, clock)
    if args.segment_id:
        current = next((item for item in recent_segments(clock) if item.get("id") == args.segment_id), None)
        if current is None:
            raise TimeOSError("指定时段不在可安全核查窗口内；请先用 segments 确认。")
    else:
        current = locate_open_segment(clock)
    if args.use_now:
        ended_at = clock["currentLocalMinute"]
    else:
        started = current.get("startedAt")
        if not isinstance(started, str):
            raise TimeOSError("进行中时段缺少 startedAt，拒绝收尾。")
        ended_at, _trace = resolve_minute(args.ended_at, clock, after=started, field="--at")
    payload: dict[str, Any] = {"endedAt": ended_at, "deductionMinutes": args.deduction_minutes}
    return _write("POST", f"/v1/time/segments/{current['id']}/stop", payload, "时段收尾")


def cancel(args: Any) -> dict[str, Any]:
    clock = business_clock(args.expect_timezone)
    assert_business_date(args.today, clock)
    expected = require_full_minute(args.expect_start, "--expect-start")
    current = locate_open_segment(clock)
    if current.get("startedAt") != expected:
        raise TimeOSError("进行中时段起点与 --expect-start 不符，拒绝撤销。")
    if current.get("source") != "agent":
        raise TimeOSError("进行中时段不是 Agent 本轮写入，拒绝撤销。")
    age = open_segment_age_minutes(current)
    if age < 0 or age > CANCEL_MAX_AGE_MINUTES:
        raise TimeOSError("进行中时段不在本轮 15 分钟误开窗口内，拒绝撤销。")
    response = _write("DELETE", f"/v1/time/segments/{current['id']}", {"reason": args.reason, "operator": "agent", "revertAutoClose": True}, "误开撤销")
    cancelled = response.get("segment")
    if not isinstance(cancelled, dict) or not cancelled.get("deletedAt"):
        raise TimeOSError("服务端未确认软删除，禁止按成功回显。")
    return {"cancelled": cancelled, "restoredPrevious": response.get("restoredPrevious"), "ageMinutes": age}


def update(args: Any) -> dict[str, Any]:
    clock = business_clock(args.expect_timezone)
    assert_business_date(args.today, clock)
    validate_master_data(args.category, args.project, args.expected_nature)
    payload = {key: value for key, value in (
        ("title", args.title), ("categoryName", args.category), ("expectedNature", args.expected_nature),
        ("startedAt", require_full_minute(args.started_at, "--start") if args.started_at else None),
        ("endedAt", require_full_minute(args.ended_at, "--end") if args.ended_at else None), ("note", args.note),
    ) if value is not None}
    if args.project is not None:
        payload["projectName"] = args.project
    if args.clear_project:
        payload["projectName"] = None
    if args.clear_note:
        payload["note"] = None
    if not payload:
        raise TimeOSError("update 至少需要一个修改字段。")
    return _write("PUT", f"/v1/time/segments/{args.segment_id}", payload, "时段更新")


def delete(args: Any) -> dict[str, Any]:
    return _write("DELETE", f"/v1/time/segments/{args.segment_id}", {"reason": args.reason, "operator": "agent"}, "时段删除")


def reconcile(args: Any) -> dict[str, Any]:
    clock = business_clock(args.expect_timezone)
    assert_business_date(args.today, clock)
    try:
        plan = json.loads(Path(args.plan_file).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise TimeOSError("对账计划必须是 JSON 对象文件。") from exc
    operations = plan.get("operations") if isinstance(plan, dict) else None
    if not isinstance(operations, list) or not operations:
        raise TimeOSError("对账计划必须包含非空 operations 数组。")
    normalized = []
    for index, operation in enumerate(operations):
        if not isinstance(operation, dict) or not isinstance(operation.get("payload", {}), dict):
            raise TimeOSError(f"operations[{index}] 必须是对象且 payload 必须是对象。")
        item, payload = dict(operation), dict(operation.get("payload", {}))
        if item.get("action") in {"create", "update"}:
            validate_master_data(payload.get("categoryName"), payload.get("projectName"), payload.get("expectedNature"))
        if item.get("action") == "create":
            payload["source"] = "agent"
        if item.get("action") == "delete":
            payload.setdefault("reason", "AI 复合对账删除误记")
            payload.setdefault("operator", "agent")
        item["payload"] = payload
        normalized.append(item)
    transaction = _write("POST", "/v1/time/segments/reconcile", {"operations": normalized}, "复合对账")
    if not args.verify_from and not args.verify_to:
        return transaction
    try:
        verification = request_api("GET", _query("/v1/time/segments", {"from": args.verify_from, "to": args.verify_to}), domain="time")
    except (LifeOSHTTPError, LifeOSTransportError) as exc:
        return {"transaction": transaction, "verificationStatus": "failed_after_commit", "verificationWarning": f"对账已提交，只读验证失败；禁止重放：{exc}"}
    return {"transaction": transaction, "verification": verification}


def locate() -> dict[str, Any]:
    active = connection()
    return {"installPath": str(active.root), "baseUrl": f"http://127.0.0.1:{active.port}"}


def raw_request(method: str, path: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
    """仅保留给诊断命令的受限低层入口；域前缀在本地先行阻断。"""
    if not path.startswith("/v1/time/") and not (method.upper() == "GET" and path == "/v1/health"):
        raise TimeOSError("request 只能访问 /v1/time/* 或 GET /v1/health。")
    if method.upper() == "GET":
        return request_api(method, path, domain="time", payload=payload)
    return _write(method, path, payload or {}, f"{method.upper()} {path}")
