"""
[INPUT]: 依赖 unittest.mock 模拟 lifeconn 的受限 HTTP 连接，不读取本机安装指针或真实账本。
[OUTPUT]: 锁定列表型只读回执与非法标量回执的传输边界。
[POS]: skills/zzm-lifeos/scripts 的连接层回归金样，与 test_time_skill 的纯函数金样互补。
[PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
"""

from __future__ import annotations

import json
import unittest
from unittest.mock import MagicMock, patch

import lifeconn


def _opener_for(payload: object) -> MagicMock:
    response = MagicMock()
    response.status = 200
    response.read.return_value = json.dumps(payload).encode("utf-8")
    response.__enter__.return_value = response
    opener = MagicMock()
    opener.open.return_value = response
    return opener


class RequestApiTests(unittest.TestCase):
    def test_read_list_receipt_is_preserved(self) -> None:
        opener = _opener_for([{"id": "row-1"}])
        with patch.object(lifeconn, "connection", return_value=lifeconn.Connection(root=MagicMock(), port=59418, token="test")), patch("lifeconn.urllib.request.build_opener", return_value=opener):
            self.assertEqual(lifeconn.request_api("GET", "/v1/fin/transactions", domain="fin"), [{"id": "row-1"}])

    def test_scalar_receipt_remains_result_unknown(self) -> None:
        opener = _opener_for("not-a-receipt")
        with patch.object(lifeconn, "connection", return_value=lifeconn.Connection(root=MagicMock(), port=59418, token="test")), patch("lifeconn.urllib.request.build_opener", return_value=opener):
            with self.assertRaisesRegex(lifeconn.LifeOSTransportError, "对象或数组"):
                lifeconn.request_api("GET", "/v1/fin/transactions", domain="fin")


if __name__ == "__main__":
    unittest.main()
