"""
[INPUT]: 依赖临时 runtime、LifeOS HTTP 应用工厂、时间域真实声明式路由与时间 Skill 的受护栏命令链。
[OUTPUT]: 对外提供时间段、配置（含超长阈值与 overlong 软标记）、主数据、无上限完整修改版本、统计、自动收尾及 `timectl → time_commands → lifeconn → timeview` 的随机端口回归。
[POS]: 时间域端到端契约测试；所有运行使用随机端口和临时 SQLite，绝不访问生产 51440/59418。
[PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
"""

from __future__ import annotations

import contextlib
import http.client
import io
import json
import os
import socket
import sqlite3
import sys
import tempfile
import threading
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

from core.config import write_config
from core.httpd import create_server
from lifeos_node_server import create_application


SKILL_SCRIPTS = Path(__file__).resolve().parents[1] / "skills" / "zzm-lifeos" / "scripts"
if str(SKILL_SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SKILL_SCRIPTS))

import lifeconn  # noqa: E402
import timectl  # noqa: E402


PRODUCTION_PORTS = frozenset({51440, 59418})


def reserve_port() -> int:
    """取一次性回环端口，并排除现役服务端口。

    59418 与 51440 都落在 macOS 临时端口范围 49152–65535 内：
    生产没在监听的那个窗口（例如 launchd 重启间隙），bind(0) 完全可能把它们交给测试。
    撞上之后测试自己占住生产端口，而 LaunchAgent 的 KeepAlive 会把端口冲突
    放大成无限重启——这个后果项目文档自己写过。
    此前四份端口辅助里只有 test_lifeos_deployment.reserve_test_port 带着这道防护。
    """
    while True:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
            probe.bind(("127.0.0.1", 0))
            port = int(probe.getsockname()[1])
        if port not in PRODUCTION_PORTS:
            return port


class TimeHttpFixture(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.runtime, self.port, self.token = Path(self.temporary.name) / "runtime", reserve_port(), "time-domain-test-token"
        write_config(self.runtime / "config.json", {"host": "127.0.0.1", "port": self.port, "accessToken": self.token, "allowedHosts": [], "timezone": "UTC", "timezoneSource": "system"})
        self.server = create_server(create_application(self.runtime))
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self) -> None:
        self.server.shutdown(); self.server.server_close(); self.thread.join(timeout=5); self.temporary.cleanup()

    def request(self, method: str, path: str, body: dict | None = None) -> tuple[int, dict]:
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        raw_body = json.dumps(body).encode("utf-8") if body is not None else None
        headers = {"Authorization": f"Bearer {self.token}", "Host": f"127.0.0.1:{self.port}"}
        if raw_body is not None: headers["Content-Type"] = "application/json"
        connection.request(method, path, body=raw_body, headers=headers)
        response = connection.getresponse()
        payload = json.loads(response.read().decode("utf-8"))
        connection.close()
        return response.status, payload


class IsolatedTimeLifeOS(TimeHttpFixture):
    def test_create_list_update_and_soft_delete(self) -> None:
        status, created = self.request("POST", "/v1/time/segments", {"title": "深度开发", "categoryName": "开发", "startedAt": "2026-07-27T09:00", "endedAt": "2026-07-27T10:00"})
        self.assertEqual(status, 201)
        segment_id = created["segment"]["id"]
        status, listed = self.request("GET", "/v1/time/segments")
        self.assertEqual(status, 200); self.assertEqual(len(listed["segments"]), 1)
        status, updated = self.request("PUT", f"/v1/time/segments/{segment_id}", {"note": "已复核"})
        self.assertEqual(status, 200); self.assertEqual(updated["segment"]["note"], "已复核")
        status, deleted = self.request("DELETE", f"/v1/time/segments/{segment_id}", {"reason": "测试撤销"})
        self.assertEqual(status, 200); self.assertIsNotNone(deleted["segment"]["deletedAt"])

    def test_opening_new_segment_closes_previous_at_new_boundary(self) -> None:
        now = datetime.now(timezone.utc).replace(second=0, microsecond=0)
        first, second = now - timedelta(minutes=12), now - timedelta(minutes=5)
        self.assertEqual(self.request("POST", "/v1/time/segments", {"title": "第一件事", "categoryName": "开发", "startedAt": first.strftime("%Y-%m-%dT%H:%M")})[0], 201)
        status, created = self.request("POST", "/v1/time/segments", {"title": "第二件事", "categoryName": "写作", "startedAt": second.strftime("%Y-%m-%dT%H:%M")})
        self.assertEqual(status, 201)
        self.assertEqual(created["closedPrevious"]["endedAt"], second.strftime("%Y-%m-%dT%H:%M"))
        self.assertIsNone(created["segment"]["endedAt"])

    def test_empty_stop_body_uses_current_minute_contract(self) -> None:
        now = datetime.now(timezone.utc).replace(second=0, microsecond=0)
        status, created = self.request("POST", "/v1/time/segments", {
            "title": "正在记录", "categoryName": "开发", "startedAt": (now - timedelta(minutes=2)).strftime("%Y-%m-%dT%H:%M"),
        })
        self.assertEqual(status, 201)
        status, stopped = self.request("POST", f"/v1/time/segments/{created['segment']['id']}/stop")
        self.assertEqual((status, stopped["segment"]["endedAt"] is not None), (200, True))

    def test_reconcile_rolls_back_when_later_operation_overlaps(self) -> None:
        status, payload = self.request("POST", "/v1/time/segments/reconcile", {"operations": [
            {"action": "create", "payload": {"title": "第一段", "categoryName": "开发", "startedAt": "2026-07-27T09:00", "endedAt": "2026-07-27T10:00"}},
            {"action": "create", "payload": {"title": "冲突段", "categoryName": "写作", "startedAt": "2026-07-27T09:30", "endedAt": "2026-07-27T10:30"}},
        ]})
        self.assertEqual(status, 422); self.assertEqual(payload["error"], "overlap")
        self.assertEqual(self.request("GET", "/v1/time/segments")[1]["segments"], [])

    def test_summary_and_old_unprefixed_path(self) -> None:
        self.request("POST", "/v1/time/segments", {"title": "开发", "categoryName": "开发", "startedAt": "2026-07-27T09:00", "endedAt": "2026-07-27T10:00"})
        status, summary = self.request("GET", "/v1/time/summary/range?from=2026-07-27&to=2026-07-27")
        self.assertEqual(status, 200); self.assertEqual(summary["effectiveWorkMinutes"], 60)
        status, payload = self.request("GET", "/v1/segments")
        self.assertEqual(status, 404); self.assertEqual(payload["error"], "not_found")

    def test_segments_filter_by_range_category_project_source_and_deletion(self) -> None:
        created = []
        for title, category, started_at, source in (
            ("开发", "开发", "2026-07-27T09:00", "manual"),
            ("写作", "写作", "2026-07-28T09:00", "import"),
        ):
            status, payload = self.request("POST", "/v1/time/segments", {
                "title": title, "categoryName": category, "startedAt": started_at,
                "endedAt": started_at[:11] + "10:00", "source": source,
            })
            self.assertEqual(status, 201)
            created.append(payload["segment"]["id"])
        status, filtered = self.request("GET", "/v1/time/segments?from=2026-07-27&to=2026-07-28&category=%E5%BC%80%E5%8F%91&source=manual")
        self.assertEqual((status, filtered["total"]), (200, 1))
        self.assertEqual(filtered["segments"][0]["id"], created[0])
        self.assertEqual(self.request("DELETE", f"/v1/time/segments/{created[0]}", {"reason": "筛选测试"})[0], 200)
        status, deleted = self.request("GET", "/v1/time/segments?includeDeleted=true&source=manual")
        self.assertEqual((status, deleted["total"], deleted["segments"][0]["deletedAt"] is not None), (200, 1, True))

    def test_timezone_convert_and_preserve_are_explicit_and_persisted(self) -> None:
        status, created = self.request("POST", "/v1/time/segments", {
            "title": "时区迁移", "categoryName": "开发", "startedAt": "2026-07-27T09:00", "endedAt": "2026-07-27T10:00",
        })
        self.assertEqual(status, 201)
        segment_id = created["segment"]["id"]
        status, missing_mode = self.request("PUT", "/v1/time/configuration", {"timezone": "Asia/Shanghai"})
        self.assertEqual((status, missing_mode["error"]), (400, "invalid_request"))
        status, converted = self.request("PUT", "/v1/time/configuration", {"timezone": "Asia/Shanghai", "historyMode": "convert"})
        self.assertEqual((status, converted["historyMode"], converted["convertedSegments"]), (200, "convert", 1))
        status, listed = self.request("GET", "/v1/time/segments")
        self.assertEqual((status, listed["segments"][0]["id"], listed["segments"][0]["startedAt"]), (200, segment_id, "2026-07-27T17:00"))
        self.assertEqual(listed["segments"][0]["startedUtc"], "2026-07-27T09:00:00+00:00")
        status, preserved = self.request("PUT", "/v1/time/configuration", {"timezone": "UTC", "historyMode": "preserve"})
        self.assertEqual((status, preserved["historyMode"]), (200, "preserve"))
        status, listed = self.request("GET", "/v1/time/segments")
        self.assertEqual((status, listed["segments"][0]["startedAt"], listed["segments"][0]["startedUtc"]), (200, "2026-07-27T17:00", "2026-07-27T17:00:00+00:00"))
        saved = json.loads((self.runtime / "config.json").read_text(encoding="utf-8"))
        self.assertEqual(saved["timezone"], "UTC")

    def test_master_data_requires_confirmation_and_leaves_audit_evidence(self) -> None:
        status, payload = self.request("POST", "/v1/time/agent/operations", {"entity": "project", "action": "create", "payload": {"name": "LifeOS", "status": "active"}})
        self.assertEqual(status, 422); self.assertEqual(payload["error"], "missing_user_confirmation")
        status, payload = self.request("POST", "/v1/time/agent/operations", {"userConfirmation": "请创建 LifeOS 项目", "entity": "project", "action": "create", "payload": {"name": "LifeOS", "status": "active"}})
        self.assertEqual(status, 200); self.assertEqual(payload["entity"]["name"], "LifeOS")
        status, events = self.request("GET", "/v1/time/audit/events")
        self.assertEqual(status, 200); self.assertEqual(events[0]["action"], "create")

    def test_configuration_reads_defaults_and_persists_week_start(self) -> None:
        status, configuration = self.request("GET", "/v1/time/configuration")
        self.assertEqual(status, 200)
        self.assertIn("core", configuration["natures"])
        self.assertEqual(configuration["settings"]["weekStart"], "monday")
        status, saved = self.request("PUT", "/v1/time/configuration", {"settings": {"weekStart": "sunday"}})
        self.assertEqual((status, saved["settings"]["weekStart"]), (200, "sunday"))
        self.assertEqual(self.request("GET", "/v1/time/configuration")[1]["settings"]["weekStart"], "sunday")

    def test_configuration_publishes_the_overlong_threshold(self) -> None:
        # 面板据此判断「进行中且已跑超阈值」，阈值必须走线上配置而不是前端硬编码 480。
        status, configuration = self.request("GET", "/v1/time/configuration")
        self.assertEqual((status, configuration["overlongSegmentMinutes"]), (200, 480))

    def test_overlong_closed_segment_is_marked_but_never_refused(self) -> None:
        # 复现 2026-07-31：一条 16 小时 42 分的「睡觉」必须写得进去，但在时间轴上要显形。
        status, overlong = self.request("POST", "/v1/time/segments", {
            "title": "睡觉", "categoryName": "睡眠", "startedAt": "2026-07-30T00:00", "endedAt": "2026-07-30T16:42",
        })
        self.assertEqual((status, overlong["segment"]["grossMinutes"], overlong["segment"]["overlong"]), (201, 1002, True))
        status, boundary = self.request("POST", "/v1/time/segments", {
            "title": "整八小时开发", "categoryName": "开发", "startedAt": "2026-07-30T16:42", "endedAt": "2026-07-31T00:42",
        })
        self.assertEqual((status, boundary["segment"]["grossMinutes"], boundary["segment"]["overlong"]), (201, 480, False))
        status, running = self.request("POST", "/v1/time/segments", {
            "title": "仍在进行", "categoryName": "写作", "startedAt": "2026-07-31T09:00",
        })
        self.assertEqual((status, running["segment"]["grossMinutes"], running["segment"]["overlong"]), (201, None, False))
        status, listed = self.request("GET", "/v1/time/segments")
        self.assertEqual(status, 200)
        marks = {row["id"]: row["overlong"] for row in listed["segments"]}
        self.assertEqual(marks, {
            overlong["segment"]["id"]: True, boundary["segment"]["id"]: False, running["segment"]["id"]: False,
        })

    def test_configuration_rejects_unknown_and_incomplete_timezone_writes(self) -> None:
        for body in ({"historyMode": "convert"}, {"timezone": "Asia/Shanghai"}, {"settings": {"weekStart": "friday"}}, {"unexpected": True}):
            with self.subTest(body=body):
                status, payload = self.request("PUT", "/v1/time/configuration", body)
                self.assertEqual(status, 400)
                self.assertEqual(payload["error"], "invalid_request")

    def test_expected_nature_blocks_a_contradictory_segment(self) -> None:
        status, payload = self.request("POST", "/v1/time/segments", {
            "title": "误判性质", "categoryName": "开发", "expectedNature": "support",
            "startedAt": "2026-07-27T09:00", "endedAt": "2026-07-27T10:00",
        })
        self.assertEqual((status, payload["error"]), (422, "category_nature_mismatch"))

    def test_stop_closed_segment_leaves_the_original_row_unchanged(self) -> None:
        status, created = self.request("POST", "/v1/time/segments", {
            "title": "已完成", "categoryName": "开发", "startedAt": "2026-07-27T09:00", "endedAt": "2026-07-27T10:00",
        })
        self.assertEqual(status, 201)
        status, payload = self.request("POST", f"/v1/time/segments/{created['segment']['id']}/stop")
        self.assertEqual((status, payload["error"]), (422, "invalid_range"))
        row = self.request("GET", "/v1/time/segments")[1]["segments"][0]
        self.assertEqual((row["startedAt"], row["endedAt"]), ("2026-07-27T09:00", "2026-07-27T10:00"))

    def test_delete_revert_auto_close_restores_the_precise_predecessor(self) -> None:
        now = datetime.now(timezone.utc).replace(second=0, microsecond=0)
        first, second = now - timedelta(minutes=12), now - timedelta(minutes=5)
        status, first_created = self.request("POST", "/v1/time/segments", {
            "title": "原活动", "categoryName": "开发", "startedAt": first.strftime("%Y-%m-%dT%H:%M"),
        })
        self.assertEqual(status, 201)
        status, mistaken = self.request("POST", "/v1/time/segments", {
            "title": "误开", "categoryName": "写作", "startedAt": second.strftime("%Y-%m-%dT%H:%M"),
        })
        self.assertEqual(status, 201)
        status, deleted = self.request("DELETE", f"/v1/time/segments/{mistaken['segment']['id']}", {"reason": "误开", "revertAutoClose": True})
        self.assertEqual(status, 200)
        self.assertEqual(deleted["restoredPrevious"]["id"], first_created["segment"]["id"])
        self.assertIsNone(deleted["restoredPrevious"]["endedAt"])

    def test_delete_revert_never_overwrites_a_user_corrected_boundary(self) -> None:
        now = datetime.now(timezone.utc).replace(second=0, microsecond=0)
        first, second = now - timedelta(minutes=12), now - timedelta(minutes=5)
        _, original = self.request("POST", "/v1/time/segments", {"title": "原活动", "categoryName": "开发", "startedAt": first.strftime("%Y-%m-%dT%H:%M")})
        _, mistaken = self.request("POST", "/v1/time/segments", {"title": "误开", "categoryName": "写作", "startedAt": second.strftime("%Y-%m-%dT%H:%M")})
        corrected_end = (second - timedelta(minutes=1)).strftime("%Y-%m-%dT%H:%M")
        status, _ = self.request("PUT", f"/v1/time/segments/{original['segment']['id']}", {"endedAt": corrected_end})
        self.assertEqual(status, 200)
        status, deleted = self.request("DELETE", f"/v1/time/segments/{mistaken['segment']['id']}", {"reason": "误开", "revertAutoClose": True})
        self.assertEqual(status, 200)
        self.assertIsNone(deleted["restoredPrevious"])

    def test_update_rejects_immutable_machine_fields(self) -> None:
        _, created = self.request("POST", "/v1/time/segments", {
            "title": "不可改", "categoryName": "开发", "startedAt": "2026-07-27T09:00", "endedAt": "2026-07-27T10:00",
        })
        status, payload = self.request("PUT", f"/v1/time/segments/{created['segment']['id']}", {"source": "manual"})
        self.assertEqual((status, payload["error"]), (422, "immutable_field"))
        status, payload = self.request("PUT", f"/v1/time/segments/{created['segment']['id']}", {"startedUtc": "2026-07-27T01:00:00+00:00"})
        self.assertEqual((status, payload["error"]), (422, "immutable_field"))

    def test_segment_requests_reject_unknown_fields_and_invalid_source(self) -> None:
        for body in (
            {"title": "未知字段", "categoryName": "开发", "startedAt": "2026-07-27T09:00", "endedAt": "2026-07-27T10:00", "malicious": True},
            {"title": "来源错误", "categoryName": "开发", "startedAt": "2026-07-27T09:00", "endedAt": "2026-07-27T10:00", "source": "system"},
        ):
            with self.subTest(body=body):
                status, payload = self.request("POST", "/v1/time/segments", body)
                self.assertEqual(status, 400)
                self.assertIn(payload["error"], {"invalid_request", "invalid_source"})

    def test_range_and_gaps_require_valid_query_parameters(self) -> None:
        for path in ("/v1/time/summary/range", "/v1/time/gaps", "/v1/time/summary/range?from=2026-07-28&to=2026-07-27"):
            with self.subTest(path=path):
                status, payload = self.request("GET", path)
                self.assertEqual((status, payload["error"]), (422, "invalid_range"))

    def test_gaps_hides_internal_denominator_and_reports_open_segment(self) -> None:
        now = datetime.now(timezone.utc).replace(second=0, microsecond=0)
        status, _ = self.request("POST", "/v1/time/segments", {
            "title": "进行中", "categoryName": "开发", "startedAt": (now - timedelta(minutes=3)).strftime("%Y-%m-%dT%H:%M"),
        })
        self.assertEqual(status, 201)
        status, payload = self.request("GET", f"/v1/time/gaps?date={now.date().isoformat()}")
        self.assertEqual(status, 200)
        self.assertNotIn("denominatorMinutes", payload)
        self.assertEqual(payload["openSegment"]["title"], "进行中")

    def test_habits_returns_keyword_matched_category_statistics(self) -> None:
        self.assertEqual(self.request("POST", "/v1/time/segments", {
            "title": "代码审阅", "categoryName": "开发", "startedAt": "2026-07-27T09:00", "endedAt": "2026-07-27T10:00",
        })[0], 201)
        status, payload = self.request("GET", "/v1/time/habits?q=%E7%BC%96%E7%A8%8B")
        self.assertEqual(status, 200)
        self.assertEqual(payload["category"], [{"name": "开发", "share": 1.0}])

    def test_agent_can_update_and_soft_delete_a_project_with_audit_chain(self) -> None:
        create = {"userConfirmation": "请创建项目", "entity": "project", "action": "create", "payload": {"name": "LifeOS", "status": "active"}}
        self.assertEqual(self.request("POST", "/v1/time/agent/operations", create)[0], 200)
        update = {"userConfirmation": "请暂停项目", "entity": "project", "action": "update", "name": "LifeOS", "payload": {"status": "paused"}}
        status, changed = self.request("POST", "/v1/time/agent/operations", update)
        self.assertEqual((status, changed["entity"]["status"]), (200, "paused"))
        delete = {"userConfirmation": "请删除项目", "entity": "project", "action": "delete", "name": "LifeOS", "payload": {}, "reason": "测试"}
        status, deleted = self.request("POST", "/v1/time/agent/operations", delete)
        self.assertEqual((status, deleted["entity"]["deletedBy"]), (200, "agent"))
        self.assertEqual(self.request("GET", "/v1/time/configuration")[1]["projects"], [])

    def test_protected_uncategorized_category_cannot_be_changed_or_deleted(self) -> None:
        body = {"userConfirmation": "请删除未归类", "entity": "category", "action": "delete", "name": "未归类", "payload": {}, "reason": "测试"}
        status, payload = self.request("POST", "/v1/time/agent/operations", body)
        self.assertEqual((status, payload["error"]), (422, "immutable_field"))

    def test_audit_history_has_no_implicit_cap(self) -> None:
        self.assertEqual(self.request("POST", "/v1/time/agent/operations", {
            "userConfirmation": "请创建项目", "entity": "project", "action": "create", "payload": {"name": "审计项目", "status": "active"},
        })[0], 200)
        connection = sqlite3.connect(self.runtime / "time" / "time.sqlite3")
        connection.executemany(
            "INSERT INTO audit_events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            [(f"bulk-{index}", f"2026-01-01T00:00:{index % 60:02d}Z", "test", "update", "segment", f"s-{index}", "历史", "{}", "{}") for index in range(501)],
        )
        connection.commit(); connection.close()
        status, events = self.request("GET", "/v1/time/audit/events")
        self.assertEqual((status, len(events)), (200, 502))

    def test_minute_range_uses_half_open_interval_boundaries(self) -> None:
        self.assertEqual(self.request("POST", "/v1/time/segments", {
            "title": "边界", "categoryName": "开发", "startedAt": "2026-07-27T09:00", "endedAt": "2026-07-27T10:00",
        })[0], 201)
        included = self.request("GET", "/v1/time/segments?from=2026-07-27T09:00&to=2026-07-27T10:00")[1]
        excluded = self.request("GET", "/v1/time/segments?from=2026-07-27T10:00&to=2026-07-27T11:00")[1]
        self.assertEqual((included["total"], excluded["total"]), (1, 0))

    def test_date_form_range_is_closed_and_matches_summary_semantics(self) -> None:
        """日期型 from/to 是闭区间，且必须与 summary/range 同义。

        此前 to 取当天**起点**，整个 to 日被排除：`--from X --to X` 查单日恒为空数组。
        而 Skill 参考文档原样给出的正是这种命令——Agent 会把有记录的那天报成没有记录，
        「空白可追溯」在这里反过来凭空造出空白，正是 P9 诊断 7-31 时走的那条路。
        同一天问 summary/range 却一直返回完整覆盖，两个端点对「这一天」给出相反的答案。
        """
        self.request("POST", "/v1/time/segments", {
            "title": "当天记录", "categoryName": "开发",
            "startedAt": "2026-07-27T09:00", "endedAt": "2026-07-27T10:00",
        })
        self.request("POST", "/v1/time/segments", {
            "title": "次日记录", "categoryName": "开发",
            "startedAt": "2026-07-28T09:00", "endedAt": "2026-07-28T10:00",
        })

        # 查单日必须查得到自己
        status, single = self.request("GET", "/v1/time/segments?from=2026-07-27&to=2026-07-27")
        self.assertEqual(status, 200)
        self.assertEqual([item["title"] for item in single["segments"]], ["当天记录"])

        # 闭区间：两端都含
        _, span = self.request("GET", "/v1/time/segments?from=2026-07-27&to=2026-07-28")
        self.assertEqual([item["title"] for item in span["segments"]], ["当天记录", "次日记录"])

        # 与 summary/range 同义：同一区间，两个端点都认为这一天有记录
        _, digest = self.request("GET", "/v1/time/summary/range?from=2026-07-27&to=2026-07-27")
        self.assertEqual(digest["recordedMinutes"], 60)

        # 分钟形式仍是排他瞬间——面板的 `to=次日T00:00` 依赖它，不能被这次改动带偏
        _, minute = self.request("GET", "/v1/time/segments?from=2026-07-27T00:00&to=2026-07-28T00:00")
        self.assertEqual([item["title"] for item in minute["segments"]], ["当天记录"])

    def test_reconcile_can_update_then_delete_in_one_transaction(self) -> None:
        _, created = self.request("POST", "/v1/time/segments", {
            "title": "待修正", "categoryName": "开发", "startedAt": "2026-07-27T09:00", "endedAt": "2026-07-27T10:00",
        })
        segment_id = created["segment"]["id"]
        status, result = self.request("POST", "/v1/time/segments/reconcile", {"operations": [
            {"action": "update", "id": segment_id, "payload": {"note": "先复核"}},
            {"action": "delete", "id": segment_id, "payload": {"reason": "再撤销"}},
        ]})
        self.assertEqual(status, 200)
        self.assertEqual([entry["action"] for entry in result["results"]], ["update", "delete"])
        self.assertEqual(self.request("GET", "/v1/time/segments")[1]["segments"], [])

        # 批量删除必须与单条 DELETE 端点留下同样的痕迹：软删除让记录从视野消失，
        # 是本域唯一的破坏性操作。此前批量路径既无审计事件也无检查点快照——
        # 而 P9 修复 2026-07-31 走的正是 reconcile，
        # 「先快照再动手」这个恢复手段恰恰在最常用的那条路径上不存在。
        status, events = self.request("GET", "/v1/time/audit/events")
        self.assertEqual(status, 200)
        deletions = [item for item in events if item["action"] == "delete" and item["entityId"] == segment_id]
        revisions = [item for item in events if item["entityId"] == segment_id]
        self.assertEqual(len(deletions), 1, events)
        self.assertEqual({item["action"] for item in revisions}, {"create", "update", "delete"})
        self.assertEqual(deletions[0]["payload"]["before"]["title"], "待修正")
        self.assertTrue(deletions[0]["payload"]["after"]["deletedAt"])
        self.assertTrue(deletions[0]["impact"]["viaReconcile"])

        snapshots = sorted((self.runtime / "time/audit/snapshots").glob("*.sqlite3"))
        # 新建有一份快照；reconcile 是一个事务，更新+删除共享最后一份快照。
        self.assertEqual(len(snapshots), 2)
        self.assertIn(deletions[0]["id"], {path.stem for path in snapshots})


class TimeHttpCompatibilityTests(TimeHttpFixture):
    """逐项承接 TimeOS HTTP 金样中仍属于 LifeOS 时间 API 的契约。"""

    def test_auto_close_rejects_deduction_on_the_new_open_segment(self) -> None:
        now = datetime.now(timezone.utc).replace(second=0, microsecond=0)
        self.assertEqual(self.request("POST", "/v1/time/segments", {"title": "前序", "categoryName": "开发", "startedAt": (now - timedelta(minutes=10)).strftime("%Y-%m-%dT%H:%M")})[0], 201)
        status, payload = self.request("POST", "/v1/time/segments", {"title": "新开", "categoryName": "写作", "startedAt": (now - timedelta(minutes=5)).strftime("%Y-%m-%dT%H:%M"), "deductionMinutes": 1})
        self.assertEqual((status, payload["error"]), (422, "deduction_out_of_range"))

    def test_current_minute_open_is_visible_and_stops_at_minimum_duration(self) -> None:
        now = datetime.now(timezone.utc).replace(second=0, microsecond=0)
        status, opened = self.request("POST", "/v1/time/segments", {"title": "刚开始", "categoryName": "开发", "startedAt": now.strftime("%Y-%m-%dT%H:%M")})
        self.assertEqual(status, 201)
        gaps = self.request("GET", f"/v1/time/gaps?date={now.date().isoformat()}")[1]
        self.assertEqual(gaps["openSegment"]["id"], opened["segment"]["id"])
        status, stopped = self.request("POST", f"/v1/time/segments/{opened['segment']['id']}/stop")
        self.assertEqual((status, stopped["segment"]["endedAt"]), (200, (now + timedelta(minutes=1)).strftime("%Y-%m-%dT%H:%M")))

    def test_exact_minute_close_works_for_create_stop_and_update(self) -> None:
        now = datetime.now(timezone.utc).replace(second=0, microsecond=0)
        first_start, first_end = now - timedelta(minutes=60), now - timedelta(minutes=50)
        status, created = self.request("POST", "/v1/time/segments", {"title": "创建闭合", "categoryName": "开发", "startedAt": first_start.strftime("%Y-%m-%dT%H:%M"), "endedAt": first_end.strftime("%Y-%m-%dT%H:%M")})
        self.assertEqual((status, created["segment"]["endedAt"]), (201, first_end.strftime("%Y-%m-%dT%H:%M")))
        status, opened = self.request("POST", "/v1/time/segments", {"title": "stop 闭合", "categoryName": "写作", "startedAt": (now - timedelta(minutes=40)).strftime("%Y-%m-%dT%H:%M")})
        self.assertEqual(status, 201)
        self.assertEqual(self.request("POST", f"/v1/time/segments/{opened['segment']['id']}/stop", {"endedAt": (now - timedelta(minutes=30)).strftime("%Y-%m-%dT%H:%M")})[0], 200)
        status, updated_open = self.request("POST", "/v1/time/segments", {"title": "update 闭合", "categoryName": "开发", "startedAt": (now - timedelta(minutes=20)).strftime("%Y-%m-%dT%H:%M")})
        self.assertEqual(status, 201)
        final_end = (now - timedelta(minutes=10)).strftime("%Y-%m-%dT%H:%M")
        status, updated = self.request("PUT", f"/v1/time/segments/{updated_open['segment']['id']}", {"endedAt": final_end})
        self.assertEqual((status, updated["segment"]["endedAt"]), (200, final_end))

    def test_reconcile_builds_explicit_sleep_phone_and_support_timeline(self) -> None:
        status, payload = self.request("POST", "/v1/time/segments/reconcile", {"operations": [
            {"action": "create", "payload": {"title": "睡眠", "categoryName": "睡眠", "startedAt": "2026-07-27T00:00", "endedAt": "2026-07-27T08:00"}},
            {"action": "create", "payload": {"title": "刷手机", "categoryName": "刷手机", "startedAt": "2026-07-27T08:00", "endedAt": "2026-07-27T08:30"}},
            {"action": "create", "payload": {"title": "同步", "categoryName": "会议沟通", "startedAt": "2026-07-27T08:30", "endedAt": "2026-07-27T09:00"}},
        ]})
        self.assertEqual(status, 200)
        self.assertEqual([entry["segment"]["startedAt"] for entry in payload["results"]], ["2026-07-27T00:00", "2026-07-27T08:00", "2026-07-27T08:30"])
        self.assertEqual(self.request("GET", "/v1/time/segments")[1]["total"], 3)

    def test_delete_without_revert_keeps_auto_closed_predecessor_closed(self) -> None:
        now = datetime.now(timezone.utc).replace(second=0, microsecond=0)
        _, first = self.request("POST", "/v1/time/segments", {"title": "原活动", "categoryName": "开发", "startedAt": (now - timedelta(minutes=10)).strftime("%Y-%m-%dT%H:%M")})
        _, second = self.request("POST", "/v1/time/segments", {"title": "后活动", "categoryName": "写作", "startedAt": (now - timedelta(minutes=5)).strftime("%Y-%m-%dT%H:%M")})
        status, deleted = self.request("DELETE", f"/v1/time/segments/{second['segment']['id']}", {"reason": "仅删除"})
        self.assertEqual((status, deleted["restoredPrevious"]), (200, None))
        predecessor = self.request("GET", "/v1/time/segments")[1]["segments"][0]
        self.assertEqual(predecessor["id"], first["segment"]["id"])
        self.assertIsNotNone(predecessor["endedAt"])

    def test_auto_close_refuses_to_invert_the_active_segment(self) -> None:
        now = datetime.now(timezone.utc).replace(second=0, microsecond=0)
        self.assertEqual(self.request("POST", "/v1/time/segments", {"title": "当前", "categoryName": "开发", "startedAt": (now - timedelta(minutes=5)).strftime("%Y-%m-%dT%H:%M")})[0], 201)
        status, payload = self.request("POST", "/v1/time/segments", {"title": "倒退", "categoryName": "写作", "startedAt": (now - timedelta(minutes=6)).strftime("%Y-%m-%dT%H:%M")})
        self.assertEqual((status, payload["error"]), (422, "auto_close_would_invert"))

    def test_long_open_segment_returns_an_actionable_stop_error(self) -> None:
        status, opened = self.request("POST", "/v1/time/segments", {"title": "过长", "categoryName": "开发", "startedAt": "2020-01-01T00:00"})
        self.assertEqual(status, 201)
        status, payload = self.request("POST", f"/v1/time/segments/{opened['segment']['id']}/stop")
        self.assertEqual((status, payload["error"]), (422, "open_segment_too_long"))
        self.assertIn("suggestedEndedAt", payload)

    def test_delete_requires_a_boolean_revert_auto_close_flag(self) -> None:
        _, created = self.request("POST", "/v1/time/segments", {"title": "类型", "categoryName": "开发", "startedAt": "2026-07-27T09:00", "endedAt": "2026-07-27T10:00"})
        status, payload = self.request("DELETE", f"/v1/time/segments/{created['segment']['id']}", {"reason": "测试", "revertAutoClose": "true"})
        self.assertEqual((status, payload["error"]), (400, "invalid_request"))

    def test_segment_timestamp_and_range_inputs_are_strict(self) -> None:
        for body in (
            {"title": "格式", "categoryName": "开发", "startedAt": "2026-7-27"},
            {"title": "逆序", "categoryName": "开发", "startedAt": "2026-07-27T10:00", "endedAt": "2026-07-27T09:00"},
        ):
            with self.subTest(body=body):
                status, payload = self.request("POST", "/v1/time/segments", body)
                self.assertEqual(status, 422)
                self.assertIn(payload["error"], {"invalid_range", "future_timestamp"})

    def test_all_declared_segment_sources_are_accepted(self) -> None:
        for index, source in enumerate(("agent", "manual", "import")):
            status, payload = self.request("POST", "/v1/time/segments", {"title": source, "categoryName": "开发", "startedAt": f"2026-07-27T{9 + index:02d}:00", "endedAt": f"2026-07-27T{10 + index:02d}:00", "source": source})
            self.assertEqual((status, payload["segment"]["source"]), (201, source))

    def test_master_and_reconcile_unknown_fields_are_pure_rejections(self) -> None:
        before = self.request("GET", "/v1/time/configuration")[1]
        status, payload = self.request("POST", "/v1/time/agent/operations", {"userConfirmation": "创建", "entity": "project", "action": "create", "payload": {"name": "不会创建", "status": "active"}, "unexpected": True})
        self.assertEqual((status, payload["error"]), (400, "invalid_request"))
        status, payload = self.request("POST", "/v1/time/segments/reconcile", {"operations": [], "unexpected": True})
        self.assertEqual((status, payload["error"]), (400, "invalid_request"))
        self.assertEqual(self.request("GET", "/v1/time/configuration")[1]["projects"], before["projects"])

    def test_master_duplicate_name_is_rejected_without_second_row(self) -> None:
        body = {"userConfirmation": "创建项目", "entity": "project", "action": "create", "payload": {"name": "唯一项目", "status": "active"}}
        self.assertEqual(self.request("POST", "/v1/time/agent/operations", body)[0], 200)
        status, payload = self.request("POST", "/v1/time/agent/operations", body)
        self.assertEqual((status, payload["error"]), (409, "invalid_request"))
        self.assertEqual(len(self.request("GET", "/v1/time/configuration")[1]["projects"]), 1)

    def test_protected_uncategorized_category_cannot_be_renamed(self) -> None:
        body = {"userConfirmation": "请改分类", "entity": "category", "action": "update", "name": "未归类", "payload": {"name": "已归类"}}
        status, payload = self.request("POST", "/v1/time/agent/operations", body)
        self.assertEqual((status, payload["error"]), (422, "immutable_field"))

    def test_summary_counts_support_but_not_recovery_as_work(self) -> None:
        for title, category, started_at, ended_at in (("睡眠", "睡眠", "2026-07-27T00:00", "2026-07-27T01:00"), ("同步", "会议沟通", "2026-07-27T01:00", "2026-07-27T02:00"), ("开发", "开发", "2026-07-27T02:00", "2026-07-27T03:00")):
            self.assertEqual(self.request("POST", "/v1/time/segments", {"title": title, "categoryName": category, "startedAt": started_at, "endedAt": ended_at})[0], 201)
        summary = self.request("GET", "/v1/time/summary/range?from=2026-07-27&to=2026-07-27")[1]
        self.assertEqual((summary["effectiveWorkMinutes"], summary["grossWorkMinutes"]), (60, 120))

    def test_summary_rejects_an_excessive_window(self) -> None:
        status, payload = self.request("GET", "/v1/time/summary/range?from=2000-01-01&to=2020-01-01")
        self.assertEqual((status, payload["error"]), (422, "too_long"))

    def test_habits_requires_a_nonempty_query(self) -> None:
        status, payload = self.request("GET", "/v1/time/habits?q=")
        self.assertEqual((status, payload["error"]), (422, "missing_query"))

    def test_invalid_timezone_is_rejected_before_any_history_mutation(self) -> None:
        self.assertEqual(self.request("POST", "/v1/time/segments", {"title": "原记录", "categoryName": "开发", "startedAt": "2026-07-27T09:00", "endedAt": "2026-07-27T10:00"})[0], 201)
        status, payload = self.request("PUT", "/v1/time/configuration", {"timezone": "Mars/Olympus", "historyMode": "convert"})
        self.assertEqual((status, payload["error"]), (400, "invalid_timezone"))
        self.assertEqual(self.request("GET", "/v1/time/segments")[1]["segments"][0]["startedAt"], "2026-07-27T09:00")

    def test_timezone_convert_includes_soft_deleted_history(self) -> None:
        _, created = self.request("POST", "/v1/time/segments", {"title": "删除历史", "categoryName": "开发", "startedAt": "2026-07-27T09:00", "endedAt": "2026-07-27T10:00"})
        self.assertEqual(self.request("DELETE", f"/v1/time/segments/{created['segment']['id']}", {"reason": "演练"})[0], 200)
        status, changed = self.request("PUT", "/v1/time/configuration", {"timezone": "Asia/Shanghai", "historyMode": "convert"})
        self.assertEqual((status, changed["convertedSegments"]), (200, 1))
        row = self.request("GET", "/v1/time/segments?includeDeleted=true")[1]["segments"][0]
        self.assertEqual(row["startedAt"], "2026-07-27T17:00")

    def test_audit_limit_zero_clamps_to_one(self) -> None:
        self.assertEqual(self.request("POST", "/v1/time/agent/operations", {"userConfirmation": "创建", "entity": "project", "action": "create", "payload": {"name": "限额", "status": "active"}})[0], 200)
        status, events = self.request("GET", "/v1/time/audit/events?limit=0")
        self.assertEqual((status, len(events)), (200, 1))

    def test_segment_delete_leaves_auditable_before_after_evidence(self) -> None:
        _, created = self.request("POST", "/v1/time/segments", {
            "title": "可审计撤销", "categoryName": "开发", "startedAt": "2026-07-27T09:00", "endedAt": "2026-07-27T10:00",
        })
        segment_id = created["segment"]["id"]
        status, deleted = self.request("DELETE", f"/v1/time/segments/{segment_id}", {"reason": "测试撤销"})
        self.assertEqual((status, deleted["operation"]["action"]), (200, "delete"))
        status, events = self.request("GET", "/v1/time/audit/events")
        self.assertEqual((status, events[0]["entityId"], events[0]["payload"]["before"]["id"], events[0]["payload"]["after"]["deletedAt"] is not None), (200, segment_id, segment_id, True))

    def test_stopping_a_deleted_segment_is_not_found(self) -> None:
        _, created = self.request("POST", "/v1/time/segments", {"title": "删除后停", "categoryName": "开发", "startedAt": "2026-07-27T09:00", "endedAt": "2026-07-27T10:00"})
        self.assertEqual(self.request("DELETE", f"/v1/time/segments/{created['segment']['id']}", {"reason": "删除"})[0], 200)
        status, payload = self.request("POST", f"/v1/time/segments/{created['segment']['id']}/stop")
        self.assertEqual((status, payload["error"]), (404, "not_found"))

    def test_include_deleted_accepts_yes_alias(self) -> None:
        _, created = self.request("POST", "/v1/time/segments", {"title": "已删", "categoryName": "开发", "startedAt": "2026-07-27T09:00", "endedAt": "2026-07-27T10:00"})
        self.assertEqual(self.request("DELETE", f"/v1/time/segments/{created['segment']['id']}", {"reason": "删除"})[0], 200)
        payload = self.request("GET", "/v1/time/segments?includeDeleted=yes")[1]
        self.assertEqual((payload["total"], payload["segments"][0]["id"]), (1, created["segment"]["id"]))

    def test_retired_interop_http_path_is_not_revived(self) -> None:
        status, payload = self.request("GET", "/v1/interop/projects")
        self.assertEqual((status, payload["error"]), (404, "not_found"))

    def test_other_unprefixed_time_paths_are_not_compatibility_aliases(self) -> None:
        for path in ("/v1/configuration", "/v1/gaps?date=2026-07-27", "/v1/habits?q=%E5%BC%80%E5%8F%91", "/v1/audit/events"):
            with self.subTest(path=path):
                status, payload = self.request("GET", path)
                self.assertEqual((status, payload["error"]), (404, "not_found"))

    def test_project_master_data_can_be_bound_to_a_new_segment(self) -> None:
        self.assertEqual(self.request("POST", "/v1/time/agent/operations", {"userConfirmation": "创建项目", "entity": "project", "action": "create", "payload": {"name": "LifeOS", "status": "active"}})[0], 200)
        status, created = self.request("POST", "/v1/time/segments", {"title": "项目工作", "categoryName": "开发", "projectName": "LifeOS", "startedAt": "2026-07-27T09:00", "endedAt": "2026-07-27T10:00"})
        self.assertEqual((status, created["segment"]["projectName"]), (201, "LifeOS"))

    def test_closing_a_segment_cannot_be_reopened_by_update(self) -> None:
        _, created = self.request("POST", "/v1/time/segments", {"title": "已结束", "categoryName": "开发", "startedAt": "2026-07-27T09:00", "endedAt": "2026-07-27T10:00"})
        status, payload = self.request("PUT", f"/v1/time/segments/{created['segment']['id']}", {"endedAt": None})
        self.assertEqual((status, payload["error"]), (422, "immutable_field"))


class TimeCtlFixture(unittest.TestCase):
    """以真实随机端口验证 timeclock→lifeconn→timectl→timeview 的完整链路。"""

    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        root = Path(self.temporary.name)
        self.install_root = root / "install"
        self.runtime = self.install_root / "server" / "runtime"
        self.port, self.token = reserve_port(), "time-ctl-test-token"
        write_config(self.runtime / "config.json", {"host": "127.0.0.1", "port": self.port, "accessToken": self.token, "allowedHosts": [], "timezone": "UTC", "timezoneSource": "config"})
        self.server = create_server(create_application(self.runtime))
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.environment = patch.dict(os.environ, {"HOME": str(root / "home"), "LIFEOS_INSTALL_PATH": str(self.install_root)}, clear=False)
        self.environment.start()
        self.today = datetime.now(timezone.utc).date().isoformat()

    def tearDown(self) -> None:
        self.environment.stop()
        self.server.shutdown(); self.server.server_close(); self.thread.join(timeout=5)
        self.temporary.cleanup()

    @staticmethod
    def minute(value: datetime) -> str:
        return value.strftime("%Y-%m-%dT%H:%M")

    def request(self, method: str, path: str, body: dict | None = None) -> tuple[int, dict]:
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        raw = json.dumps(body).encode("utf-8") if body is not None else None
        headers = {"Authorization": f"Bearer {self.token}", "Host": f"127.0.0.1:{self.port}"}
        if raw is not None: headers["Content-Type"] = "application/json"
        connection.request(method, path, body=raw, headers=headers)
        response = connection.getresponse()
        payload = json.loads(response.read().decode("utf-8"))
        connection.close()
        return response.status, payload

    def run_ctl(self, *arguments: str) -> tuple[int, dict]:
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            status = timectl.main(list(arguments))
        raw = output.getvalue()
        decoder = json.JSONDecoder()
        for index in range(len(raw) - 1, -1, -1):
            if raw[index] != "{":
                continue
            try:
                payload, end = decoder.raw_decode(raw[index:])
            except json.JSONDecodeError:
                continue
            if raw[index + end:].strip() == "":
                return status, payload
        self.fail(f"timectl 未输出 JSON 回执：{raw!r}")


class TimeCtlIntegrationTests(TimeCtlFixture):
    def test_clock_uses_the_health_resolved_timezone(self) -> None:
        status, payload = self.run_ctl("clock", "--expect-timezone", "UTC")
        self.assertEqual((status, payload["resolvedTimezone"]), (0, "UTC"))
        self.assertEqual(payload["currentLocalDate"], self.today)

    def test_record_rejects_a_declared_business_date_mismatch(self) -> None:
        status, payload = self.run_ctl("record", "--title", "拒绝", "--category", "开发", "--now", "--today", "2000-01-01")
        self.assertEqual(status, 2)
        self.assertIn("业务日期不符", payload["message"])
        self.assertEqual(self.request("GET", "/v1/time/segments")[1]["total"], 0)

    def test_record_writes_agent_source_and_formal_display_without_token(self) -> None:
        now = datetime.now(timezone.utc).replace(second=0, microsecond=0)
        status, payload = self.run_ctl("record", "--title", "阅读", "--category", "学习研究", "--start", self.minute(now - timedelta(minutes=20)), "--end", self.minute(now - timedelta(minutes=10)), "--today", self.today)
        self.assertEqual(status, 0, payload)
        self.assertEqual(payload["segment"]["source"], "agent")
        self.assertTrue(payload["display"][0].startswith("✓"))
        self.assertNotIn(self.token, json.dumps(payload, ensure_ascii=False))

    def test_switch_over_a_gap_actually_draws_the_unrecorded_line(self) -> None:
        """空白提示通道必须真的通：从命令一路到 ⚠ 行，端到端。

        此前 switch 只回一个 acknowledgedGapMinutes 整数，而 timeview 读的是
        precedingRecord 对象——生产者与消费者从未接上，⚠ 未记录 行从上线起就画不出来，
        而 time-recording.md 还在要求 Agent「原样转达 ⚠ 行、不要自己复述空白」。
        于是空白提示两头皆空：2026-07-31 那 19 小时的记录中断，没有任何一层喊过一声。
        只有从 CLI 真跑一遍才能证明这条链路通；断言纯函数能渲染是不够的，
        它上一次就是那样「通过」的。
        """
        now = datetime.now(timezone.utc).replace(second=0, microsecond=0)
        # 先留下一条已封口的记录，再隔着 40 分钟空白开新段
        status, _ = self.run_ctl(
            "record", "--title", "复盘", "--category", "学习研究",
            "--start", self.minute(now - timedelta(minutes=90)),
            "--end", self.minute(now - timedelta(minutes=60)), "--today", self.today,
        )
        self.assertEqual(status, 0)

        status, payload = self.run_ctl(
            "switch", "--title", "开会", "--category", "会议沟通",
            "--at", self.minute(now - timedelta(minutes=20)),
            "--allow-gap", "--today", self.today,
        )
        self.assertEqual(status, 0, payload)

        # 回执必须带齐 timeview 的三个输入，缺一个 ⚠ 行就画不出来
        self.assertTrue(payload["openedWithoutPredecessor"])
        self.assertEqual(payload["precedingRecord"]["gapMinutes"], 40)
        self.assertEqual(payload["precedingRecord"]["previousEndedAt"], self.minute(now - timedelta(minutes=60)))

        # 成品文本里必须真的出现那一行——这才是用户与 Agent 看得到的东西
        display = payload["display"]
        self.assertTrue(any(line.startswith("⚠ 未记录") for line in display), display)
        self.assertTrue(any("40m" in line for line in display), display)

    def test_stop_resolves_a_short_clock_after_the_open_start(self) -> None:
        now = datetime.now(timezone.utc).replace(second=0, microsecond=0)
        _, opened = self.run_ctl("record", "--title", "整理", "--category", "开发", "--start", self.minute(now - timedelta(minutes=6)), "--today", self.today)
        status, stopped = self.run_ctl("stop", "--id", opened["segment"]["id"], "--at", (now - timedelta(minutes=2)).strftime("%H:%M"), "--today", self.today)
        self.assertEqual(status, 0)
        self.assertEqual(stopped["segment"]["endedAt"], self.minute(now - timedelta(minutes=2)))
        self.assertTrue(stopped["display"][-1].startswith("⏸"))

    def test_switch_closes_an_open_agent_segment_at_the_spoken_boundary(self) -> None:
        now = datetime.now(timezone.utc).replace(second=0, microsecond=0)
        _, first = self.run_ctl("record", "--title", "开发", "--category", "开发", "--start", self.minute(now - timedelta(minutes=9)), "--today", self.today)
        boundary = self.minute(now - timedelta(minutes=4))
        status, second = self.run_ctl("switch", "--title", "写作", "--category", "写作", "--at", boundary, "--today", self.today)
        self.assertEqual(status, 0)
        self.assertEqual((second["closedPrevious"]["id"], second["closedPrevious"]["endedAt"], second["segment"]["startedAt"]), (first["segment"]["id"], boundary, boundary))
        self.assertEqual(len(second["display"]), 2)

    def test_switch_atomically_aligns_a_small_agent_gap(self) -> None:
        now = datetime.now(timezone.utc).replace(second=0, microsecond=0)
        self.run_ctl("record", "--title", "刚结束", "--category", "开发", "--start", self.minute(now - timedelta(minutes=10)), "--end", self.minute(now - timedelta(minutes=8)), "--today", self.today)
        boundary = self.minute(now - timedelta(minutes=6))
        status, payload = self.run_ctl("switch", "--title", "接续", "--category", "写作", "--at", boundary, "--today", self.today)
        self.assertEqual(status, 0)
        self.assertEqual((payload["closedPrevious"]["endedAt"], payload["segment"]["startedAt"]), (boundary, boundary))

    def test_switch_refuses_a_large_unrecorded_gap_without_allowance(self) -> None:
        now = datetime.now(timezone.utc).replace(second=0, microsecond=0)
        self.run_ctl("record", "--title", "早前", "--category", "开发", "--start", self.minute(now - timedelta(minutes=25)), "--end", self.minute(now - timedelta(minutes=15)), "--today", self.today)
        status, payload = self.run_ctl("switch", "--title", "现在", "--category", "写作", "--at", self.minute(now - timedelta(minutes=2)), "--today", self.today)
        self.assertEqual(status, 2)
        self.assertIn("自动对齐上限", payload["message"])

    def test_switch_refuses_to_mutate_a_manual_predecessor(self) -> None:
        now = datetime.now(timezone.utc).replace(second=0, microsecond=0)
        self.assertEqual(self.request("POST", "/v1/time/segments", {"title": "人工", "categoryName": "开发", "startedAt": self.minute(now - timedelta(minutes=10)), "endedAt": self.minute(now - timedelta(minutes=8)), "source": "manual"})[0], 201)
        status, payload = self.run_ctl("switch", "--title", "接续", "--category", "写作", "--at", self.minute(now - timedelta(minutes=6)), "--today", self.today)
        self.assertEqual(status, 2)
        self.assertIn("不是 Agent", payload["message"])

    def test_cancel_restores_the_predecessor_truncated_by_a_recent_switch(self) -> None:
        now = datetime.now(timezone.utc).replace(second=0, microsecond=0)
        self.run_ctl("record", "--title", "原活动", "--category", "开发", "--start", self.minute(now - timedelta(minutes=9)), "--today", self.today)
        boundary = self.minute(now - timedelta(minutes=4))
        self.run_ctl("switch", "--title", "误开", "--category", "写作", "--at", boundary, "--today", self.today)
        status, payload = self.run_ctl("cancel", "--expect-start", boundary, "--today", self.today)
        self.assertEqual(status, 0)
        self.assertIsNone(payload["restoredPrevious"]["endedAt"])
        self.assertTrue(payload["display"][0].startswith("✗"))

    def test_cancel_rejects_a_mismatched_start_before_delete(self) -> None:
        now = datetime.now(timezone.utc).replace(second=0, microsecond=0)
        self.run_ctl("record", "--title", "当前", "--category", "开发", "--start", self.minute(now - timedelta(minutes=3)), "--today", self.today)
        status, payload = self.run_ctl("cancel", "--expect-start", self.minute(now - timedelta(minutes=2)), "--today", self.today)
        self.assertEqual(status, 2)
        self.assertIn("--expect-start", payload["message"])

    def test_update_rejects_a_short_historical_minute(self) -> None:
        status, payload = self.run_ctl("update", "--id", "unknown", "--start", "09:00", "--today", self.today)
        self.assertEqual(status, 2)
        self.assertIn("完整的 YYYY", payload["message"])

    def test_delete_soft_deletes_a_segment_without_today_guard(self) -> None:
        now = datetime.now(timezone.utc).replace(second=0, microsecond=0)
        _, created = self.run_ctl("record", "--title", "删除", "--category", "开发", "--start", self.minute(now - timedelta(minutes=12)), "--end", self.minute(now - timedelta(minutes=11)), "--today", self.today)
        status, payload = self.run_ctl("delete", "--id", created["segment"]["id"], "--reason", "演练")
        self.assertEqual(status, 0)
        self.assertTrue(payload["segment"]["deletedAt"])
        self.assertTrue(payload["display"][0].startswith("✗"))

    def test_reconcile_plan_forces_agent_source_and_returns_display(self) -> None:
        now = datetime.now(timezone.utc).replace(second=0, microsecond=0)
        plan = Path(self.temporary.name) / "plan.json"
        plan.write_text(json.dumps({"operations": [{"action": "create", "payload": {"title": "对账", "categoryName": "开发", "startedAt": self.minute(now - timedelta(minutes=15)), "endedAt": self.minute(now - timedelta(minutes=14)), "source": "manual"}}]}), encoding="utf-8")
        status, payload = self.run_ctl("reconcile", "--plan-file", str(plan), "--today", self.today)
        self.assertEqual(status, 0)
        self.assertEqual(payload["results"][0]["segment"]["source"], "agent")
        self.assertTrue(payload["display"][0].startswith("✓"))

    def test_request_refuses_finance_path_before_network(self) -> None:
        status, payload = self.run_ctl("request", "POST", "/v1/fin/transactions")
        self.assertEqual(status, 2)
        self.assertIn("/v1/time", payload["message"])

    def test_segments_command_includes_soft_deleted_rows_on_demand(self) -> None:
        now = datetime.now(timezone.utc).replace(second=0, microsecond=0)
        _, created = self.run_ctl("record", "--title", "已删", "--category", "开发", "--start", self.minute(now - timedelta(minutes=12)), "--end", self.minute(now - timedelta(minutes=11)), "--today", self.today)
        self.run_ctl("delete", "--id", created["segment"]["id"], "--reason", "演练")
        status, payload = self.run_ctl("segments", "--include-deleted")
        self.assertEqual(status, 0)
        self.assertEqual(payload["segments"][0]["id"], created["segment"]["id"])

    def test_lifeconn_rejects_a_cross_domain_read_before_sending_token(self) -> None:
        with self.assertRaises(lifeconn.LifeOSTransportError):
            lifeconn.request_api("GET", "/v1/fin/transactions", domain="time")


if __name__ == "__main__":
    unittest.main()
