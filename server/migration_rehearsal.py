"""
[INPUT]: 接收名称固定为 synthetic-fixture 的一次性本地夹具目录，依赖 Python 标准库的 SQLite backup、copytree 与哈希。
[OUTPUT]: 对外提供合成双账本的封存、复制、三锚对账、故障注入和快照回滚演练；CLI 仅接受 --synthetic-fixture。
[POS]: server 的 P5/P6 迁移安全演练器；它不接受生产路径、旧指针或监听地址，P7 真实切换必须另按人工剧本执行。
[PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import sqlite3
from dataclasses import asdict, dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Iterable


FIXTURE_DIRECTORY_NAME = "synthetic-fixture"
MARKER_NAME = ".lifeos-synthetic-migration-fixture"
DOMAIN_DATABASES = {"time": "time.sqlite3", "finance": "finance.sqlite3"}
ANCHOR_TABLES = {
    "time": ("segments", "categories", "projects", "settings", "runtime_state"),
    "finance": ("transactions", "categories", "accounts", "ledger_settings", "attachments", "recurring_rules"),
}


class MigrationSafetyError(RuntimeError):
    """演练路径、夹具标记或账本结构不满足安全边界。"""


class AnchorMismatchError(RuntimeError):
    """候选双账本与封存基线的三锚任一不一致。"""


@dataclass(frozen=True)
class LedgerAnchor:
    """一个账本的完整性、行数与业务总量三锚。"""

    integrity: str
    table_counts: tuple[tuple[str, int], ...]
    totals: tuple[tuple[str, Any], ...]


@dataclass(frozen=True)
class RehearsalAnchors:
    """双账本不可混合的三锚集合。"""

    time: LedgerAnchor
    finance: LedgerAnchor


def _resolve_fixture_root(fixture_root: Path) -> Path:
    """限定所有副作用在显式命名的合成夹具目录，路径逃逸一律拒绝。"""
    resolved = fixture_root.expanduser().resolve()
    if resolved.name != FIXTURE_DIRECTORY_NAME:
        raise MigrationSafetyError(
            f"迁移演练只能在目录名为 {FIXTURE_DIRECTORY_NAME} 的临时夹具中执行。"
        )
    return resolved


def _inside_fixture(root: Path, path: Path) -> Path:
    """解析软链接后确认目标仍在夹具根内，防止借演练触碰外部文件。"""
    resolved = path.expanduser().resolve()
    try:
        resolved.relative_to(root)
    except ValueError as error:
        raise MigrationSafetyError("演练路径逃离 synthetic-fixture，已拒绝执行。") from error
    return resolved


def _fixture_paths(fixture_root: Path) -> dict[str, Path]:
    root = _resolve_fixture_root(fixture_root)
    return {
        "root": root,
        "source": _inside_fixture(root, root / "source-runtime"),
        "sealed": _inside_fixture(root, root / "sealed-runtime"),
        "candidate": _inside_fixture(root, root / "lifeos-runtime"),
    }


def _require_marker(root: Path) -> None:
    marker = _inside_fixture(root, root / MARKER_NAME)
    if not marker.is_file() or marker.read_text(encoding="utf-8").strip() != "lifeos synthetic migration fixture v1":
        raise MigrationSafetyError("缺少合成迁移夹具标记；拒绝把未知目录当作账本来源。")


def _chmod_tree(path: Path, *, directory_mode: int, file_mode: int) -> None:
    """在本夹具内收紧/恢复权限；不跟随文件系统外的链接。"""
    if path.is_symlink():
        raise MigrationSafetyError("演练夹具不允许符号链接。")
    for current, directories, files in os.walk(path):
        current_path = Path(current)
        if current_path.is_symlink():
            raise MigrationSafetyError("演练夹具不允许符号链接。")
        os.chmod(current_path, directory_mode)
        for name in [*directories, *files]:
            child = current_path / name
            if child.is_symlink():
                raise MigrationSafetyError("演练夹具不允许符号链接。")
            if child.is_dir():
                os.chmod(child, directory_mode)
            else:
                os.chmod(child, file_mode)


def _copy_file(source: Path, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, destination)
    os.chmod(destination, 0o600)


def _sqlite_backup(source: Path, destination: Path) -> None:
    """以 SQLite backup 取得一致数据库副本，而非裸拷贝 WAL 三件套。"""
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_suffix(destination.suffix + ".tmp")
    source_connection = destination_connection = None
    try:
        source_connection = sqlite3.connect(f"file:{source}?mode=ro", uri=True)
        destination_connection = sqlite3.connect(temporary)
        source_connection.backup(destination_connection)
    finally:
        if destination_connection is not None:
            destination_connection.close()
        if source_connection is not None:
            source_connection.close()
    os.chmod(temporary, 0o600)
    temporary.replace(destination)


def _remove_tree(path: Path) -> None:
    """清掉夹具内的旧副本；封存后的只读位由本函数负责放开。

    封存副本被 `archive_fixture` chmod 成 0o500/0o400：目录没有写位，rmtree
    连自己刚创建的文件都删不掉，于是对同一夹具第二次演练会撞上未捕获的
    PermissionError 原始 traceback —— 演练器变成一次性用品，复跑必须人工 chmod
    或重造夹具。收紧权限是封存的手段，不该反过来把封存做成不可逆。
    失败一律翻译成本脚本自己的 MigrationSafetyError，让调用方看到边界诊断。
    """
    if path.is_symlink():
        raise MigrationSafetyError("演练夹具不允许符号链接。")
    _chmod_tree(path, directory_mode=0o700, file_mode=0o600)
    try:
        shutil.rmtree(path)
    except OSError as error:
        raise MigrationSafetyError(f"无法清理旧的演练副本 {path}：{error}") from error


def _copy_runtime(source: Path, destination: Path) -> None:
    """按域目录复制，数据库走 backup，其余附件按原相对路径复制。"""
    if destination.exists():
        _remove_tree(destination)
    destination.mkdir(parents=True, mode=0o700)
    for domain, database_name in DOMAIN_DATABASES.items():
        source_domain = source / domain
        target_domain = destination / domain
        database = source_domain / database_name
        if not source_domain.is_dir() or not database.is_file():
            raise MigrationSafetyError(f"合成来源缺少 {domain}/{database_name}，拒绝演练。")
        for item in source_domain.rglob("*"):
            relative = item.relative_to(source_domain)
            target = target_domain / relative
            if item.is_symlink():
                raise MigrationSafetyError("演练夹具不允许符号链接。")
            if item.is_dir():
                target.mkdir(parents=True, exist_ok=True)
            elif item == database:
                _sqlite_backup(item, target)
            elif item.name not in {f"{database_name}-wal", f"{database_name}-shm"}:
                _copy_file(item, target)
    _chmod_tree(destination, directory_mode=0o700, file_mode=0o600)


def _database_path(runtime: Path, domain: str) -> Path:
    return runtime / domain / DOMAIN_DATABASES[domain]


def _existing_tables(connection: sqlite3.Connection) -> set[str]:
    return {str(row[0]) for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")}


def _require_columns(connection: sqlite3.Connection, table: str, columns: Iterable[str]) -> None:
    actual = {str(row[1]) for row in connection.execute(f"PRAGMA table_info({table})")}
    missing = set(columns) - actual
    if missing:
        raise MigrationSafetyError(f"{table} 缺少三锚所需列：{', '.join(sorted(missing))}。")


def _time_totals(connection: sqlite3.Connection) -> tuple[tuple[str, Any], ...]:
    _require_columns(connection, "segments", ("started_utc", "ended_utc", "deleted_at"))
    _require_columns(connection, "runtime_state", ("key", "value_json"))
    minutes = 0
    for started, ended in connection.execute(
        "SELECT started_utc,ended_utc FROM segments WHERE deleted_at IS NULL AND ended_utc IS NOT NULL"
    ):
        start = datetime.fromisoformat(str(started).replace("Z", "+00:00"))
        finish = datetime.fromisoformat(str(ended).replace("Z", "+00:00"))
        duration = int((finish - start).total_seconds() // 60)
        if duration < 0:
            raise MigrationSafetyError("time.sqlite3 存在倒置 UTC 区间，拒绝生成迁移基线。")
        minutes += duration
    deleted = int(connection.execute("SELECT COUNT(*) FROM segments WHERE deleted_at IS NOT NULL").fetchone()[0])
    timezone_rows = connection.execute(
        "SELECT key,value_json FROM runtime_state WHERE key IN ('record_timezone','record_timezone_resolved') ORDER BY key"
    ).fetchall()
    if len(timezone_rows) != 2:
        raise MigrationSafetyError("time.sqlite3 缺少 runtime_state 时区双键，拒绝迁移。")
    timezone_values = tuple((str(key), str(value)) for key, value in timezone_rows)
    return (("closedActiveMinutes", minutes), ("softDeletedSegments", deleted), ("timezoneState", timezone_values))


def _relative_attachment_path(raw: Any) -> Path:
    path = Path(str(raw or ""))
    if not str(path) or path.is_absolute() or ".." in path.parts:
        raise MigrationSafetyError("附件 stored_path 必须是 finance 域内相对路径。")
    return path


def _finance_totals(connection: sqlite3.Connection, finance_root: Path) -> tuple[tuple[str, Any], ...]:
    _require_columns(connection, "transactions", ("amount", "currency"))
    transaction_columns = {str(row[1]) for row in connection.execute("PRAGMA table_info(transactions)")}
    direction = "direction" if "direction" in transaction_columns else "kind"
    if direction not in transaction_columns:
        raise MigrationSafetyError("transactions 缺少 direction/kind，无法执行总量对账。")
    grouped = connection.execute(
        f"SELECT COALESCE(currency,''),COALESCE({direction},''),COALESCE(SUM(amount),0) "
        f"FROM transactions GROUP BY COALESCE(currency,''),COALESCE({direction},'') ORDER BY 1,2"
    ).fetchall()
    amounts = tuple((str(currency), str(kind), float(amount)) for currency, kind, amount in grouped)
    _require_columns(connection, "attachments", ("stored_path",))
    attachment_rows = connection.execute("SELECT stored_path FROM attachments ORDER BY stored_path").fetchall()
    attachment_hashes = []
    for (stored_path,) in attachment_rows:
        attachment = finance_root / _relative_attachment_path(stored_path)
        if not attachment.is_file():
            raise MigrationSafetyError(f"附件记录没有对应文件：{stored_path}。")
        attachment_hashes.append((str(stored_path), hashlib.sha256(attachment.read_bytes()).hexdigest()))
    return (("amountByCurrencyDirection", amounts), ("attachments", tuple(attachment_hashes)))


def capture_anchors(runtime: Path) -> RehearsalAnchors:
    """只读计算合成候选或封存副本的三锚；两个 SQLite 从不 ATTACH 或 JOIN。"""
    anchors: dict[str, LedgerAnchor] = {}
    for domain, tables in ANCHOR_TABLES.items():
        database = _database_path(runtime, domain)
        if not database.is_file():
            raise MigrationSafetyError(f"缺少 {domain} 账本，无法执行三锚对账。")
        connection = sqlite3.connect(f"file:{database}?mode=ro", uri=True)
        try:
            integrity = str(connection.execute("PRAGMA integrity_check").fetchone()[0])
            if integrity.lower() != "ok":
                raise MigrationSafetyError(f"{domain} integrity_check 失败：{integrity}。")
            existing = _existing_tables(connection)
            missing = set(tables) - existing
            if missing:
                raise MigrationSafetyError(f"{domain} 缺少对账表：{', '.join(sorted(missing))}。")
            counts = tuple((table, int(connection.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0])) for table in tables)
            totals = _time_totals(connection) if domain == "time" else _finance_totals(connection, runtime / "finance")
            anchors[domain] = LedgerAnchor(integrity=integrity, table_counts=counts, totals=totals)
        finally:
            connection.close()
    return RehearsalAnchors(time=anchors["time"], finance=anchors["finance"])


def archive_fixture(fixture_root: Path) -> RehearsalAnchors:
    """封存合成来源的独立快照，再建立三锚基线；来源账本不被修改。"""
    paths = _fixture_paths(fixture_root)
    _require_marker(paths["root"])
    _copy_runtime(paths["source"], paths["sealed"])
    anchors = capture_anchors(paths["sealed"])
    _chmod_tree(paths["sealed"], directory_mode=0o500, file_mode=0o400)
    return anchors


def copy_sealed_snapshot(fixture_root: Path) -> RehearsalAnchors:
    """将封存副本复制到 LifeOS 的 time/finance 域目录，复制后立即三锚核验。"""
    paths = _fixture_paths(fixture_root)
    _require_marker(paths["root"])
    if not paths["sealed"].is_dir():
        raise MigrationSafetyError("尚未封存合成来源，拒绝直接复制到 LifeOS runtime。")
    _copy_runtime(paths["sealed"], paths["candidate"])
    return capture_anchors(paths["candidate"])


def verify_candidate(fixture_root: Path, expected: RehearsalAnchors) -> RehearsalAnchors:
    """对比候选 LifeOS 双账本与封存基线；任一域不一致即报告而不继续。"""
    paths = _fixture_paths(fixture_root)
    _require_marker(paths["root"])
    actual = capture_anchors(paths["candidate"])
    if actual != expected:
        raise AnchorMismatchError(
            "三锚对账失败：候选 LifeOS runtime 与封存副本不一致；必须回滚，禁止进入 P7。"
        )
    return actual


def inject_synthetic_finance_mismatch(fixture_root: Path) -> None:
    """仅在候选夹具制造一笔额外流水，验证对账失败与回滚分支真实可达。"""
    paths = _fixture_paths(fixture_root)
    _require_marker(paths["root"])
    database = _database_path(paths["candidate"], "finance")
    connection = sqlite3.connect(database)
    try:
        connection.execute(
            "INSERT INTO transactions(id,amount,kind,currency) VALUES ('synthetic-fault',999.0,'expense','CNY')"
        )
        connection.commit()
    finally:
        connection.close()


def rollback_candidate(fixture_root: Path) -> RehearsalAnchors:
    """发现不一致后只以封存副本恢复候选目录，绝不回写合成来源。"""
    paths = _fixture_paths(fixture_root)
    _require_marker(paths["root"])
    if not paths["sealed"].is_dir():
        raise MigrationSafetyError("没有封存副本，拒绝执行无回滚锚的恢复。")
    _copy_runtime(paths["sealed"], paths["candidate"])
    return capture_anchors(paths["candidate"])


def run_synthetic_rehearsal(fixture_root: Path, *, inject_fault: bool = True) -> dict[str, Any]:
    """完整走一次封存→复制→对账→故障→回滚；只适用于 create_synthetic_fixture 产生的夹具。"""
    baseline = archive_fixture(fixture_root)
    copied = copy_sealed_snapshot(fixture_root)
    verify_candidate(fixture_root, baseline)
    mismatch_detected = False
    if inject_fault:
        inject_synthetic_finance_mismatch(fixture_root)
        try:
            verify_candidate(fixture_root, baseline)
        except AnchorMismatchError:
            mismatch_detected = True
        if not mismatch_detected:
            raise AssertionError("合成故障未被三锚检测，拒绝给出演练成功结论。")
        rolled_back = rollback_candidate(fixture_root)
        verify_candidate(fixture_root, baseline)
    else:
        rolled_back = copied
    return {
        "fixture": str(_resolve_fixture_root(fixture_root)),
        "baseline": asdict(baseline),
        "copied": asdict(copied),
        "mismatchDetected": mismatch_detected,
        "rolledBack": asdict(rolled_back),
    }


def create_synthetic_fixture(fixture_root: Path) -> Path:
    """创建最小但结构真实的双账本与附件，用于不触碰生产数据的 P6 演练。"""
    paths = _fixture_paths(fixture_root)
    root = paths["root"]
    if root.exists() and any(root.iterdir()):
        raise MigrationSafetyError("合成夹具目录必须不存在或为空，拒绝覆盖既有文件。")
    root.mkdir(parents=True, mode=0o700, exist_ok=True)
    _inside_fixture(root, root / MARKER_NAME).write_text("lifeos synthetic migration fixture v1\n", encoding="utf-8")
    (paths["source"] / "time").mkdir(parents=True, exist_ok=True)
    (paths["source"] / "finance" / "attachments" / "receipt-a").mkdir(parents=True, exist_ok=True)
    _create_time_fixture(_database_path(paths["source"], "time"))
    _create_finance_fixture(_database_path(paths["source"], "finance"))
    receipt = paths["source"] / "finance/attachments/receipt-a/proof.txt"
    receipt.write_text("synthetic receipt only\n", encoding="utf-8")
    connection = sqlite3.connect(_database_path(paths["source"], "finance"))
    try:
        connection.execute(
            "INSERT INTO attachments(id,stored_path) VALUES ('attachment-a','attachments/receipt-a/proof.txt')"
        )
        connection.commit()
    finally:
        connection.close()
    _chmod_tree(root, directory_mode=0o700, file_mode=0o600)
    return root


def _create_time_fixture(database: Path) -> None:
    connection = sqlite3.connect(database)
    try:
        connection.executescript(
            """
            CREATE TABLE segments(id TEXT PRIMARY KEY, started_utc TEXT, ended_utc TEXT, deleted_at TEXT);
            CREATE TABLE categories(id TEXT PRIMARY KEY);
            CREATE TABLE projects(id TEXT PRIMARY KEY);
            CREATE TABLE settings(id INTEGER PRIMARY KEY);
            CREATE TABLE runtime_state(key TEXT PRIMARY KEY, value_json TEXT);
            INSERT INTO segments VALUES ('segment-a','2026-01-01T00:00:00+00:00','2026-01-01T01:30:00+00:00',NULL);
            INSERT INTO segments VALUES ('segment-deleted','2026-01-01T02:00:00+00:00','2026-01-01T03:00:00+00:00','2026-01-02T00:00:00+00:00');
            INSERT INTO categories VALUES ('category-a');
            INSERT INTO projects VALUES ('project-a');
            INSERT INTO settings VALUES (1);
            INSERT INTO runtime_state VALUES ('record_timezone','"Asia/Shanghai"');
            INSERT INTO runtime_state VALUES ('record_timezone_resolved','"Asia/Shanghai"');
            """
        )
        connection.commit()
    finally:
        connection.close()


def _create_finance_fixture(database: Path) -> None:
    connection = sqlite3.connect(database)
    try:
        connection.executescript(
            """
            CREATE TABLE transactions(id TEXT PRIMARY KEY, amount REAL, kind TEXT, currency TEXT);
            CREATE TABLE categories(id TEXT PRIMARY KEY);
            CREATE TABLE accounts(id TEXT PRIMARY KEY);
            CREATE TABLE ledger_settings(id INTEGER PRIMARY KEY);
            CREATE TABLE attachments(id TEXT PRIMARY KEY, stored_path TEXT);
            CREATE TABLE recurring_rules(id TEXT PRIMARY KEY);
            INSERT INTO transactions VALUES ('expense-a',12.5,'expense','CNY');
            INSERT INTO transactions VALUES ('income-a',100.0,'income','CNY');
            INSERT INTO categories VALUES ('category-a');
            INSERT INTO accounts VALUES ('account-a');
            INSERT INTO ledger_settings VALUES (1);
            INSERT INTO recurring_rules VALUES ('rule-a');
            """
        )
        connection.commit()
    finally:
        connection.close()


def _main() -> int:
    parser = argparse.ArgumentParser(description="LifeOS 合成迁移回滚演练（绝不读取生产 runtime）")
    parser.add_argument("--synthetic-fixture", required=True, type=Path, help="目录名必须是 synthetic-fixture")
    parser.add_argument("--create", action="store_true", help="创建空的最小合成夹具")
    parser.add_argument("--without-fault", action="store_true", help="只验证封存/复制/对账，不进入故障和回滚分支")
    arguments = parser.parse_args()
    if arguments.create:
        create_synthetic_fixture(arguments.synthetic_fixture)
    report = run_synthetic_rehearsal(arguments.synthetic_fixture, inject_fault=not arguments.without_fault)
    print(json.dumps(report, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(_main())
