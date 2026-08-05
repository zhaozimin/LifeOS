"""
[INPUT]: 依赖临时 finance Ledger 与 domains.finance.service 的附件上传编排；不启动 HTTP、不创建 time 数据库。
[OUTPUT]: 锁定「附件上传对不存在的流水必须寸土不动」——404 的请求不得在财务账本数据根留下任何目录。
[POS]: finance 领域回归里专管附件落盘副作用的一份；算法与状态机在 test_finance_domain.py，
       HTTP 层在 test_lifeos_http_finance.py，本文件只看文件系统这条边。
[PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
"""

from __future__ import annotations

import base64
import tempfile
import unittest
from pathlib import Path

from core.errors import DomainError
from core.sqlite import Ledger
from domains.finance import service


class AttachmentUploadSideEffectTests(unittest.TestCase):
    """附件目录是财务账本的数据根，只有确认流水存在之后才允许被改动。"""

    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        root = Path(self.temporary.name)
        self.ledger = Ledger("finance", root / "finance.sqlite3", root / "audit")
        service.ensure_schema(self.ledger)
        self.attachments = root / "attachments"

    def tearDown(self) -> None:
        self.temporary.cleanup()

    @staticmethod
    def _payload() -> dict[str, object]:
        return {
            "data": base64.b64encode("演练票据".encode("utf-8")).decode("ascii"),
            "mime": "text/plain",
            "filename": "receipt.txt",
        }

    def test_upload_to_a_missing_transaction_leaves_no_directory_behind(self) -> None:
        """回执说 404「什么都没发生」，账本的数据根就必须真的什么都没发生。

        mkdir 此前排在「流水是否存在」的校验之前：面板重试一笔刚被删掉的流水、
        Agent 拿过期 id 重传票据，都会在 attachments/ 下留下一个以该 id 命名的空目录。
        它既进不了 attachments 表，也不会被 delete_attachment 回收，
        只能靠人手去数据根里清扫——而数据根正是这个产品最不该被误碰的地方。
        """
        with self.assertRaises(DomainError) as raised:
            service.upload_attachment(self.ledger, "does-not-exist", self._payload())

        self.assertEqual(raised.exception.status, 404)
        self.assertFalse(
            (self.attachments / "does-not-exist").exists(),
            "404 的上传不得在财务账本数据根留下目录",
        )
        # 连 attachments/ 本身都不该被这次失败的请求创建出来。
        self.assertFalse(self.attachments.exists())

    def test_upload_to_an_existing_transaction_still_stores_the_file(self) -> None:
        """把校验挪到 mkdir 之前不能顺手砍掉正常路径：目录、文件与索引行都要在。"""
        created = service.create_transaction(self.ledger, {
            "title": "午饭", "amount": 25, "kind": "expense",
            "accountName": "微信支付", "category": {"name": "餐饮"}, "source": "manual",
        })

        receipt = service.upload_attachment(self.ledger, created["id"], self._payload())

        stored = self.attachments / created["id"]
        self.assertTrue(stored.is_dir())
        files = sorted(stored.iterdir())
        self.assertEqual(len(files), 1)
        self.assertEqual(files[0].read_bytes().decode("utf-8"), "演练票据")
        self.assertEqual(receipt["transactionId"], created["id"])
        self.assertEqual(receipt["sizeBytes"], len("演练票据".encode("utf-8")))

        connection = self.ledger.connect()
        try:
            rows = connection.execute(
                "SELECT stored_path FROM attachments WHERE transaction_id=?", (created["id"],)
            ).fetchall()
        finally:
            connection.close()
        self.assertEqual(len(rows), 1)
        self.assertTrue(str(rows[0]["stored_path"]).startswith(f"attachments/{created['id']}/"))


if __name__ == "__main__":
    unittest.main()
