"""
[INPUT]: 依赖临时 runtime、lifeos_node_server 应用工厂和标准库 HTTP 客户端。
[OUTPUT]: 对外提供 P0 双账本 health、fail-closed 配置、Host、Bearer、防嵌入响应头与旧路径拒绝回归测试。
[POS]: server 的 HTTP 核心验收；全部测试使用随机端口和临时账本，绝不触及生产 51440 或 59418。
[PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
"""

from __future__ import annotations

import http.client
import json
import socket
import subprocess
import sys
import tempfile
import threading
import unittest
from pathlib import Path

from core.config import write_config
from core.httpd import SHARED_READONLY, Response, Route, create_server
from core.static_files import StaticFiles
from domains.finance.routes_read import ROUTES as FIN_READ_ROUTES
from domains.finance.routes_write import ROUTES as FIN_WRITE_ROUTES
from domains.time.routes import ROUTES as TIME_ROUTES
from lifeos_node_server import create_application


SERVER_ROOT = Path(__file__).resolve().parent


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


class IsolatedLifeOS(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.runtime = Path(self.temporary.name) / "runtime"
        self.token = "lifeos-test-token-32-bytes-minimum"
        self.port = reserve_port()
        write_config(self.runtime / "config.json", {
            "host": "127.0.0.1", "port": self.port, "accessToken": self.token,
            "allowedHosts": [], "timezone": "", "timezoneSource": "system",
        })
        self.app = create_application(self.runtime)
        self.server = create_server(self.app)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)
        self.temporary.cleanup()

    def request(self, path: str, *, token: str | None = None, host: str | None = None) -> tuple[int, dict]:
        status, _, body = self.raw_request(path, token=token, host=host)
        return status, json.loads(body.decode("utf-8"))

    def raw_request(
        self, path: str, *, token: str | None = None, host: str | None = None,
    ) -> tuple[int, http.client.HTTPMessage, bytes]:
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        headers = {"Host": host or f"127.0.0.1:{self.port}"}
        if token is not None:
            headers["Authorization"] = f"Bearer {token}"
        connection.request("GET", path, headers=headers)
        response = connection.getresponse()
        body = response.read()
        response_headers = response.headers
        connection.close()
        return response.status, response_headers, body

    def test_all_response_paths_forbid_cross_origin_framing(self) -> None:
        self.app.register(Route(
            "GET",
            "/v1/test/weaken-frame-policy",
            lambda _request: Response(200, headers={
                "Content-Security-Policy": "frame-ancestors *",
                "X-Frame-Options": "SAMEORIGIN",
                "X-Content-Type-Options": "off",
            }),
        ))
        cases = (
            ("/dashboard/", None, 200),
            ("/v1/health", self.token, 200),
            ("/v1/health", "wrong", 401),
            ("/v1/test/weaken-frame-policy", self.token, 200),
        )
        for path, token, expected_status in cases:
            with self.subTest(path=path, expected_status=expected_status):
                status, headers, _ = self.raw_request(path, token=token)
                self.assertEqual(status, expected_status)
                self.assertEqual(headers.get_all("Content-Security-Policy"), ["frame-ancestors 'none'"])
                self.assertEqual(headers.get_all("X-Frame-Options"), ["DENY"])
                self.assertEqual(headers.get_all("X-Content-Type-Options"), ["nosniff"])

    def test_health_contains_two_independent_ledger_paths(self) -> None:
        status, payload = self.request("/v1/health", token=self.token)
        self.assertEqual(status, 200)
        self.assertEqual(payload["status"], "ok")
        self.assertEqual(Path(payload["domains"]["time"]["dbPath"]), self.runtime / "time" / "time.sqlite3")
        self.assertEqual(Path(payload["domains"]["finance"]["dbPath"]), self.runtime / "finance" / "finance.sqlite3")
        self.assertNotEqual(payload["domains"]["time"]["dbPath"], payload["domains"]["finance"]["dbPath"])

    def test_wrong_token_is_unauthorized(self) -> None:
        status, payload = self.request("/v1/health", token="wrong")
        self.assertEqual(status, 401)
        self.assertEqual(payload["error"], "unauthorized")

    def test_api_path_never_uses_spa_fallback(self) -> None:
        web_root = Path(self.temporary.name) / "web"
        web_root.mkdir()
        (web_root / "index.html").write_text("<main>LifeOS shell</main>", encoding="utf-8")
        self.app.static_files = StaticFiles(web_root)
        self.assertIsNotNone(self.app.static_files.resolve("/dashboard/time/day", accepts_gzip=False))
        status, payload = self.request("/v1/health")
        self.assertEqual(status, 401)
        self.assertEqual(payload["error"], "unauthorized")

    def test_untrusted_host_is_forbidden(self) -> None:
        status, payload = self.request("/v1/health", token=self.token, host="attacker.example")
        self.assertEqual(status, 403)
        self.assertEqual(payload["error"], "forbidden_host")

    def test_old_unprefixed_api_is_not_found(self) -> None:
        status, payload = self.request("/v1/segments", token=self.token)
        self.assertEqual(status, 404)
        self.assertEqual(payload["error"], "not_found")

    def test_route_contracts_are_namespaced_and_no_clock_endpoint_exists(self) -> None:
        contracts = set(TIME_ROUTES) | set(FIN_READ_ROUTES) | set(FIN_WRITE_ROUTES)
        self.assertIn(("GET", "/v1/time/segments"), contracts)
        self.assertIn(("POST", "/v1/fin/recurring/catchup"), contracts)
        self.assertNotIn(("GET", "/v1/clock"), contracts)
        self.assertTrue(all(path.startswith("/v1/time/") or path.startswith("/v1/fin/") for _, path in contracts))
        self.assertEqual(SHARED_READONLY, frozenset({("GET", "/v1/health")}))

    def test_both_new_databases_are_in_wal_mode(self) -> None:
        for database in (self.runtime / "time" / "time.sqlite3", self.runtime / "finance" / "finance.sqlite3"):
            import sqlite3
            connection = sqlite3.connect(database)
            try:
                self.assertEqual(connection.execute("PRAGMA journal_mode").fetchone()[0].lower(), "wal")
            finally:
                connection.close()

    def test_empty_token_process_exits_nonzero(self) -> None:
        bad_runtime = Path(self.temporary.name) / "bad-runtime"
        write_config(bad_runtime / "config.json", {
            "host": "127.0.0.1", "port": reserve_port(), "accessToken": "",
            "allowedHosts": [], "timezone": "", "timezoneSource": "system",
        })
        process = subprocess.run(
            [sys.executable, str(SERVER_ROOT / "lifeos_node_server.py"), "--runtime", str(bad_runtime)],
            cwd=SERVER_ROOT, text=True, capture_output=True, check=False, timeout=10,
        )
        self.assertNotEqual(process.returncode, 0)
        self.assertIn("accessToken", process.stderr)


if __name__ == "__main__":
    unittest.main()
