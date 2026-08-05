"""
[INPUT]: 依赖 _lifeos_test_support 的一次性回环端口、core.config、lifeos_node_server、finance 服务与
         migration_rehearsal；全部副作用局限在 TemporaryDirectory 与名为 synthetic-fixture 的合成夹具。
[OUTPUT]: 对外提供 P6 的回滚与迁移工具回归：合成双账本三锚差异后由快照恢复、独立演练器拒绝非夹具路径、
          封存副本可被反复演练而不退化成一次性用品。
[POS]: server 测试套件里「迁移与回滚」这一关注点；不安装、不发布、不调用 Skill，
       也绝不解析生产 runtime 或旧指针。
[PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
"""

from __future__ import annotations

import shutil
import sqlite3
import tempfile
import unittest
from pathlib import Path

from _lifeos_test_support import reserve_test_port

import migration_rehearsal


def ledger_anchor(database: Path, *, is_finance: bool) -> dict[str, object]:
    """P6 合成演练的结构、行数与金额锚；不认识任何生产路径。"""
    connection = sqlite3.connect(database)
    try:
        tables = [row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")]
        counts = {table: connection.execute(f'SELECT COUNT(*) FROM "{table}"').fetchone()[0] for table in tables}
        anchor: dict[str, object] = {"integrity": connection.execute("PRAGMA integrity_check").fetchone()[0], "counts": counts}
        if is_finance:
            anchor["totals"] = connection.execute("SELECT currency,kind,ROUND(SUM(amount),2) FROM transactions WHERE deleted_at IS NULL GROUP BY currency,kind ORDER BY currency,kind").fetchall()
        return anchor
    finally:
        connection.close()


class IsolatedRollbackRehearsalTests(unittest.TestCase):
    """P6 的可自动化部分：合成双账本副本的三锚差异与快照回滚。"""

    def test_synthetic_dual_ledger_mismatch_restores_snapshot(self) -> None:
        from core.config import write_config
        from domains.finance.service import create_transaction
        from lifeos_node_server import create_application

        with tempfile.TemporaryDirectory() as temporary:
            sandbox = Path(temporary)
            runtime = sandbox / "runtime"
            write_config(runtime / "config.json", {
                "host": "127.0.0.1", "port": reserve_test_port(), "accessToken": "rollback-golden-token",
                "allowedHosts": [], "timezone": "", "timezoneSource": "system",
            })
            app = create_application(runtime)
            baseline_transaction = {
                "title": "演练基线", "amount": 12.5, "kind": "expense", "source": "manual",
                "accountName": "微信支付", "category": {"name": "餐饮"},
            }
            create_transaction(app.finance_ledger, baseline_transaction)
            for database in (runtime / "time/time.sqlite3", runtime / "finance/finance.sqlite3"):
                connection = sqlite3.connect(database)
                try:
                    connection.execute("PRAGMA wal_checkpoint(TRUNCATE)")
                finally:
                    connection.close()
            baseline = {
                "time": ledger_anchor(runtime / "time/time.sqlite3", is_finance=False),
                "finance": ledger_anchor(runtime / "finance/finance.sqlite3", is_finance=True),
            }
            snapshot = sandbox / "rollback-snapshot"
            shutil.copytree(runtime, snapshot)

            create_transaction(app.finance_ledger, {**baseline_transaction, "title": "故意失败", "amount": 99})
            mismatch = ledger_anchor(runtime / "finance/finance.sqlite3", is_finance=True)
            self.assertNotEqual(mismatch, baseline["finance"], "故意制造的三锚差异必须被发现")
            shutil.rmtree(runtime)
            shutil.copytree(snapshot, runtime)
            restored = {
                "time": ledger_anchor(runtime / "time/time.sqlite3", is_finance=False),
                "finance": ledger_anchor(runtime / "finance/finance.sqlite3", is_finance=True),
            }
            self.assertEqual(restored, baseline)
            self.assertEqual(restored["time"]["integrity"], "ok")
            self.assertEqual(restored["finance"]["integrity"], "ok")


class SyntheticMigrationToolTests(unittest.TestCase):
    """独立演练器必须只接受合成夹具，并真实跑到回滚分支。"""

    def test_sealed_copy_detects_mismatch_and_restores_candidate(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            fixture = Path(temporary) / "synthetic-fixture"
            migration_rehearsal.create_synthetic_fixture(fixture)

            report = migration_rehearsal.run_synthetic_rehearsal(fixture)

            self.assertTrue(report["mismatchDetected"])
            self.assertEqual(report["baseline"], report["rolledBack"])
            self.assertTrue((fixture / "sealed-runtime/time/time.sqlite3").is_file())
            self.assertTrue((fixture / "lifeos-runtime/finance/finance.sqlite3").is_file())

    def test_tool_refuses_a_directory_without_the_synthetic_boundary(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            outside = Path(temporary) / "not-a-fixture"
            with self.assertRaises(migration_rehearsal.MigrationSafetyError):
                migration_rehearsal.create_synthetic_fixture(outside)

    def test_the_same_fixture_can_be_rehearsed_more_than_once(self) -> None:
        """演练器必须能对同一夹具复跑；封存不该顺手把夹具做成一次性用品。

        archive_fixture 把封存副本 chmod 成 0o500/0o400，而 _copy_runtime 在写入前
        直接 rmtree 旧副本：目录没有写位，连它自己刚建的文件都删不掉。于是第二次演练
        崩在未捕获的 PermissionError 原始 traceback 上——既不是本脚本的 MigrationSafetyError，
        也没有任何提示说「先手工 chmod 或重造夹具」。P7 切换前要反复演练的正是这条路径。
        """
        with tempfile.TemporaryDirectory() as temporary:
            fixture = Path(temporary) / "synthetic-fixture"
            migration_rehearsal.create_synthetic_fixture(fixture)

            first = migration_rehearsal.run_synthetic_rehearsal(fixture)
            sealed = fixture / "sealed-runtime"
            self.assertEqual(sealed.stat().st_mode & 0o777, 0o500, "封存副本第一次跑完必须是只读的")

            second = migration_rehearsal.run_synthetic_rehearsal(fixture)

            self.assertEqual(second["baseline"], first["baseline"], "复跑必须得到同一份三锚基线")
            self.assertTrue(second["mismatchDetected"])
            self.assertEqual(second["baseline"], second["rolledBack"])
            self.assertEqual(sealed.stat().st_mode & 0o777, 0o500, "复跑之后封存副本仍须被重新收紧")


if __name__ == "__main__":
    unittest.main()
