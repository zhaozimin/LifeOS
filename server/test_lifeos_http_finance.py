"""
[INPUT]: 依赖临时 runtime、LifeOS 应用工厂、finance.sqlite3 直连与标准库 HTTP 客户端。
[OUTPUT]: 锁定 P2 财务 CRUD、报销级联、域内附件路径、导入两步、MVP 周期暂停回执、双账本互不阻塞，
          以及新建路径的重复提交时间窗闸（含逃生阀、窗口外放行与既有 id 的 409 而非 500）。
[POS]: finance HTTP 验收；全部请求走随机端口，绝不触碰 59418 或任何生产 runtime。
[PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
"""

from __future__ import annotations

import base64
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
from unittest.mock import patch
from pathlib import Path
from urllib.parse import quote

from core.config import write_config
from core.httpd import create_server
from lifeos_node_server import create_application


PRODUCTION_PORTS = frozenset({51440, 59418})


def port() -> int:
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


class FinanceFixture(unittest.TestCase):
    """共用夹具：随机端口 + 临时 runtime，本身不含断言。"""

    def setUp(self) -> None:
        self.temp=tempfile.TemporaryDirectory(); self.runtime=Path(self.temp.name)/"runtime"; self.token="lifeos-finance-test-token-32-bytes"; self.port=port()
        write_config(self.runtime/"config.json", {"host":"127.0.0.1","port":self.port,"accessToken":self.token,"allowedHosts":[],"timezone":"","timezoneSource":"system"})
        self.app=create_application(self.runtime)
        self.server=create_server(self.app); self.thread=threading.Thread(target=self.server.serve_forever,daemon=True); self.thread.start()

    def tearDown(self) -> None: self.server.shutdown(); self.server.server_close(); self.thread.join(); self.temp.cleanup()

    def request(self, method: str, path: str, body: dict | None = None) -> tuple[int, object]:
        connection=http.client.HTTPConnection("127.0.0.1",self.port,timeout=5); raw=json.dumps(body).encode() if body is not None else None
        connection.request(method,path,body=raw,headers={"Host":f"127.0.0.1:{self.port}","Authorization":f"Bearer {self.token}",**({"Content-Type":"application/json"} if raw else {})}); response=connection.getresponse(); value=json.loads(response.read()); connection.close(); return response.status,value

    def binary_request(self, method: str, path: str) -> tuple[int, bytes, str]:
        connection=http.client.HTTPConnection("127.0.0.1",self.port,timeout=5); connection.request(method,path,headers={"Host":f"127.0.0.1:{self.port}","Authorization":f"Bearer {self.token}"}); response=connection.getresponse(); status,body,kind=response.status,response.read(),response.getheader("Content-Type") or ""; connection.close(); return status,body,kind

    def raw_get(self, path: str) -> bytes:
        """绕开 http.client 的解析，直接看网线上的字节——分片响应只有这样才现形。"""
        with socket.create_connection(("127.0.0.1", self.port), timeout=5) as probe:
            probe.sendall(
                f"GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{self.port}\r\n"
                f"Authorization: Bearer {self.token}\r\nConnection: close\r\n\r\n".encode()
            )
            chunks = []
            while True:
                chunk = probe.recv(65536)
                if not chunk: break
                chunks.append(chunk)
        return b"".join(chunks)

    def configuration(self) -> dict:
        status, config = self.request("GET", "/v1/fin/configuration")
        self.assertEqual(status, 200)
        return config  # type: ignore[return-value]

    def save_configuration(self, config: dict) -> dict:
        status, saved = self.request("PUT", "/v1/fin/configuration", config)
        self.assertEqual(status, 200)
        return saved  # type: ignore[return-value]

    def transaction(self, **changes: object) -> dict:
        payload={"title":"午饭","amount":25,"kind":"expense","accountName":"微信支付","category":{"name":"餐饮"},"source":"manual"}; payload.update(changes); status,item=self.request("POST","/v1/fin/transactions",payload); self.assertEqual(status,201); return item # type: ignore[return-value]


class FinanceHttpTests(FinanceFixture):
    """P2 原有验收：CRUD、报销级联、E9 触发点与附件/导出。"""

    def test_crud_and_reimbursement_delete_cascade(self) -> None:
        expense=self.transaction(reimbursementStatus="draft"); income=self.transaction(kind="income",title="报销",category={"name":"工资"})
        status,payload=self.request("POST","/v1/fin/reimbursements/settle",{"incomeId":income["id"],"settleIds":[expense["id"]]}); self.assertEqual((status,payload["settled"]),(200,1))
        self.assertEqual(self.request("DELETE",f"/v1/fin/transactions/{income['id']}")[0],200)
        status,items=self.request("GET","/v1/fin/transactions?includeDeleted=1"); self.assertEqual(status,200); self.assertEqual({item["id"]:item for item in items}[expense["id"]]["reimbursementStatus"],"draft")
        self.assertTrue(any((self.runtime/"finance"/"audit"/"snapshots").glob("*.sqlite3")))

    def test_import_preview_is_pure_and_dashboard_is_e9_trigger(self) -> None:
        status,paused=self.request("POST","/v1/fin/recurring",{"name":"历史周期","template":{"title":"周期","amount":1,"kind":"expense","accountName":"微信支付","category":{"name":"餐饮"}},"nextDueAt":"2000-01-01"}); self.assertEqual((status,paused["error"]),(409,"mvp_recurring_paused"))
        content=base64.b64encode("日期,金额,交易对方\n2026-01-01,-5,咖啡\n".encode()).decode(); status,preview=self.request("POST","/v1/fin/import/preview",{"template":"generic","content":content}); self.assertEqual(status,200); self.assertEqual(len(preview["transactions"]),1)
        status,items=self.request("GET","/v1/fin/transactions"); self.assertEqual(status,200); self.assertEqual(len(items),0)
        status,overview=self.request("GET","/v1/fin/dashboard/overview"); self.assertEqual(status,200); self.assertEqual(overview["meta"]["transactionCount"],0)
        self.assertEqual(self.request("GET","/v1/fin/recurring"),(200,[]))
        self.assertEqual(self.request("POST","/v1/fin/recurring/catchup",{})[1],{"generated":0,"paused":True})

    def test_chinese_attachment_name_still_returns_the_real_bytes(self) -> None:
        """中文附件名必须仍能取回原字节，且响应里只能有一个状态码。

        真实事故：Content-Disposition 直接内插中文名，http.server 用 latin-1 编码头，
        于是在状态行与 Content-Type 已经写进 socket 之后才抛 UnicodeEncodeError，
        外层再补发一个 500——网线上是「200 OK + application/pdf」后面紧跟「500」。
        客户端采信第一个状态码，前端 AuthedImage 只在 fetch 失败时报错，200 走成功分支，
        于是「加载失败」永不显示，用户看到「有票据」却永远打不开，磁盘上的字节完好无损却不可达。
        中文用户从 Finder 选「发票.pdf」必然触发。
        """
        payload = b"%PDF-1.4 real receipt"
        transaction = self.transaction()
        status, attachment = self.request(
            "POST", f"/v1/fin/transactions/{transaction['id']}/attachments",
            {"filename": "发票.pdf", "mime": "application/pdf",
             "data": base64.b64encode(payload).decode()},
        )
        self.assertEqual(status, 201)

        status, body, kind = self.binary_request("GET", f"/v1/fin/attachments/{attachment['id']}")
        self.assertEqual((status, body, kind), (200, payload, "application/pdf"))

        # 裸 socket 复核：一个响应里只能出现一个状态行，否则客户端拿到的 200 是假的。
        raw = self.raw_get(f"/v1/fin/attachments/{attachment['id']}")
        self.assertEqual(raw.count(b"HTTP/1.0 "), 1, raw[:200])
        # 中文名以 RFC 6266 的 filename* 传达，ASCII 兜底字段同时存在
        self.assertIn(b"filename*=UTF-8''", raw)

    def test_header_injection_in_attachment_name_never_reaches_the_wire(self) -> None:
        """附件名里的 CRLF 不得提前终结头块，把 nosniff 等安全头挤进响应体。"""
        transaction = self.transaction()
        status, attachment = self.request(
            "POST", f"/v1/fin/transactions/{transaction['id']}/attachments",
            {"filename": "a\r\nX-Injected: 1\r\n\r\nevil.pdf", "mime": "text/plain",
             "data": base64.b64encode(b"body").decode()},
        )
        self.assertEqual(status, 201)

        raw = self.raw_get(f"/v1/fin/attachments/{attachment['id']}")
        head = raw.split(b"\r\n\r\n", 1)[0]
        # 关键不是「X-Injected 这几个字不出现」——剥掉 CRLF 后它作为文件名里的
        # 普通文字残留是无害的；关键是它不能成为**一行头**。
        self.assertNotIn(b"\r\nX-Injected", raw)
        # 头块只有一个，安全头没有被挤到响应体里去
        self.assertIn(b"X-Content-Type-Options: nosniff", head)
        self.assertEqual(raw.count(b"\r\n\r\n"), 1)
        self.assertEqual(raw.count(b"HTTP/1.0 "), 1)

    def test_attachment_agent_and_export_routes_are_real(self) -> None:
        transaction=self.transaction(); data=base64.b64encode(b"hello").decode()
        status,attachment=self.request("POST",f"/v1/fin/transactions/{transaction['id']}/attachments",{"filename":"hello.txt","mime":"text/plain","data":data}); self.assertEqual(status,201)
        connection=sqlite3.connect(self.runtime/"finance"/"finance.sqlite3")
        try: stored=connection.execute("SELECT stored_path FROM attachments WHERE id=?",(attachment["id"],)).fetchone()[0]
        finally: connection.close()
        self.assertEqual(stored.split("/",1)[0],"attachments"); self.assertFalse(Path(stored).is_absolute())
        status,body,kind=self.binary_request("GET",f"/v1/fin/attachments/{attachment['id']}"); self.assertEqual((status,body,kind),(200,b"hello","text/plain"))
        self.assertEqual(self.request("DELETE",f"/v1/fin/attachments/{attachment['id']}")[0],200)
        status,payload=self.request("POST","/v1/fin/agent/operations",{"entityType":"category","action":"create","data":{"name":"测试分类"}}); self.assertEqual((status,payload["error"]),(422,"user_confirmation_required"))
        status,payload=self.request("POST","/v1/fin/agent/operations",{"entityType":"category","action":"create","data":{"name":"测试分类"},"userConfirmation":"同意创建"}); self.assertEqual((status,payload["entity"]["name"]),(200,"测试分类"))
        self._assert_exports_follow_the_optional_dependency_contract()

    def _assert_exports_follow_the_optional_dependency_contract(self) -> None:
        """XLSX 导出对 openpyxl 是「可选依赖」契约，两个分支都要锁住。

        export_xlsx 刻意延迟导入并把缺库降级为 503，好让可选包不成为服务启动依赖。
        此前测试无条件断言 200，与该契约互相矛盾：CI 从不 pip install，
        于是四条矩阵腿全败，release job 因 needs 永不执行——
        这道门禁看起来在守着发布，实际上从来没有绿过。
        现在依赖已声明在 server/requirements.txt 且 CI 会安装，
        但降级路径仍必须可测，否则它会重新变成没人走过的死路。
        """
        try:
            import openpyxl  # noqa: F401
            installed = True
        except ImportError:
            installed = False

        if installed:
            for path in ("/v1/fin/export/xlsx", "/v1/fin/export/tax-report?year=2026"):
                with self.subTest(path=path, dependency="present"):
                    status, body, kind = self.binary_request("GET", path)
                    self.assertEqual(status, 200)
                    self.assertTrue(kind.startswith("application/vnd.openxmlformats"))
                    self.assertGreater(len(body), 1000)
        else:
            # 裸机上不假红：导出这一支需要真依赖，缺它就只验降级。
            # CI 必然装（server/requirements.txt + ci.yml 的安装步骤，
            # 由 test_ci_installs_the_declared_dependency 守着），因此这里的 skip
            # 不会变成「永远没人跑过导出」。
            print("[LifeOS] 未安装 openpyxl，跳过导出正例，仅验证降级路径。")

        # sys.modules 里塞 None 会让 `import openpyxl` 抛 ImportError，
        # 等价于运行环境根本没装它，且不必真的卸载。
        with patch.dict(sys.modules, {"openpyxl": None, "openpyxl.styles": None, "openpyxl.utils": None}):
            for path in ("/v1/fin/export/xlsx", "/v1/fin/export/tax-report?year=2026"):
                with self.subTest(path=path, dependency="missing"):
                    status, payload = self.request("GET", path)
                    self.assertEqual((status, payload["error"]), (503, "export_dependency_missing"))

        # 缺库只影响导出，服务本身与其余端点必须照常
        self.assertEqual(self.request("GET", "/v1/fin/configuration")[0], 200)


class FinanceRegressionTests(FinanceFixture):
    """锁定本轮修复：更新路径、导入 commit、双库互不阻塞、配置写入三重语义、请求体上限。"""

    def test_update_transaction_marks_corrected_and_exposes_timestamps(self) -> None:
        """PUT 路径此前零测试覆盖，而回执缺 createdAt/updatedAt 让「已更正 ↻」永不可达。"""
        created = self.transaction()
        self.assertIn("createdAt", created)
        self.assertIn("updatedAt", created)
        self.assertEqual(created["createdAt"], created["updatedAt"])

        status, updated = self.request(
            "PUT", f"/v1/fin/transactions/{created['id']}", {"title": "午饭", "amount": 42, "kind": "expense"}
        )
        self.assertEqual(status, 200)
        self.assertEqual(updated["amount"], 42)
        self.assertEqual(updated["createdAt"], created["createdAt"])
        self.assertNotEqual(updated["updatedAt"], updated["createdAt"])

    def test_import_commit_actually_writes_transactions(self) -> None:
        """设计 1.1 点名的「导入两步」此前只测了 preview，commit 一行未测。"""
        content = base64.b64encode("日期,金额,交易对方\n2026-01-01,-5,咖啡\n2026-01-02,-8,早餐\n".encode()).decode()
        status, preview = self.request("POST", "/v1/fin/import/preview", {"template": "generic", "content": content})
        self.assertEqual(status, 200)
        self.assertEqual(len(preview["transactions"]), 2)

        before = len(self.request("GET", "/v1/fin/transactions")[1])  # type: ignore[arg-type]
        status, committed = self.request("POST", "/v1/fin/import/commit", {"transactions": preview["transactions"]})
        self.assertEqual(status, 200)
        self.assertEqual(committed["imported"], 2)
        after = len(self.request("GET", "/v1/fin/transactions")[1])  # type: ignore[arg-type]
        self.assertEqual(after - before, 2)

    def test_dual_ledgers_do_not_block_each_other(self) -> None:
        """P2 验收锚：每账本一把锁，财务写事务不得让时间写入排队。"""
        finance_started = threading.Event()
        release_finance = threading.Event()

        def hold_finance_write() -> None:
            with self.app.finance_ledger.write_transaction() as connection:
                connection.execute("SELECT 1")
                finance_started.set()
                release_finance.wait(timeout=10)

        holder = threading.Thread(target=hold_finance_write, daemon=True)
        holder.start()
        self.assertTrue(finance_started.wait(timeout=5), "财务写事务未能开始")
        try:
            self.assertIsNot(self.app.time_ledger.lock, self.app.finance_ledger.lock)
            time_done = threading.Event()

            def write_time() -> None:
                with self.app.time_ledger.write_transaction() as connection:
                    connection.execute("SELECT 1")
                time_done.set()

            writer = threading.Thread(target=write_time, daemon=True)
            writer.start()
            self.assertTrue(time_done.wait(timeout=5), "时间账本被财务写事务阻塞，两本账本共用了锁")
            writer.join(timeout=5)
        finally:
            release_finance.set()
            holder.join(timeout=5)

    def test_account_rename_moves_history_and_preserves_balance(self) -> None:
        """改名必须带走历史交易，否则账户余额从 0 起算、旧交易变孤儿且不可逆。"""
        self.transaction(amount=100, kind="expense", accountName="微信支付")
        config = self.configuration()
        before = {item["name"]: item["currentBalance"] for item in config["accounts"]}
        self.assertIn("微信支付", before)

        for account in config["accounts"]:
            if account["name"] == "微信支付":
                account["name"] = "微信钱包"
        saved = self.save_configuration(config)

        names = {item["name"] for item in saved["accounts"]}
        self.assertIn("微信钱包", names)
        self.assertNotIn("微信支付", names)
        renamed = next(item for item in saved["accounts"] if item["name"] == "微信钱包")
        self.assertAlmostEqual(renamed["currentBalance"], before["微信支付"], places=2)

        status, items = self.request("GET", "/v1/fin/transactions")
        self.assertEqual(status, 200)
        self.assertTrue(all(item["accountName"] != "微信支付" for item in items))

    def test_balance_correction_writes_an_adjustment_transaction(self) -> None:
        """设置页改余额必须落成一条可追溯的「余额调整」交易，而不是静默覆盖。"""
        self.transaction(amount=100, kind="expense", accountName="微信支付")
        config = self.configuration()
        target = next(item for item in config["accounts"] if item["name"] == "微信支付")
        intended = round(float(target["currentBalance"]) - 30, 2)
        target["currentBalance"] = intended

        saved = self.save_configuration(config)
        settled = next(item for item in saved["accounts"] if item["name"] == "微信支付")
        self.assertAlmostEqual(settled["currentBalance"], intended, places=2)

        status, items = self.request("GET", "/v1/fin/transactions")
        self.assertEqual(status, 200)
        adjustments = [item for item in items if item["source"] == "adjustment"]
        self.assertEqual(len(adjustments), 1)
        self.assertEqual(adjustments[0]["title"], "余额调整")
        self.assertAlmostEqual(adjustments[0]["amount"], 30, places=2)

    def test_rename_and_balance_correction_in_one_save(self) -> None:
        """最易错的组合：同一次保存里既改名又对账。

        差额必须按**旧名**计算（此刻历史还挂在旧名下），调整交易必须落到**新名**上；
        顺序反了就会算出一个「余额被清空」的假差额，凭空生成一笔巨额调整。
        """
        self.transaction(amount=100, kind="expense", accountName="微信支付")
        config = self.configuration()
        target = next(item for item in config["accounts"] if item["name"] == "微信支付")
        intended = round(float(target["currentBalance"]) - 30, 2)
        target["name"] = "微信钱包"
        target["currentBalance"] = intended

        saved = self.save_configuration(config)
        renamed = next(item for item in saved["accounts"] if item["name"] == "微信钱包")
        self.assertAlmostEqual(renamed["currentBalance"], intended, places=2)

        status, items = self.request("GET", "/v1/fin/transactions")
        self.assertEqual(status, 200)
        adjustments = [item for item in items if item["source"] == "adjustment"]
        self.assertEqual(len(adjustments), 1)
        self.assertAlmostEqual(adjustments[0]["amount"], 30, places=2)
        self.assertEqual(adjustments[0]["accountName"], "微信钱包")
        self.assertTrue(all(item["accountName"] != "微信支付" for item in items))

    def test_account_name_swap_is_refused(self) -> None:
        """互换账户名会让顺序 UPDATE 把两边历史搅在一起，必须明确拒绝而不是悄悄执行。"""
        config = self.configuration()
        if len(config["accounts"]) < 2:
            self.skipTest("默认主数据不足两个账户")
        first, second = config["accounts"][0], config["accounts"][1]
        first["name"], second["name"] = second["name"], first["name"]
        status, payload = self.request("PUT", "/v1/fin/configuration", config)
        self.assertEqual((status, payload["error"]), (409, "account_rename_cycle"))

    def test_category_extension_fields_survive_a_save(self) -> None:
        """group / defaultAccountId / projectId 是面板正在编辑的字段，保存后不能被抹掉。"""
        config = self.configuration()
        account_id = config["accounts"][0]["id"]
        target = config["categories"][0]
        target["group"] = "日常开销"
        target["defaultAccountId"] = account_id
        target["projectId"] = "proj-1"
        target["note"] = "对账用"

        saved = self.save_configuration(config)
        restored = next(item for item in saved["categories"] if item["id"] == target["id"])
        self.assertEqual(restored["group"], "日常开销")
        self.assertEqual(restored["defaultAccountId"], account_id)
        self.assertEqual(restored["projectId"], "proj-1")
        self.assertEqual(restored["note"], "对账用")

    def test_dangling_default_account_reference_is_scrubbed(self) -> None:
        config = self.configuration()
        config["categories"][0]["defaultAccountId"] = "account-does-not-exist"
        saved = self.save_configuration(config)
        self.assertEqual(saved["categories"][0]["defaultAccountId"], "")

    def test_configuration_update_is_audited(self) -> None:
        """整表重建是一次大写入，审计链上不能是空白。"""
        config = self.configuration()
        self.save_configuration(config)
        status, payload = self.request("GET", "/v1/fin/audit/events")
        self.assertEqual(status, 200)
        actions = [event["entityType"] for event in payload["events"]]
        self.assertIn("configuration", actions)

    def test_attachment_beyond_one_megabyte_is_accepted(self) -> None:
        """全局 1MB 曾让 service 层的 10MB 上限永远执行不到，手机收据一张也传不上去。"""
        transaction = self.transaction()
        blob = b"x" * (1_500_000)
        encoded = base64.b64encode(blob).decode()
        status, attachment = self.request(
            "POST",
            f"/v1/fin/transactions/{transaction['id']}/attachments",
            {"filename": "receipt.bin", "mime": "application/octet-stream", "data": encoded},
        )
        self.assertEqual(status, 201)
        self.assertEqual(attachment["sizeBytes"], len(blob))

    def test_plain_json_endpoint_still_rejects_oversized_body(self) -> None:
        """放开的只是附件与导入两条路由，普通写入面必须仍守 1MB。

        服务端按 Content-Length 判定后立刻回 413 并关闭连接，客户端可能还没发完，
        因此「连接被对端切断」与「收到 413」都算作正确拒绝——不能算作写入成功。
        """
        oversized = {"title": "x" * 1_200_000, "amount": 1, "kind": "expense"}
        try:
            status, payload = self.request("POST", "/v1/fin/transactions", oversized)
        except (BrokenPipeError, ConnectionResetError):
            pass  # 超限请求在发送途中被拒，同样是「未写入」
        else:
            self.assertEqual((status, payload["error"]), (413, "payload_too_large"))
        status, items = self.request("GET", "/v1/fin/transactions")
        self.assertEqual(status, 200)
        self.assertEqual(items, [], "超限请求绝不能落库")

    def test_localhost_host_header_is_accepted(self) -> None:
        """TimeOS 蓝本的 Host 正则同时接受 localhost；收窄后书签会直接吃 403。"""
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        connection.request(
            "GET", "/v1/health", headers={"Host": f"localhost:{self.port}", "Authorization": f"Bearer {self.token}"}
        )
        response = connection.getresponse()
        status = response.status
        response.read()
        connection.close()
        self.assertEqual(status, 200)


class FinanceDuplicateWriteTests(FinanceFixture):
    """新建路径的重复提交闸。

    已复现的事故：同一个 body 连发两次落成两条不同 uuid 的行，¥25 的午饭变成 ¥50，
    而两条记录在面板上一字不差，用户几天后根本认不出该删哪条。
    时间域因 overlap 不变量意外免疫，所以这是财务域独有、且两域行为不一致。
    """

    LUNCH = {"title": "午饭", "amount": 25, "kind": "expense", "accountName": "微信支付",
             "category": {"name": "餐饮"}, "source": "manual"}

    def ledger(self) -> list[dict]:
        status, items = self.request("GET", "/v1/fin/transactions")
        self.assertEqual(status, 200)
        return items  # type: ignore[return-value]

    def shift_created_at(self, transaction_id: str, seconds: int) -> None:
        """把某一行的机器时刻推到过去，模拟「隔了很久才记第二笔」。

        直接改库而不是等真实时间流逝：窗口是 90 秒，让测试真等 90 秒等于让整个套件
        变成没人愿意跑的套件，而假时钟又会绕开被测的那段判定本身。
        """
        moved = (datetime.now(timezone.utc) - timedelta(seconds=seconds)).isoformat()
        connection = sqlite3.connect(self.runtime / "finance" / "finance.sqlite3")
        try:
            connection.execute("UPDATE transactions SET created_at=? WHERE id=?", (moved, transaction_id))
            connection.commit()
        finally:
            connection.close()

    def test_double_submit_leaves_exactly_one_row_and_the_right_total(self) -> None:
        status, first = self.request("POST", "/v1/fin/transactions", dict(self.LUNCH))
        self.assertEqual(status, 201)

        status, refused = self.request("POST", "/v1/fin/transactions", dict(self.LUNCH))
        self.assertEqual((status, refused["error"]), (409, "duplicate_record"))
        # 回执必须指名既有那一笔，Agent 才能只读核对而不是满账本猜
        self.assertEqual(refused["existingId"], first["id"])

        items = self.ledger()
        self.assertEqual(len(items), 1)
        self.assertAlmostEqual(sum(item["amount"] for item in items), 25, places=2)

    def test_allow_duplicate_is_the_escape_hatch_for_two_real_records(self) -> None:
        """用户真要连记两笔同样的钱时，护栏必须让得开——否则它就是个 bug 而不是护栏。"""
        status, first = self.request("POST", "/v1/fin/transactions", dict(self.LUNCH))
        self.assertEqual(status, 201)

        status, second = self.request("POST", "/v1/fin/transactions", {**self.LUNCH, "allowDuplicate": True})
        self.assertEqual(status, 201)
        self.assertNotEqual(second["id"], first["id"])

        items = self.ledger()
        self.assertEqual(len(items), 2)
        self.assertAlmostEqual(sum(item["amount"] for item in items), 50, places=2)

    def test_outside_the_window_the_same_body_is_just_a_second_coffee(self) -> None:
        """两杯真实的 ¥25 咖啡隔几小时记两笔必须放行；窗口是这条护栏的全部判据。"""
        status, first = self.request("POST", "/v1/fin/transactions", dict(self.LUNCH))
        self.assertEqual(status, 201)
        self.shift_created_at(first["id"], 2 * 60 * 60)

        status, second = self.request("POST", "/v1/fin/transactions", dict(self.LUNCH))
        self.assertEqual(status, 201, second)
        self.assertNotEqual(second["id"], first["id"])
        self.assertEqual(len(self.ledger()), 2)

    def test_resending_an_existing_id_is_a_definite_409_not_an_unknown_500(self) -> None:
        """最确定的一种失败不许被降级成最不确定的一种。

        裸 sqlite3.IntegrityError 会被 core/httpd.py 的 except Exception 兜成 500，
        而 lifeconn 把 5xx 一律翻成「写入结果未知；禁止重试，请先只读核查」。
        那一行原封不动躺在库里、本次一个字节都没写进去，是可以直接告诉用户的事实。
        """
        fixed = {**self.LUNCH, "id": "fin-fixed-id"}
        status, created = self.request("POST", "/v1/fin/transactions", dict(fixed))
        self.assertEqual((status, created["id"]), (201, "fin-fixed-id"))

        # 改掉标题与金额，绕开时间窗闸，逼这次请求真的走到 INSERT 上
        status, refused = self.request("POST", "/v1/fin/transactions", {**fixed, "title": "晚饭", "amount": 88})
        self.assertEqual((status, refused["error"]), (409, "duplicate_record"))
        self.assertEqual(refused["existingId"], "fin-fixed-id")

        # 逃生阀只放行「再记一笔」，不该变成覆盖既有 id 的通道
        status, refused = self.request("POST", "/v1/fin/transactions", {**fixed, "allowDuplicate": True})
        self.assertEqual((status, refused["error"]), (409, "duplicate_record"))

        items = self.ledger()
        self.assertEqual(len(items), 1)
        self.assertEqual(items[0]["title"], "午饭")

    def test_a_voided_record_never_blocks_recording_it_again(self) -> None:
        """作废后立刻原样重记必须放行。

        「记错了，撤销，重记一遍」是最日常的一条更正路径，且它天然发生在几秒之内——
        正落在去重窗口里。软删的行若参与判定，用户会在自己刚撤销的那一笔上撞 409，
        而账本里明明一条有效记录都没有。
        """
        status, created = self.request("POST", "/v1/fin/transactions", dict(self.LUNCH))
        self.assertEqual(status, 201)
        reason = quote("记错了", safe="")  # 查询串里的中文必须先转义，http.client 只吃 latin-1 的请求行
        self.assertEqual(self.request("DELETE", f"/v1/fin/transactions/{created['id']}?reason={reason}")[0], 200)

        status, again = self.request("POST", "/v1/fin/transactions", dict(self.LUNCH))
        self.assertEqual(status, 201, again)
        self.assertEqual(len(self.ledger()), 1)

    def test_the_gate_is_not_wired_onto_update_or_import(self) -> None:
        """去重闸只属于新建路径。

        update 是用户指名改哪一笔，把一笔改成与另一笔相同是合法的更正；
        账单导入天然会有同额同日多笔（每天同一家便利店），且它已有自己的重复判据。
        任一处被顺手套上，正常操作就会开始被 409 拒绝。
        """
        first = self.transaction(amount=25, title="午饭")
        other = self.transaction(amount=99, title="晚饭", allowDuplicate=True)
        status, updated = self.request(
            "PUT", f"/v1/fin/transactions/{other['id']}",
            {"title": "午饭", "amount": 25, "kind": "expense", "accountName": "微信支付"},
        )
        self.assertEqual(status, 200, updated)
        self.assertEqual(updated["id"], other["id"])
        self.assertNotEqual(updated["id"], first["id"])

        content = base64.b64encode("日期,金额,交易对方\n2026-01-01,-5,咖啡\n2026-01-01,-5,咖啡\n".encode()).decode()
        status, preview = self.request("POST", "/v1/fin/import/preview", {"template": "generic", "content": content})
        self.assertEqual(status, 200)
        status, committed = self.request("POST", "/v1/fin/import/commit", {"transactions": preview["transactions"]})
        self.assertEqual((status, committed["imported"], committed["failed"]), (200, 2, 0))


class FinanceCommandChainTests(FinanceFixture):
    """finctl → lifeconn → HTTP → finview 的真实命令链。

    时间域一直有这条链的端到端覆盖，财务侧此前是空白——而账务回执的符号字典
    正是在这条链的末端产出的，只靠纯函数金样喂构造数据无法发现它与服务端脱节。
    全程使用隔离 HOME 与随机端口：lifeconn 的指针优先级高于环境变量，
    不隔离 HOME 就会读到真实 `~/.config/lifeos/install.json` 而打到生产。
    """

    def setUp(self) -> None:
        super().setUp()
        scripts = Path(__file__).resolve().parent.parent / "skills" / "zzm-lifeos" / "scripts"
        if str(scripts) not in sys.path:
            sys.path.insert(0, str(scripts))
        self.isolated_home = Path(self.temp.name) / "home"
        (self.isolated_home / ".config" / "lifeos").mkdir(parents=True)
        (self.isolated_home / ".config" / "lifeos" / "install.json").write_text(
            json.dumps({"installPath": str(self.runtime.parent)}), encoding="utf-8"
        )
        # lifeconn 从 <installPath>/server/runtime/config.json 取 Token 与端口
        (self.runtime.parent / "server").mkdir(parents=True, exist_ok=True)
        target = self.runtime.parent / "server" / "runtime"
        if not target.exists():
            target.symlink_to(self.runtime)
        self._home = os.environ.get("HOME")
        os.environ["HOME"] = str(self.isolated_home)

    def tearDown(self) -> None:
        if self._home is not None:
            os.environ["HOME"] = self._home
        super().tearDown()

    def payload_file(self, name: str, body: dict) -> str:
        path = Path(self.temp.name) / name
        path.write_text(json.dumps(body, ensure_ascii=False), encoding="utf-8")
        return str(path)

    def run_finctl(self, *argv: str) -> tuple[int, dict]:
        """服务端的访问日志也走 stdout，取最后一行 JSON 才是命令回执。"""
        import finctl
        buffer = io.StringIO()
        with contextlib.redirect_stdout(buffer):
            code = finctl.main(list(argv))
        lines = [line for line in buffer.getvalue().splitlines() if line.startswith("{")]
        self.assertTrue(lines, f"finctl 没有输出 JSON 回执：{buffer.getvalue()[:200]}")
        return code, json.loads(lines[-1])

    def test_expense_receipt_carries_a_real_display(self) -> None:
        spend = self.payload_file("spend.json", {"accountName": "微信支付", "category": {"name": "餐饮"}})
        code, receipt = self.run_finctl("expense", "--title", "午饭", "--amount", "38", "--payload-file", spend)
        self.assertEqual(code, 0)
        self.assertEqual(receipt["display"], "✓ ¥38.00 午饭 · 微信支付 · 餐饮",
                         "回执必须印出账户与分类——用户扫一眼就能否决推断错的那两个字段")

    def test_unknown_account_is_refused_before_the_packet_leaves(self) -> None:
        """主数据护栏：未知账户必须在本地被拒，不发包。"""
        bogus = self.payload_file("bogus.json", {"accountName": "不存在的账户"})
        code, payload = self.run_finctl("expense", "--title", "午饭", "--amount", "38", "--payload-file", bogus)
        self.assertEqual(code, 2)
        self.assertIn("不存在", payload["message"])

    def test_correction_and_void_change_the_symbol(self) -> None:
        spend = self.payload_file("spend.json", {"accountName": "微信支付", "category": {"name": "餐饮"}})
        _, created = self.run_finctl("expense", "--title", "打车", "--amount", "38", "--payload-file", spend)
        payload = Path(self.temp.name) / "correct.json"
        payload.write_text(
            json.dumps({"title": "打车", "amount": 45, "kind": "expense", "accountName": "微信支付"}),
            encoding="utf-8",
        )

        code, corrected = self.run_finctl("correct", "--id", created["id"], "--payload-file", str(payload))
        self.assertEqual(code, 0)
        self.assertEqual(corrected["display"], "↻ ¥45.00 打车 · 微信支付 · 餐饮")

        code, voided = self.run_finctl("void", "--id", created["id"], "--reason", "记错了")
        self.assertEqual(code, 0)
        self.assertEqual(voided["display"], "✗ ¥45.00 打车 · 微信支付 · 餐饮")

    def test_voided_transfer_is_not_rendered_as_a_successful_transfer(self) -> None:
        """这条曾经是错的：撤销掉的转账显示 ⇄，与成功的转账一字不差。"""
        config = self.configuration()
        accounts = [item["name"] for item in config["accounts"] if not item.get("deletedAt")]
        category = next(item["name"] for item in config["categories"] if not item.get("deletedAt"))
        self.assertGreaterEqual(len(accounts), 2, "种子主数据至少需要两个账户")
        transfer = self.payload_file(
            "transfer.json",
            {"fromAccountName": accounts[0], "toAccountName": accounts[1], "category": {"name": category}},
        )
        _, created = self.run_finctl(
            "transfer", "--title", "还信用卡", "--amount", "3000", "--payload-file", transfer
        )
        self.assertEqual(created["display"],
                         f"⇄ ¥3000.00 还信用卡 · {accounts[0]}→{accounts[1]} · {category}",
                         "转账必须画出两端方向——只印一个账户名看不出是转出还是转入")

        _, voided = self.run_finctl("void", "--id", created["id"], "--reason", "转错了")
        self.assertEqual(voided["display"],
                         f"✗ ¥3000.00 还信用卡 · {accounts[0]}→{accounts[1]} · {category}")

    def test_cross_domain_write_is_refused_before_the_packet_leaves(self) -> None:
        code, payload = self.run_finctl("request", "POST", "/v1/time/segments")
        self.assertEqual(code, 2)
        self.assertIn("/v1/fin/*", payload["message"])


if __name__ == "__main__": unittest.main()
