"""
[INPUT]: 依赖每个领域提供的 SQLite 路径与审计目录。
[OUTPUT]: 对外提供 Ledger、独立连接、WAL 初始化及每账本 BEGIN IMMEDIATE 写事务。
[POS]: 双账本的数据主权边界；time 与 finance 使用相同原语但绝不共享锁、连接或事务。
[PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
"""

from __future__ import annotations

import sqlite3
import threading
from contextlib import contextmanager
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Iterator


class LedgerConnection(sqlite3.Connection):
    """带提交后钩子的连接。

    sqlite3.Connection 是 C 类型、挂不了任意属性，因此必须经 `factory=` 子类化，
    这是标准库为此留的扩展点。钩子只在 write_transaction 里被填充与执行。
    """

    after_commit_tasks: list


@dataclass
class Ledger:
    name: str
    db_path: Path
    audit_root: Path
    lock: threading.RLock = field(default_factory=threading.RLock, repr=False)

    def connect(self) -> sqlite3.Connection:
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        connection = sqlite3.connect(self.db_path, timeout=10, factory=LedgerConnection)
        connection.after_commit_tasks = []
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA journal_mode=WAL")
        connection.execute("PRAGMA busy_timeout=10000")
        connection.execute("PRAGMA foreign_keys=ON")
        return connection

    @contextmanager
    def write_transaction(self) -> Iterator[sqlite3.Connection]:
        """仅串行本账本写入；其他账本可同时写入。

        提交后、**仍持本账本写锁**时运行 `connection.after_commit_tasks` 里登记的回调。
        审计检查点必须走这条路：它此前在 with 块之外执行，锁已释放，
        提交到拍快照之间别的写入能挤进来——于是名为 `<事件id>.sqlite3` 的
        不可覆盖快照里含着该事件之后才提交的内容，而另一些事件时点根本没有对应快照。
        回调仍在事务之外（数据已 commit），因此其失败可以安全降级为回执警告，
        绝不反噬已落库的写入——这一点与原设计一致，改的只是锁的持有范围。
        """
        with self.lock:
            connection = self.connect()
            try:
                connection.execute("BEGIN IMMEDIATE")
                yield connection
                connection.commit()
            except BaseException:
                connection.rollback()
                raise
            finally:
                tasks = list(connection.after_commit_tasks)
                connection.close()
            for task in tasks:
                task()
