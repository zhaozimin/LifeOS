#!/usr/bin/env python3
"""
[INPUT]: 依赖同目录 timeclock.py 与 timeview.py；只构造内存回执，不读取安装指针、不发网络、不触及任何 runtime。
[OUTPUT]: 提供时间 Skill 纯函数金样，锁定钟点解析、写入护栏、五态回执与渲染降级纪律。
[POS]: skills/lifeos/scripts 的隔离回归入口；与 HTTP/CLI 联调互补，证明时间裁定和 display 可独立于真实账本复跑。
[PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
"""

from __future__ import annotations

import sys
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest import mock

SCRIPTS_DIR = Path(__file__).resolve().parent
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

import timeclock  # noqa: E402
import timeview  # noqa: E402


class TimeClockTests(unittest.TestCase):
    CLOCK = {
        "timezone": "Asia/Shanghai",
        "currentLocalMinute": "2026-08-01T10:00",
        "currentLocalDate": "2026-08-01",
    }

    def test_full_minute_validation_and_alias(self) -> None:
        self.assertEqual(timeclock.require_full_minute("2026-08-01T09:00", "start"), "2026-08-01T09:00")
        self.assertIs(timeclock.TimeOSError, timeclock.LifeOSTimeError)
        with self.assertRaises(timeclock.LifeOSTimeError):
            timeclock.require_full_minute("09:00", "start")
        with self.assertRaises(timeclock.LifeOSTimeError):
            timeclock.parse_full_minute("2026-02-30T09:00", "start")

    def test_resolve_full_short_days_ago_and_skew(self) -> None:
        self.assertEqual(
            timeclock.resolve_minute("2026-07-30T09:00", self.CLOCK)[0],
            "2026-07-30T09:00",
        )
        self.assertEqual(timeclock.resolve_minute("09:00", self.CLOCK)[0], "2026-08-01T09:00")
        self.assertEqual(timeclock.resolve_minute("11:00", self.CLOCK)[0], "2026-07-31T11:00")
        resolved, trace = timeclock.resolve_minute("11:00", self.CLOCK, days_ago=1)
        self.assertEqual(resolved, "2026-07-31T11:00")
        self.assertIn("自然日由 --days-ago 显式指定", trace)
        resolved, trace = timeclock.resolve_minute("10:07", self.CLOCK)
        self.assertEqual(resolved, "2026-08-01T10:00")
        self.assertIn("快 7 分钟", trace)

    def test_resolve_end_cross_midnight_and_refuses_ambiguity(self) -> None:
        resolved, trace = timeclock.resolve_minute("00:10", self.CLOCK, after="2026-08-01T23:50", field="--end")
        self.assertEqual(resolved, "2026-08-02T00:10")
        self.assertIn("跨零点", trace)
        with self.assertRaises(timeclock.LifeOSTimeError):
            timeclock.resolve_minute("09:00", self.CLOCK, after="2026-08-01T09:00")
        with self.assertRaises(timeclock.LifeOSTimeError):
            timeclock.resolve_minute("08:00", self.CLOCK, after="2026-08-01T08:01")
        with self.assertRaises(timeclock.LifeOSTimeError):
            timeclock.resolve_minute("09:00", self.CLOCK, days_ago=401)

    def test_business_date_and_seam_contract(self) -> None:
        timeclock.assert_business_date("2026-08-01", self.CLOCK)
        with self.assertRaises(timeclock.LifeOSTimeError):
            timeclock.assert_business_date("2026-07-31", self.CLOCK)
        no_previous = timeclock.assert_seamless({"segment": {"startedAt": "2026-08-01T10:00"}}, "2026-08-01T10:00")
        self.assertTrue(no_previous["openedWithoutPredecessor"])
        seamless = timeclock.assert_seamless(
            {
                "segment": {"startedAt": "2026-08-01T10:00"},
                "closedPrevious": {"endedAt": "2026-08-01T10:00"},
            },
            "2026-08-01T10:00",
        )
        self.assertTrue(seamless["seamless"])
        with self.assertRaises(timeclock.LifeOSTimeError):
            timeclock.assert_seamless(
                {
                    "segment": {"startedAt": "2026-08-01T10:00"},
                    "closedPrevious": {"endedAt": "2026-08-01T09:59"},
                },
                "2026-08-01T10:00",
            )

    def test_audit_age_is_utc_and_fail_closed(self) -> None:
        self.assertEqual(
            timeclock.open_segment_age_minutes(
                {"createdAt": "2026-08-01T10:00:00Z"},
                reference=datetime(2026, 8, 1, 10, 16, tzinfo=timezone.utc),
            ),
            16,
        )
        with self.assertRaises(timeclock.LifeOSTimeError):
            timeclock.open_segment_age_minutes({}, datetime.now(timezone.utc))
        self.assertEqual(timeclock.parse_audit_time("2026-08-01T10:00:00", "createdAt").tzinfo, timezone.utc)


class TimeViewTests(unittest.TestCase):
    CLOSED = {
        "title": "深度工作",
        "startedAt": "2026-08-01T09:00",
        "endedAt": "2026-08-01T10:05",
        "grossMinutes": 65,
        "pureMinutes": 60,
    }
    OPEN = {"title": "整理笔记", "startedAt": "2026-08-01T10:05", "endedAt": None}

    def test_switch_uses_previous_and_current_two_lines(self) -> None:
        lines = timeview.render("switch", {"closedPrevious": self.CLOSED, "segment": self.OPEN})
        self.assertEqual(
            lines,
            ["✓ 深度工作 · 09:00–10:05 · 1h05m（纯 1h00m）", "▶ 整理笔记 · 10:05 起"],
        )
        self.assertNotIn("¥", "\n".join(lines or []))

    def test_gap_and_record_halted_are_visible(self) -> None:
        gap = timeview.render(
            "switch",
            {
                "boundary": "2026-08-01T10:05",
                "precedingRecord": {"previousEndedAt": "2026-08-01T09:00", "gapMinutes": 65},
                "segment": self.OPEN,
            },
        )
        self.assertEqual(gap and gap[0], "⚠ 未记录 · 09:00–10:05 · 1h05m ← 这段在做什么？")
        record = timeview.render("record", {"segment": self.CLOSED, "currentOpenStatus": "none"})
        self.assertEqual(record, ["✓ 深度工作 · 09:00–10:05 · 1h05m（纯 1h00m）", "⏸ 当前没有进行中活动"])

    def test_cancel_update_delete_and_reconcile_state_rules(self) -> None:
        cancelled = timeview.render("cancel", {"cancelled": self.OPEN, "restoredPrevious": self.OPEN})
        self.assertEqual(cancelled, ["✗ 已撤销 整理笔记 · 10:05 那条", "▶ 整理笔记 · 10:05 起（已恢复为进行中）"])
        updated = timeview.render("update", {"segment": self.CLOSED})
        self.assertEqual(updated, ["✓ 深度工作 · 09:00–10:05 · 1h05m（纯 1h00m）（已修改）"])
        deleted = timeview.render("delete", {"segment": self.CLOSED})
        self.assertEqual(deleted, ["✗ 已删 深度工作 · 09:00–10:05"])
        reconcile = timeview.render(
            "reconcile",
            {"results": [{"action": "delete", "segment": self.CLOSED}, {"action": "create", "segment": self.OPEN}]},
        )
        self.assertEqual(reconcile, ["✗ 已删 深度工作 · 09:00–10:05", "▶ 整理笔记 · 10:05 起"])

    def test_attach_degrades_without_reversing_a_committed_write(self) -> None:
        receipt = {"segment": self.OPEN.copy()}
        self.assertIs(timeview.attach_display, timeview.attach)
        with mock.patch.object(timeview, "render", side_effect=RuntimeError("render failed")):
            self.assertIs(timeview.attach("switch", receipt), receipt)
        self.assertNotIn("display", receipt)
        self.assertIsNone(timeview.render("unknown", receipt))
        self.assertIsNone(timeview.render("switch", {"segment": {"startedAt": 1}}))

    def test_legacy_single_argument_preserves_previous_skill_abi(self) -> None:
        self.assertEqual(timeview.render({"segment": self.CLOSED}), "✓ 09:00–10:05 深度工作")
        self.assertEqual(timeview.render({"segment": self.OPEN}), "▶ 10:05 起 整理笔记")


if __name__ == "__main__":
    unittest.main(verbosity=2)
