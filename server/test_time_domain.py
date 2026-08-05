"""
[INPUT]: 依赖 time 域的时钟、规则、超长阈值常量、SQLite 迁移计划与隔离 Ledger。
[OUTPUT]: 锁定 TimeOS 的跨天、DST、I1–I4、超长软标记、UTC 补写、时区历史迁移、启动拒绝与逐次写入版本/快照金样，
          以及只读窗口的两条边界：午夜跳变日的日界口径统一、贴着 datetime 两端的不可投影日期一律 4xx。
[POS]: P1 的纯领域回归；不启动生产服务、不读取任何生产 runtime。
[PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
"""

from __future__ import annotations

import sqlite3
import tempfile
import unittest
from contextlib import contextmanager
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Iterator
from unittest.mock import patch
from zoneinfo import ZoneInfo

from core.errors import DomainError
from core.sqlite import Ledger
from core.audit import checkpoint_database
from domains.time.clock import (
    configure_record_timezone, format_utc_minute, local_day_bounds_utc, local_minute_boundary_utc,
    local_minute_to_utc, parse_minute, record_timezone,
)
from domains.time.interop import projects_summary
from domains.time.migration import plan_timezone_conversion, plan_timezone_preservation
from domains.time.constants import OVERLONG_SEGMENT_MINUTES
from domains.time.rules import compute_day_coverage, is_overlong_segment, split_segment_by_day, summarize_range, validate_candidate
from domains.time.service import (
    agent_operation, configuration, create_segment, delete_segment, ensure_schema, gaps, habits,
    list_segments, summary,
)


def segment(
    segment_id: str, title: str, nature: str, started_at: str, ended_at: str | None,
    deduction: int = 0, category: str = "开发", project: str | None = None,
) -> dict[str, object]:
    return {
        "id": segment_id, "title": title, "category": {"name": category, "nature": nature},
        "projectName": project, "startedAt": started_at, "endedAt": ended_at,
        "deductionMinutes": deduction, "source": "agent", "deletedAt": None,
    }


class TimeDomainGoldenTests(unittest.TestCase):
    def tearDown(self) -> None:
        configure_record_timezone("UTC")

    def test_cross_day_split_and_rounding_preserve_minutes(self) -> None:
        configure_record_timezone("UTC")
        item = segment("rounding", "跨天舍入", "core", "2026-07-27T23:10", "2026-07-28T00:50", 3)
        pieces = split_segment_by_day(item, datetime(2026, 7, 29, 12, 0, tzinfo=timezone.utc))
        self.assertEqual([(piece["date"], piece["grossMinutes"]) for piece in pieces], [("2026-07-27", 50), ("2026-07-28", 50)])
        self.assertEqual([piece["deductionMinutes"] for piece in pieces], [2, 1])
        self.assertEqual(sum(int(piece["pureMinutes"]) for piece in pieces), 97)

    def test_summary_and_gap_canonical_numbers(self) -> None:
        configure_record_timezone("UTC")
        items = [
            segment("dev", "开发", "core", "2026-07-27T09:00", "2026-07-27T12:00", 20),
            segment("meeting", "会议", "support", "2026-07-27T14:00", "2026-07-27T15:00", category="会议沟通"),
            segment("cross", "开发", "core", "2026-07-27T23:00", "2026-07-28T01:30"),
        ]
        now = datetime(2026, 7, 30, 12, 0, tzinfo=timezone.utc)
        summary = summarize_range(items, "2026-07-27", "2026-07-28", now)
        coverage = compute_day_coverage(items, "2026-07-27", now)
        self.assertEqual((summary["effectiveWorkMinutes"], summary["grossWorkMinutes"]), (310, 390))
        self.assertEqual([gap["minutes"] for gap in coverage["gaps"]], [540, 120, 480])
        self.assertEqual(coverage["recordedMinutes"] + coverage["gapMinutes"], 1440)

    def test_dst_days_use_absolute_duration_and_refuse_ambiguous_writes(self) -> None:
        configure_record_timezone("America/Los_Angeles")
        zone = ZoneInfo("America/Los_Angeles")
        fall = segment("fall", "重复小时", "core", "2025-11-02T00:30", "2025-11-02T02:30")
        fall.update({"startedUtc": "2025-11-02T07:30:00+00:00", "endedUtc": "2025-11-02T10:30:00+00:00"})
        spring = segment("spring", "缺失小时", "core", "2025-03-09T01:30", "2025-03-09T03:30")
        spring.update({"startedUtc": "2025-03-09T09:30:00+00:00", "endedUtc": "2025-03-09T10:30:00+00:00"})
        self.assertEqual(compute_day_coverage([fall], "2025-11-02", datetime(2025, 11, 3, 12, tzinfo=zone))["denominatorMinutes"], 1500)
        self.assertEqual(compute_day_coverage([spring], "2025-03-09", datetime(2025, 3, 10, 12, tzinfo=zone))["denominatorMinutes"], 1380)
        with self.assertRaises(DomainError) as ambiguous:
            local_minute_to_utc("2025-11-02T01:15", "startedAt")
        self.assertEqual(ambiguous.exception.code, "invalid_local_minute")
        second_fold = datetime(2025, 11, 2, 1, 15, tzinfo=zone, fold=1)
        self.assertEqual(format_utc_minute(local_minute_to_utc("2025-11-02T01:15", "startedAt", reference_now=second_fold)), "2025-11-02T09:15:00+00:00")

    def test_system_timezone_is_frozen_for_process_lifetime(self) -> None:
        with patch.dict("os.environ", {"TZ": "America/Los_Angeles"}):
            configure_record_timezone("")
        with patch.dict("os.environ", {"TZ": "America/New_York"}):
            zone, resolved = record_timezone()
        self.assertEqual((getattr(zone, "key", None), resolved), ("America/Los_Angeles", "America/Los_Angeles"))

    def test_i1_to_i4_and_deductions_hold(self) -> None:
        configure_record_timezone("UTC")
        now = datetime(2026, 7, 27, 18, 0, tzinfo=timezone.utc)
        open_item = [segment("open", "开发", "core", "2026-07-27T09:00", None)]
        cases = (
            ("open_segment_exists", {"started_at": "2026-07-27T10:00", "ended_at": None, "deduction_minutes": 0, "existing": open_item}),
            ("overlap", {"started_at": "2026-07-27T08:00", "ended_at": "2026-07-27T10:00", "deduction_minutes": 0, "existing": open_item}),
            ("invalid_range", {"started_at": "2026-07-27T10:00", "ended_at": "2026-07-27T10:00", "deduction_minutes": 0, "existing": []}),
            ("future_timestamp", {"started_at": "2026-07-27T18:01", "ended_at": None, "deduction_minutes": 0, "existing": []}),
            ("deduction_out_of_range", {"started_at": "2026-07-27T17:00", "ended_at": "2026-07-27T18:00", "deduction_minutes": 61, "existing": []}),
        )
        for expected, kwargs in cases:
            with self.subTest(expected=expected), self.assertRaises(DomainError) as caught:
                validate_candidate(now=now, **kwargs)
            self.assertEqual(caught.exception.code, expected)
        validate_candidate("2026-07-27T11:00", "2026-07-27T12:00", 0, [segment("closed", "开发", "core", "2026-07-27T10:00", "2026-07-27T11:00")], now=now)

    def test_open_segment_is_clipped_to_requested_window(self) -> None:
        configure_record_timezone("UTC")
        now = datetime(2026, 7, 30, 12, 0, tzinfo=timezone.utc)
        item = segment("ancient", "多年未收尾", "core", "1900-01-01T00:00", None)
        item["startedUtc"] = "1900-01-01T00:00:00+00:00"
        summary = summarize_range([item], "2026-07-30", "2026-07-30", now)
        self.assertEqual((summary["recordedMinutes"], summary["effectiveWorkMinutes"]), (720, 720))


class TimeLedgerMigrationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        root = Path(self.temporary.name)
        self.ledger = Ledger("time", root / "runtime" / "time" / "time.sqlite3", root / "runtime" / "time" / "audit")
        self.config = {"host": "127.0.0.1", "port": 43210, "accessToken": "test-token", "allowedHosts": [], "timezone": "UTC", "timezoneSource": "config"}

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def test_legacy_utc_backfill_and_projection_are_safe(self) -> None:
        connection = self.ledger.connect()
        try:
            connection.executescript("""
                CREATE TABLE segments (id TEXT PRIMARY KEY,title TEXT NOT NULL,category_json TEXT,project_name TEXT,started_at TEXT NOT NULL,ended_at TEXT,deduction_minutes INTEGER NOT NULL DEFAULT 0,source TEXT NOT NULL DEFAULT 'agent',created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
            """)
            connection.execute("INSERT INTO segments VALUES (?,?,?,?,?,?,?,?,?,?)", ("legacy", "旧账本", '{\"name\":\"开发\",\"nature\":\"core\"}', None, "2025-07-01T09:00", "2025-07-01T10:00", 0, "agent", "2025-07-01T00:00:00+00:00", "2025-07-01T00:00:00+00:00"))
            connection.commit()
        finally:
            connection.close()
        ensure_schema(self.ledger, self.config)
        connection = self.ledger.connect()
        try:
            row = connection.execute("SELECT started_utc,ended_utc FROM segments WHERE id='legacy'").fetchone()
        finally:
            connection.close()
        self.assertEqual((row["started_utc"], row["ended_utc"]), ("2025-07-01T09:00:00+00:00", "2025-07-01T10:00:00+00:00"))

    def test_historical_timezone_convert_and_preserve_have_opposite_invariants(self) -> None:
        ensure_schema(self.ledger, self.config)
        connection = self.ledger.connect()
        try:
            connection.execute("INSERT INTO segments(id,title,category_json,started_at,ended_at,started_utc,ended_utc,deduction_minutes,tags_json,source,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)", ("fixed", "时区样例", '{\"name\":\"开发\",\"nature\":\"core\"}', "2025-07-01T09:00", "2025-07-01T10:00", "2025-07-01T09:00:00+00:00", "2025-07-01T10:00:00+00:00", 0, "[]", "import", "2025-07-01T00:00:00+00:00", "2025-07-01T00:00:00+00:00"))
            converted = plan_timezone_conversion(connection, "UTC", "Asia/Shanghai")
            preserved = plan_timezone_preservation(connection, "Asia/Shanghai")
        finally:
            connection.close()
        self.assertEqual(converted, [("fixed", "2025-07-01T17:00", "2025-07-01T18:00")])
        self.assertEqual(preserved, [("fixed", "2025-07-01T01:00:00+00:00", "2025-07-01T02:00:00+00:00")])


class TimeRulesContractTests(unittest.TestCase):
    """拆开 P1 高风险时间算术，避免综合金样掩盖边界退化。"""

    def tearDown(self) -> None:
        configure_record_timezone("UTC")

    def test_midnight_end_belongs_only_to_the_previous_day(self) -> None:
        configure_record_timezone("UTC")
        pieces = split_segment_by_day(
            segment("midnight", "午夜前工作", "core", "2026-07-27T23:00", "2026-07-28T00:00"),
            datetime(2026, 7, 29, 12, 0, tzinfo=timezone.utc),
        )
        self.assertEqual([(piece["date"], piece["grossMinutes"]) for piece in pieces], [("2026-07-27", 60)])

    def test_spring_missing_minute_is_rejected(self) -> None:
        configure_record_timezone("America/Los_Angeles")
        with self.assertRaises(DomainError) as caught:
            local_minute_to_utc("2025-03-09T02:15", "startedAt")
        self.assertEqual(caught.exception.code, "invalid_local_minute")

    def test_touching_edges_are_valid_but_real_overlap_is_not(self) -> None:
        configure_record_timezone("UTC")
        now = datetime(2026, 7, 27, 18, 0, tzinfo=timezone.utc)
        existing = [segment("known", "会议", "support", "2026-07-27T10:00", "2026-07-27T11:00")]
        validate_candidate("2026-07-27T09:00", "2026-07-27T10:00", 0, existing, now=now)
        validate_candidate("2026-07-27T11:00", "2026-07-27T12:00", 0, existing, now=now)
        with self.assertRaises(DomainError) as caught:
            validate_candidate("2026-07-27T10:30", "2026-07-27T11:30", 0, existing, now=now)
        self.assertEqual(caught.exception.code, "overlap")

    def test_minimum_future_minute_is_the_only_allowed_future_end(self) -> None:
        configure_record_timezone("UTC")
        now = datetime(2026, 7, 27, 18, 0, tzinfo=timezone.utc)
        validate_candidate("2026-07-27T18:00", "2026-07-27T18:01", 0, [], now=now)
        for started_at, ended_at in (("2026-07-27T17:59", "2026-07-27T18:01"), ("2026-07-27T18:00", "2026-07-27T18:02")):
            with self.subTest(started_at=started_at, ended_at=ended_at), self.assertRaises(DomainError) as caught:
                validate_candidate(started_at, ended_at, 0, [], now=now)
            self.assertEqual(caught.exception.code, "future_timestamp")

    def test_open_segment_is_virtually_closed_at_query_time(self) -> None:
        configure_record_timezone("UTC")
        now = datetime(2026, 7, 27, 11, 0, tzinfo=timezone.utc)
        items = [segment("open", "开发", "core", "2026-07-27T09:30", None)]
        coverage = compute_day_coverage(items, "2026-07-27", now)
        summary = summarize_range(items, "2026-07-27", "2026-07-27", now)
        self.assertEqual((coverage["recordedMinutes"], coverage["gapMinutes"]), (90, 570))
        self.assertEqual((summary["effectiveWorkMinutes"], summary["recordedMinutes"]), (90, 90))

    def test_future_open_segment_does_not_pollute_current_or_future_coverage(self) -> None:
        configure_record_timezone("UTC")
        now = datetime(2026, 7, 28, 10, 0, tzinfo=timezone.utc)
        item = segment("future", "未来脏数据", "core", "2026-07-28T10:01", None)
        current = compute_day_coverage([item], "2026-07-28", now)
        future = compute_day_coverage([item], "2026-07-29", now)
        self.assertEqual((current["openSegment"], current["recordedMinutes"]), (None, 0))
        self.assertEqual((future["openSegment"], future["denominatorMinutes"]), (None, 0))

    def test_open_segment_cannot_have_a_deduction(self) -> None:
        configure_record_timezone("UTC")
        with self.assertRaises(DomainError) as caught:
            validate_candidate(
                "2026-07-27T17:00", None, 1, [], now=datetime(2026, 7, 27, 18, 0, tzinfo=timezone.utc)
            )
        self.assertEqual(caught.exception.code, "deduction_out_of_range")

    def test_recovery_does_not_count_as_work(self) -> None:
        configure_record_timezone("UTC")
        result = summarize_range(
            [segment("sleep", "睡眠", "recovery", "2026-07-27T00:00", "2026-07-27T08:00")],
            "2026-07-27", "2026-07-27", datetime(2026, 7, 27, 12, 0, tzinfo=timezone.utc),
        )
        self.assertEqual((result["grossWorkMinutes"], result["effectiveWorkMinutes"]), (0, 0))

    def test_soft_deleted_segments_are_absent_from_coverage_and_summary(self) -> None:
        configure_record_timezone("UTC")
        deleted = segment("deleted", "撤销记录", "core", "2026-07-27T09:00", "2026-07-27T10:00")
        deleted["deletedAt"] = "2026-07-27T10:01:00+00:00"
        now = datetime(2026, 7, 27, 12, 0, tzinfo=timezone.utc)
        coverage = compute_day_coverage([deleted], "2026-07-27", now)
        summary = summarize_range([deleted], "2026-07-27", "2026-07-27", now)
        self.assertEqual((coverage["recordedMinutes"], summary["recordedMinutes"]), (0, 0))


class TimeOverlongSegmentTests(unittest.TestCase):
    """超长时段是软标记而非闸门：8 小时线只负责让「16.7 小时的睡觉」在时间轴上显形。"""

    def test_eight_hours_is_the_inclusive_upper_bound_of_normal(self) -> None:
        self.assertEqual(
            [is_overlong_segment(gross) for gross in (0, 479, 480, 481, 1000, 1440)],
            [False, False, False, True, True, True],
        )

    def test_open_segment_is_never_marked_by_the_server(self) -> None:
        # 进行中时段没有毛时间；「已经跑了多久」由前端用配置阈值自行判断，服务端不越权表态。
        self.assertFalse(is_overlong_segment(None))

    def test_threshold_is_read_from_constants_not_inlined(self) -> None:
        self.assertFalse(is_overlong_segment(OVERLONG_SEGMENT_MINUTES))
        self.assertTrue(is_overlong_segment(OVERLONG_SEGMENT_MINUTES + 1))
        with patch("domains.time.rules.OVERLONG_SEGMENT_MINUTES", 100):
            self.assertEqual([is_overlong_segment(gross) for gross in (100, 101)], [False, True])
        self.assertEqual([is_overlong_segment(gross) for gross in (100, 101)], [False, False])

    def test_published_threshold_is_exactly_where_the_projection_flips(self) -> None:
        """配置下发的阈值与投影实际翻面的点必须是同一个数，否则前后端会静默分叉。

        单独断言「配置里是 480」是常量等于常量，挡不住有人把 service 里的
        OVERLONG_SEGMENT_MINUTES 换成字面量 480：那一刻测试照样全绿，
        直到有人调整常量，面板拿到旧阈值、服务端按新阈值标记，两边各说各话。
        这里把两者绑在一起——阈值是多少无所谓，但下发值上必须不超长、下发值 +1 必须超长。
        """
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        ledger = Ledger("time", root / "time" / "time.sqlite3", root / "time" / "audit")
        config = {
            "host": "127.0.0.1", "port": 43210, "accessToken": "test-token",
            "allowedHosts": [], "timezone": "UTC", "timezoneSource": "config",
        }
        published = configuration(ledger, ensure_schema(ledger, config))["overlongSegmentMinutes"]

        self.assertIsInstance(published, int)
        self.assertFalse(is_overlong_segment(published))
        self.assertTrue(is_overlong_segment(published + 1))

    def test_soft_mark_does_not_touch_the_1440_hard_gate(self) -> None:
        configure_record_timezone("UTC")
        now = datetime(2026, 8, 1, 12, 0, tzinfo=timezone.utc)
        validate_candidate("2026-07-31T00:00", "2026-07-31T16:42", 0, [], now=now)
        with self.assertRaises(DomainError) as caught:
            validate_candidate("2026-07-29T00:00", "2026-07-30T00:01", 0, [], now=now)
        self.assertEqual(caught.exception.code, "too_long")


class AuditCheckpointConcurrencyTests(unittest.TestCase):
    """审计快照必须与它命名的那个事件一一对应。"""

    def setUp(self) -> None:
        configure_record_timezone("UTC")
        self.temporary = tempfile.TemporaryDirectory()
        root = Path(self.temporary.name)
        (root / "time" / "audit").mkdir(parents=True, exist_ok=True)
        self.ledger = Ledger("time", root / "time" / "time.sqlite3", root / "time" / "audit")
        self.config = {"host": "127.0.0.1", "port": 43210, "accessToken": "t", "allowedHosts": [], "timezone": "UTC", "timezoneSource": "config"}
        ensure_schema(self.ledger, self.config)

    def tearDown(self) -> None:
        self.temporary.cleanup()
        configure_record_timezone("UTC")

    def test_每份快照的事件数与它自己的序号一致(self) -> None:
        """并发删除时，`<事件id>.sqlite3` 里的 audit_events 行数必须恰好等于该事件的序号。

        检查点此前在 with 块之外执行——锁已释放，提交到拍快照之间别的写入能挤进来，
        于是快照里含着该事件之后才提交的内容，行数出现重复值与缺号：
        某个事件的「不可覆盖检查点」里已经有它之后的另一次写入，
        而另一些事件时点根本没有对应快照。审计快照是 P9 修 7-31 时依赖的恢复手段，
        它与事件对不上，就等于没有可回溯的时点。
        """
        import threading
        import time as _time

        import core.audit as audit_module

        real_checkpoint = audit_module.checkpoint_database

        def slow_checkpoint(ledger, event):
            """人为撑开「提交完成」到「快照拍完」之间的窗口。

            真实窗口只有几毫秒，12 个线程也撞不上——不放大就等于没测：
            这条回归第一版对「回调在锁内」与「回调在锁外」两种实现都是绿的。
            放大后语义不变：锁内实现会被串行化（快照与事件仍一一对应），
            锁外实现则让并发提交挤进窗口，快照行数立刻出现重复与缺号。
            """
            _time.sleep(0.05)
            return real_checkpoint(ledger, event)

        patcher = patch.object(audit_module, "checkpoint_database", slow_checkpoint)
        patcher.start()
        self.addCleanup(patcher.stop)

        segments = []
        for index in range(12):
            hour = f"{index:02d}"
            created = create_segment(self.ledger, {
                "title": f"段{index}", "categoryName": "开发",
                "startedAt": f"2026-07-27T{hour}:00", "endedAt": f"2026-07-27T{hour}:30",
            })
            segments.append(created["segment"]["id"])

        barrier = threading.Barrier(len(segments))
        errors: list[BaseException] = []

        def remove(segment_id: str) -> None:
            try:
                barrier.wait(timeout=10)
                delete_segment(self.ledger, segment_id, {"reason": "并发删除"})
            except BaseException as exc:  # noqa: BLE001
                errors.append(exc)

        threads = [threading.Thread(target=remove, args=(sid,)) for sid in segments]
        for thread in threads: thread.start()
        for thread in threads: thread.join(timeout=30)
        self.assertEqual(errors, [])

        snapshots = sorted((self.ledger.audit_root / "snapshots").glob("*.sqlite3"))
        # MVP 数据安全：新增和删除都各有一个不可覆盖快照，不再只有删除才留底。
        self.assertEqual(len(snapshots), len(segments) * 2)

        counts = []
        for snapshot in snapshots:
            # 快照继承 WAL 模式，mode=ro 需要建 -shm 因而打不开；沙箱内直连即可。
            probe = sqlite3.connect(snapshot)
            try:
                counts.append(probe.execute("SELECT COUNT(*) FROM audit_events").fetchone()[0])
            finally:
                probe.close()

        # 24 份快照必须恰好覆盖 1..24：有重复值说明两次拍到了同一时点，
        # 有缺号说明某个事件提交后从未被单独拍下。
        self.assertEqual(sorted(counts), list(range(1, len(segments) * 2 + 1)), counts)


class TimeSchemaFailClosedTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        root = Path(self.temporary.name)
        self.ledger = Ledger("time", root / "runtime" / "time" / "time.sqlite3", root / "runtime" / "time" / "audit")
        self.config = {"host": "127.0.0.1", "port": 43210, "accessToken": "test-token", "allowedHosts": [], "timezone": "UTC", "timezoneSource": "config"}

    def tearDown(self) -> None:
        self.temporary.cleanup()
        configure_record_timezone("UTC")

    def _create_legacy_segments(self, entries: list[tuple[str, str, str]]) -> None:
        connection = self.ledger.connect()
        try:
            connection.executescript(
                "CREATE TABLE segments (id TEXT PRIMARY KEY,title TEXT NOT NULL,category_json TEXT,project_name TEXT,started_at TEXT NOT NULL,ended_at TEXT,deduction_minutes INTEGER NOT NULL DEFAULT 0,source TEXT NOT NULL DEFAULT 'agent',created_at TEXT NOT NULL,updated_at TEXT NOT NULL);"
            )
            connection.executemany(
                "INSERT INTO segments VALUES (?,?,?,?,?,?,?,?,?,?)",
                [(segment_id, "旧账本", '{"name":"开发","nature":"core"}', None, started_at, ended_at, 0, "agent", "2025-07-01T00:00:00+00:00", "2025-07-01T00:00:00+00:00") for segment_id, started_at, ended_at in entries],
            )
            connection.commit()
        finally:
            connection.close()

    def test_legacy_overlap_refuses_startup_instead_of_guessing(self) -> None:
        self._create_legacy_segments([("first", "2025-07-01T09:00", "2025-07-01T10:00"), ("second", "2025-07-01T09:30", "2025-07-01T10:30")])
        with self.assertRaisesRegex(RuntimeError, "存在重叠"):
            ensure_schema(self.ledger, self.config)

    def test_legacy_dst_duplicate_minute_refuses_utc_backfill(self) -> None:
        self.config["timezone"] = "America/Los_Angeles"
        self._create_legacy_segments([("ambiguous", "2025-11-02T01:15", "2025-11-02T01:45")])
        with self.assertRaisesRegex(RuntimeError, "无法唯一还原"):
            ensure_schema(self.ledger, self.config)

    def test_partial_unique_index_still_rejects_a_second_open_segment(self) -> None:
        ensure_schema(self.ledger, self.config)
        create_segment(self.ledger, {"title": "当前活动", "categoryName": "开发", "startedAt": "2020-01-01T09:00"})
        with self.ledger.write_transaction() as connection:
            with self.assertRaises(sqlite3.IntegrityError):
                connection.execute(
                    "INSERT INTO segments(id,title,category_json,started_at,started_utc,deduction_minutes,tags_json,source,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
                    ("second-open", "重复进行中", '{"name":"开发","nature":"core"}', "2020-01-01T10:00", "2020-01-01T10:00:00+00:00", 0, "[]", "manual", "2020-01-01T00:00:00+00:00", "2020-01-01T00:00:00+00:00"),
                )

    def test_timezone_plan_includes_soft_deleted_history(self) -> None:
        ensure_schema(self.ledger, self.config)
        connection = self.ledger.connect()
        try:
            connection.execute(
                "INSERT INTO segments(id,title,category_json,started_at,ended_at,started_utc,ended_utc,deduction_minutes,tags_json,source,created_at,updated_at,deleted_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
                ("deleted", "已删除历史", '{"name":"开发","nature":"core"}', "2025-07-01T09:00", "2025-07-01T10:00", "2025-07-01T09:00:00+00:00", "2025-07-01T10:00:00+00:00", 0, "[]", "import", "2025-07-01T00:00:00+00:00", "2025-07-01T00:00:00+00:00", "2025-07-02T00:00:00+00:00"),
            )
            updates = plan_timezone_conversion(connection, "UTC", "Asia/Shanghai")
        finally:
            connection.close()
        self.assertEqual(updates, [("deleted", "2025-07-01T17:00", "2025-07-01T18:00")])

    def test_interop_summary_stays_inside_the_time_ledger(self) -> None:
        ensure_schema(self.ledger, self.config)
        agent_operation(self.ledger, {"userConfirmation": "请创建 LifeOS 项目", "entity": "project", "action": "create", "payload": {"name": "LifeOS", "status": "active"}})
        create_segment(self.ledger, {"title": "架构设计", "categoryName": "开发", "projectName": "LifeOS", "startedAt": "2020-01-01T09:00", "endedAt": "2020-01-01T10:00"})
        summary = projects_summary(self.ledger)
        self.assertEqual(len(summary), 1)
        self.assertEqual({key: summary[0][key] for key in ("name", "status", "segmentCount")}, {"name": "LifeOS", "status": "active", "segmentCount": 1})


class TimeReadWindowBoundaryTests(unittest.TestCase):
    """只读窗口的两条边界：午夜跳变日的日界口径，以及贴着 datetime 两端的不可投影日期。"""

    CONFIG = {"host": "127.0.0.1", "port": 43211, "accessToken": "test-token", "allowedHosts": [], "timezoneSource": "config"}

    def tearDown(self) -> None:
        configure_record_timezone("UTC")

    @contextmanager
    def isolated_ledger(self, timezone_name: str) -> Iterator[Ledger]:
        """每个时区一本全新的隔离账本；记录时区是进程级冻结的，不能在同一本账本里换来换去。"""
        with tempfile.TemporaryDirectory(prefix="lifeos-time-window-") as directory:
            root = Path(directory)
            ledger = Ledger("time", root / "runtime" / "time" / "time.sqlite3", root / "runtime" / "time" / "audit")
            configure_record_timezone(timezone_name)
            ensure_schema(ledger, {**self.CONFIG, "timezone": timezone_name})
            yield ledger

    def test_minute_window_on_midnight_dst_day_answers_the_same_as_day_bounds(self) -> None:
        # America/Santiago 在跳变日把 00:00 直接跳成 01:00（午夜不存在），
        # America/Havana 则把 01:00 回拨成 00:00（午夜有两解）。面板日视图正是用
        # from=当日T00:00 / to=次日T00:00 取数，此前两者都被 409 invalid_local_minute 打穿，
        # 而同一天的 gaps 照常给出 1380 / 1500 分钟的正确分母——服务端有两套日界答案。
        for timezone_name, day, previous_day, denominator in (
            ("America/Santiago", "2025-09-07", "2025-09-06", 1380),
            ("America/Havana", "2025-11-02", "2025-11-01", 1500),
        ):
            with self.subTest(timezone=timezone_name), self.isolated_ledger(timezone_name) as ledger:
                create_segment(ledger, {"title": "跳变日上午", "categoryName": "开发", "startedAt": f"{day}T09:00", "endedAt": f"{day}T10:00"})
                create_segment(ledger, {"title": "前一日下午", "categoryName": "开发", "startedAt": f"{previous_day}T14:00", "endedAt": f"{previous_day}T15:00"})
                zone = ZoneInfo(timezone_name)
                next_day = (date.fromisoformat(day) + timedelta(days=1)).isoformat()

                # 分钟型窗口与 local_day_bounds_utc 必须是同一瞬间，而不是一个 409、一个数字。
                self.assertEqual(
                    (
                        local_minute_boundary_utc(parse_minute(f"{day}T00:00", "from"), zone),
                        local_minute_boundary_utc(parse_minute(f"{next_day}T00:00", "to"), zone),
                    ),
                    local_day_bounds_utc(date.fromisoformat(day), zone),
                )
                self.assertEqual(gaps(ledger, day)["denominatorMinutes"], denominator)

                today = list_segments(ledger, {"from": [f"{day}T00:00"], "to": [f"{next_day}T00:00"]})
                self.assertEqual([item["title"] for item in today["segments"]], ["跳变日上午"])
                yesterday = list_segments(ledger, {"from": [f"{previous_day}T00:00"], "to": [f"{day}T00:00"]})
                self.assertEqual([item["title"] for item in yesterday["segments"]], ["前一日下午"])

    def test_dst_degradation_stays_out_of_the_write_path(self) -> None:
        # 只读窗口降级不得顺手放宽写入：一个不存在的墙钟分钟被写进账本就是永久的错记录。
        configure_record_timezone("America/Santiago")
        with self.assertRaises(DomainError) as caught:
            local_minute_to_utc("2025-09-07T00:30", "startedAt")
        self.assertEqual((caught.exception.code, caught.exception.status), ("invalid_local_minute", 409))

    def test_edge_year_dates_are_refused_as_client_errors(self) -> None:
        # 记录时区为正偏移时，year=1 的墙钟投影会落到 datetime.min 之前；负偏移则 year=9999 越过 datetime.max。
        # 此前一路走到 astimezone 抛 OverflowError，被 httpd 兜成 500 并把 traceback 打进 stderr。
        for timezone_name, edge_date in (("Asia/Shanghai", "0001-01-01"), ("America/Los_Angeles", "9999-12-31")):
            with self.subTest(timezone=timezone_name, date=edge_date), self.isolated_ledger(timezone_name) as ledger:
                # 闸门只关掉贴着 datetime 两端的那两天，正常年份的读窗口必须原样放行。
                self.assertEqual(list_segments(ledger, {"from": ["2025-07-01"], "to": ["2025-07-01"]})["total"], 0)
                connection = ledger.connect()
                try:  # 无 started_utc 的旧行；habits 不收日期参数，只能经它回退到本地分钟投影
                    connection.execute(
                        "INSERT INTO segments(id,title,category_json,started_at,ended_at,started_utc,ended_utc,deduction_minutes,tags_json,source,created_at,updated_at)"
                        " VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                        ("edge", "边界旧行", '{"name":"开发","nature":"core"}', f"{edge_date}T00:00", None, None, None, 0, "[]", "import", "2025-07-01T00:00:00+00:00", "2025-07-01T00:00:00+00:00"),
                    )
                    connection.commit()
                finally:
                    connection.close()
                calls = (
                    ("segments-date", lambda: list_segments(ledger, {"from": [edge_date], "to": [edge_date]})),
                    ("segments-minute", lambda: list_segments(ledger, {"from": [f"{edge_date}T00:00"], "to": [f"{edge_date}T00:00"]})),
                    ("gaps", lambda: gaps(ledger, edge_date)),
                    ("summary", lambda: summary(ledger, edge_date, edge_date)),
                    ("habits", lambda: habits(ledger, "开发")),
                )
                for label, call in calls:
                    with self.subTest(endpoint=label):
                        with self.assertRaises(DomainError) as caught:
                            call()
                        self.assertEqual(caught.exception.code, "invalid_range")
                        self.assertTrue(400 <= caught.exception.status < 500, caught.exception.status)


class TimeAuditCheckpointTests(unittest.TestCase):
    def test_time_checkpoint_snapshots_are_immutable_per_event(self) -> None:
        with tempfile.TemporaryDirectory(prefix="lifeos-time-checkpoint-") as directory:
            root = Path(directory)
            ledger = Ledger("time", root / "runtime" / "time" / "time.sqlite3", root / "runtime" / "time" / "audit")
            connection = ledger.connect()
            try:
                connection.execute("CREATE TABLE marker (value TEXT NOT NULL)")
                connection.execute("INSERT INTO marker VALUES ('before')")
                connection.commit()
            finally:
                connection.close()
            checkpoint_database(ledger, {"id": "before-event"})
            connection = ledger.connect()
            try:
                connection.execute("UPDATE marker SET value='after'")
                connection.commit()
            finally:
                connection.close()
            checkpoint_database(ledger, {"id": "after-event"})
            snapshots = ledger.audit_root / "snapshots"
            with sqlite3.connect(snapshots / "before-event.sqlite3") as connection:
                self.assertEqual(connection.execute("SELECT value FROM marker").fetchone()[0], "before")
            with sqlite3.connect(snapshots / "after-event.sqlite3") as connection:
                self.assertEqual(connection.execute("SELECT value FROM marker").fetchone()[0], "after")


if __name__ == "__main__":
    unittest.main()
