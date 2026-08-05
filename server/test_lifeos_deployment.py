"""
[INPUT]: 依赖 _lifeos_test_support 的仓库路径与一次性回环端口、core.config、部署与发布脚本的排除真实 runtime
         的隔离副本、临时 HOME，以及标准库 HTTP/ZIP/正则客户端与 make_release.sh 的 --print-release-paths 白名单。
[OUTPUT]: 对外提供部署门禁回归：空 Token 拒启、端口被无法认亲者占用即拒装、全局指针指向别处即拒装、
          SETUP_ONLY 备料不启动且当面交付面板地址、LaunchAgent 的 XML 转义/解释器固化/fail-closed 清理、
          双账本 health 认亲、原子写入中间态的 .gitignore 覆盖、按版本命名的发布物与校验和、
          引导 skill 小包、ZIP 私货扫描，以及 CI 端口纪律步骤的存在性。
[POS]: server 测试套件里「安装与发布门禁」这一关注点；Skill 金样在 test_lifeos_skill_golden.py，
       迁移回滚在 test_lifeos_migration_rehearsal.py。绝不解析旧指针、生产 runtime 或现役端口，
       所有安装、启动和发布副作用均局限在 TemporaryDirectory。
[PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
"""

from __future__ import annotations

import hashlib
import http.client
import json
import os
import re
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time
import unittest
import zipfile
from pathlib import Path, PurePosixPath
from typing import Iterator
from unittest.mock import patch

from _lifeos_test_support import (
    DEPLOYMENT_SUITE_SOURCES,
    PROTECTED_DEVELOPMENT_PORT,
    REPOSITORY_ROOT,
    SERVER_ROOT,
    reserve_test_port,
)
from core.config import write_config


INSTALLER = Path("server/install_and_start_lifeos_node.sh")
LAUNCH_AGENT_INSTALLER = Path("server/install_launch_agent.sh")
RELEASE_SCRIPT = Path("make_release.sh")
# 发布物按版本命名，版本真源是仓库根的 VERSION；测试从同一份真源取名，
# 免得改一次版本号要同时改脚本与断言两处，而漏改的那处会以「文件不存在」的形式伪装成别的故障。
RELEASE_VERSION = (REPOSITORY_ROOT / "VERSION").read_text(encoding="utf-8").strip()
RELEASE_ARCHIVE = Path(f"dist/lifeos-{RELEASE_VERSION}.zip")
RELEASE_TREE_NAME = f"lifeos-{RELEASE_VERSION}"
INSTALL_SKILL_ARCHIVE = Path(f"dist/lifeos-install-skill-{RELEASE_VERSION}.zip")
FORBIDDEN_RELEASE_NAMES = frozenset({
    "config.json",
    "connection-info.txt",
    "time.sqlite3",
    "finance.sqlite3",
    "openclaw_finance_tools.json",
})
# 字面量拆开拼装，免得这份测试自己成为「发布物含本机绝对路径」的命中样本。
HOME_PATH_PATTERN = re.compile(b"/" + b"Users" + b"/" + rb"[A-Za-z0-9._-]+/")
# 生产端口只能在 P7 用户在场窗口接触；raw string 里必须是单反斜杠 `\.`，`\\.` 会退化成恒真断言。
PRODUCTION_PORT_TARGET = r"127\.0\.0\.1:(?:51440|59418)"
INTERNAL_ONLY_DOCUMENTS = ("implementation-notes.md", "implementation-report.md")
# 哨兵 Token 必须短于凭证扫描器的 32 位门槛，否则这份测试自己会被当成泄漏的真 Token。
SENTINEL_TOKEN = "lifeos-launch-agent-sentinel"


def _ignore_live_runtime(directory: str, names: list[str]) -> set[str]:
    """测试副本永不读取 LifeOS 已启用后的双账本、配置或附件。"""
    try: relative = Path(directory).resolve().relative_to(REPOSITORY_ROOT.resolve())
    except ValueError: return set()
    if relative == Path("server/runtime"):
        return {name for name in names if name in {"config.json", "connection-info.txt"}}
    if relative in {Path("server/runtime/time"), Path("server/runtime/finance")}:
        return {name for name in names if name != ".gitkeep"}
    return set()


def repository_copy(destination: Path) -> Path:
    """复制可执行代码到演练沙箱，不携带 Git、构建物、缓存或真实 runtime。"""
    shutil.copytree(
        REPOSITORY_ROOT,
        destination,
        ignore=lambda directory, names: shutil.ignore_patterns(".git", "__pycache__", "*.pyc", "dist", "node_modules")(directory, names) | _ignore_live_runtime(directory, names),
    )
    return destination


def read_ci_workflow(case: unittest.TestCase) -> str:
    """读 CI 定义；发布包里没有 .github，此时跳过而不是崩在 FileNotFoundError。

    这些断言检的是**仓库卫生**（端口纪律、依赖安装、skills 测试是否真的被执行），
    在用户拿到的发布 ZIP 里没有意义。而 test_lifeos_deployment.py 本身在白名单内，
    首发用户一跑自检就会撞上 FileNotFoundError——发布物无法自证，
    而 CI 的 release job 只从 ZIP 复跑 test_lifeos_http_core.py，永远发现不了。
    仓库内 ci.yml 存在，断言照常执行，因此这个 skip 不会把门禁本身跳掉。
    """
    workflow = REPOSITORY_ROOT / ".github/workflows/ci.yml"
    if not workflow.is_file():
        case.skipTest("发布包不含 .github/workflows/ci.yml；CI 卫生断言只在源码仓库内有意义。")
    return workflow.read_text(encoding="utf-8")


class IsolatedDeploymentTests(unittest.TestCase):
    """每例独立复制仓库与 HOME，防止安装器或发布器越过演练边界。"""

    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.sandbox = Path(self.temporary.name)
        self.install_root = repository_copy(self.sandbox / "lifeos-install")
        self.isolated_home = self.sandbox / "home"
        self.processes: list[subprocess.Popen[str]] = []

    def tearDown(self) -> None:
        for process in reversed(self.processes):
            self._stop_process(process)
        self.temporary.cleanup()

    def environment(self, *, port: int | None = None) -> dict[str, str]:
        """只导入常规进程环境，并显式覆盖所有 LifeOS 部署输入。"""
        environment = os.environ.copy()
        environment.pop("LIFEOS_PRODUCTION_SWITCH", None)
        environment["HOME"] = str(self.isolated_home)
        environment["LIFEOS_INSTALL_PATH"] = str(self.install_root)
        environment["LIFEOS_ISOLATED_HOME"] = "1"
        if port is not None:
            environment["LIFEOS_PORT"] = str(port)
        else:
            environment.pop("LIFEOS_PORT", None)
        return environment

    def run_installer(self, *, port: int, timeout: float = 15) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            ["bash", str(self.install_root / INSTALLER)],
            cwd=self.install_root,
            env=self.environment(port=port),
            text=True,
            capture_output=True,
            check=False,
            timeout=timeout,
        )

    def test_empty_token_rejects_install_startup(self) -> None:
        port = reserve_test_port()
        config = self.install_root / "server/runtime/config.json"
        config.write_text(
            json.dumps({
                "host": "127.0.0.1",
                "port": port,
                "accessToken": "",
                "allowedHosts": [],
                "timezone": "",
                "timezoneSource": "system",
            }),
            encoding="utf-8",
        )
        os.chmod(config, 0o600)

        result = self.run_installer(port=port)

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("accessToken", result.stderr)
        self.assertTrue((self.isolated_home / ".config/lifeos/install.json").is_file())

    def test_installer_refuses_a_port_held_by_an_unidentifiable_service(self) -> None:
        """放行判据从「现在是不是 P7」换成「这个端口上的是不是我自己」。

        旧判据是阶段闸门：59418 一律拒绝、其余端口一律放行。它保护的是施工期的开发机，
        对首发用户完全反向——粉丝要的就是 59418，于是首次安装 100% 撞墙。
        真正该拦的从来不是端口号，而是「端口上蹲着一个我认不出来的服务」：
        覆盖它等于拿别人的账本赌，而 plist 的 KeepAlive 会把冲突放大成无限重启。
        判据必须跑在任何写盘之前，否则拒绝的那条路径上会留下半套安装。
        """
        port = reserve_test_port()
        squatter = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        squatter.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        squatter.bind(("127.0.0.1", port))
        squatter.listen(1)
        try:
            result = self.run_installer(port=port)
        finally:
            squatter.close()

        self.assertEqual(result.returncode, 2, result.stdout)
        self.assertIn("无法认亲的服务占用", result.stderr)
        self.assertFalse((self.isolated_home / ".config/lifeos/install.json").exists())
        self.assertFalse((self.install_root / "server/runtime/config.json").exists())

    def test_installer_refuses_when_the_global_pointer_names_another_install(self) -> None:
        """指针是「本机哪一套安装在服役」的唯一真源，指向别处时继续安装是静默改道。

        lifeconn 优先读指针，因此指针一旦改指，此后每条 timectl/finctl 写入都落进新副本，
        回执照常成功，而用户盯着的原面板上什么都不会多出来——这正是 P11④ 记录过的那类事故。
        """
        other = self.sandbox / "another-lifeos"
        other.mkdir()
        pointer = self.isolated_home / ".config/lifeos/install.json"
        pointer.parent.mkdir(parents=True, exist_ok=True)
        pointer.write_text(json.dumps({"installPath": str(other)}) + "\n", encoding="utf-8")

        result = self.run_installer(port=reserve_test_port())

        self.assertEqual(result.returncode, 2, result.stdout)
        self.assertIn("已有一套在服役的 LifeOS", result.stderr)
        self.assertIn(str(other), result.stderr)
        self.assertFalse((self.install_root / "server/runtime/config.json").exists())
        # 拒绝路径不得改动既有指针，否则用户重试时连「原来指向哪」都查不到了。
        self.assertEqual(json.loads(pointer.read_text(encoding="utf-8"))["installPath"], str(other))

    def test_setup_only_prepares_everything_and_hands_the_dashboard_address_to_the_user(self) -> None:
        """备料与常驻必须分离，且面板地址必须真的出现在屏幕上。

        自动化安装需要先把配置、指针与账本目录准备好，再由 LaunchAgent 拉起后台进程；
        前台启动会一直占住调用方，让安装流程无法继续。
        更要紧的是交付：此前安装器写完 0600 的 connection-info.txt 就一个字都不打印，
        用户面对 TokenGate 的输入框，既不知道 Token 存在也不知道去哪找——这是首装必卡的那一步。
        """
        port = reserve_test_port()
        environment = self.environment(port=port)
        environment["LIFEOS_SETUP_ONLY"] = "1"

        result = subprocess.run(
            ["bash", str(self.install_root / INSTALLER)],
            cwd=self.install_root, env=environment,
            text=True, capture_output=True, check=False, timeout=20,
        )

        self.assertEqual(result.returncode, 0, f"stdout={result.stdout} stderr={result.stderr}")
        config = self.install_root / "server/runtime/config.json"
        connection_info = self.install_root / "server/runtime/connection-info.txt"
        self.assertTrue(config.is_file() and connection_info.is_file())
        self.assertTrue((self.isolated_home / ".config/lifeos/install.json").is_file())
        token = json.loads(config.read_text(encoding="utf-8"))["accessToken"]
        self.assertIn(f"127.0.0.1:{port}/dashboard/?token={token}", result.stdout)
        self.assertIn("未启动服务", result.stdout)
        # 备料模式绝不能顺手把服务拉起来，否则调用方拿不回控制权。
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
            probe.settimeout(0.5)
            self.assertNotEqual(probe.connect_ex(("127.0.0.1", port)), 0, "SETUP_ONLY 不得启动服务")

    def test_isolated_installer_starts_and_health_identifies_both_ledgers(self) -> None:
        port = reserve_test_port()
        process = subprocess.Popen(
            ["bash", str(self.install_root / INSTALLER)],
            cwd=self.install_root,
            env=self.environment(port=port),
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            start_new_session=True,
        )
        self.processes.append(process)
        config_path = self.install_root / "server/runtime/config.json"
        payload = self._wait_for_health(port, config_path)

        self.assertEqual(payload["status"], "ok")
        domains = payload["domains"]
        time_path = Path(domains["time"]["dbPath"])
        finance_path = Path(domains["finance"]["dbPath"])
        runtime_root = self.install_root.resolve() / "server/runtime"
        self.assertEqual(time_path, runtime_root / "time/time.sqlite3")
        self.assertEqual(finance_path, runtime_root / "finance/finance.sqlite3")
        self.assertNotEqual(time_path, finance_path)
        self.assertTrue(time_path.is_file())
        self.assertTrue(finance_path.is_file())
        pointer = json.loads((self.isolated_home / ".config/lifeos/install.json").read_text(encoding="utf-8"))
        self.assertEqual(Path(pointer["installPath"]), self.install_root)
        connection_info = self.install_root / "server/runtime/connection-info.txt"
        self.assertTrue(connection_info.is_file())
        self.assertEqual(connection_info.stat().st_mode & 0o777, 0o600)
        self.assertIn(f"127.0.0.1:{port}/dashboard/?token=", connection_info.read_text(encoding="utf-8"))

    def test_launch_agent_installer_writes_lifeos_label_without_unbound_variable(self) -> None:
        port = reserve_test_port()
        write_config(self.install_root / "server/runtime/config.json", {
            "host": "127.0.0.1",
            "port": port,
            "accessToken": SENTINEL_TOKEN,
            "allowedHosts": [],
            "timezone": "",
            "timezoneSource": "system",
        })
        binaries = self.sandbox / "bin"
        binaries.mkdir()
        launchctl = binaries / "launchctl"
        calls = self.sandbox / "launchctl-calls.txt"
        launchctl.write_text(
            '#!/usr/bin/env bash\nprintf "%s\\n" "$*" >> "$LIFEOS_TEST_LAUNCHCTL_LOG"\n',
            encoding="utf-8",
        )
        launchctl.chmod(0o755)
        environment = self.environment()
        environment["PATH"] = f"{binaries}{os.pathsep}{environment['PATH']}"
        environment["LIFEOS_TEST_LAUNCHCTL_LOG"] = str(calls)
        result = subprocess.run(
            ["bash", str(self.install_root / LAUNCH_AGENT_INSTALLER)],
            cwd=self.install_root,
            env=environment,
            text=True,
            capture_output=True,
            check=False,
            timeout=15,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        plist = self.isolated_home / "Library/LaunchAgents/com.lifeos.node.plist"
        payload = plist.read_text(encoding="utf-8")
        self.assertIn("<string>com.lifeos.node</string>", payload)
        self.assertIn("<string>/bin/zsh</string>", payload)
        self.assertIn(str(self.install_root / "server/launch_lifeos_node_foreground.sh"), payload)
        self.assertIn(str(self.install_root / "server"), payload)
        self.assertIn(str(self.install_root / "server/logs/lifeos-node.launchd.err.log"), payload)
        self.assertIn("<string>Background</string>", payload)
        # 解释器必须在安装期定死进 plist。启动脚本原本硬编码 /usr/bin/python3，而用户是照文档用
        # PATH 上的 python3（Homebrew/pyenv）装的 openpyxl：前台跑导出正常，装完自启换了解释器，
        # 财务导出静默降级成 503，现象是「昨天能导出今天不能」且无任何线索指向解释器差异。
        self.assertIn("<key>LIFEOS_PYTHON</key>", payload)
        # 隔离运行只产出 plist，绝不注册进用户的 launchd 会话：GUI 域按 UID 划分，
        # 隔离 HOME 对它无效，bootout 会按 label 卸掉正在跑的真实服务。
        self.assertFalse(calls.exists(), "隔离 HOME 下不得调用 launchctl")
        self.assertIn("未注册", result.stdout)

    @unittest.skipUnless(shutil.which("plutil"), "plist 校验依赖 macOS 的 plutil")
    def test_launch_agent_escapes_xml_in_the_install_path_and_leaves_no_temporary(self) -> None:
        """plist 是 XML：安装路径里的 `&` 必须以实体写入，且任何路径都不留 .plist.tmp。

        `$root` 此前被裸插进 `<string>`，含 `&` 的安装路径产出的是非良构 XML：
        plutil 用一句英文 `unknown ampersand-escape sequence` 退出，LifeOS 侧一个字的
        诊断都没有；更糟的是 `~/Library/LaunchAgents/com.lifeos.node.plist.tmp` 就此长驻，
        而 uninstall_lifeos.sh 只删正式 plist、不认这个中间态。
        判据取自 plutil 把 plist 读回来的值：光看文本里有没有 `&amp;` 证明不了它能被 launchd 解析。
        """
        awkward_root = self.sandbox / "life&os-install"
        os.rename(self.install_root, awkward_root)
        self.install_root = awkward_root
        port = reserve_test_port()
        write_config(self.install_root / "server/runtime/config.json", {
            "host": "127.0.0.1",
            "port": port,
            "accessToken": SENTINEL_TOKEN,
            "allowedHosts": [],
            "timezone": "",
            "timezoneSource": "system",
        })

        result = subprocess.run(
            ["bash", str(self.install_root / LAUNCH_AGENT_INSTALLER)],
            cwd=self.install_root,
            env=self.environment(),
            text=True,
            capture_output=True,
            check=False,
            timeout=15,
        )

        self.assertEqual(result.returncode, 0, f"stdout={result.stdout} stderr={result.stderr}")
        plist = self.isolated_home / "Library/LaunchAgents/com.lifeos.node.plist"
        self.assertTrue(plist.is_file())
        self.assertFalse((plist.parent / "com.lifeos.node.plist.tmp").exists(), "成功路径也不得留下中间态")
        self.assertIn("&amp;", plist.read_text(encoding="utf-8"))
        for key, expected in (
            ("ProgramArguments.1", str(self.install_root / "server/launch_lifeos_node_foreground.sh")),
            ("WorkingDirectory", str(self.install_root / "server")),
            ("StandardErrorPath", str(self.install_root / "server/logs/lifeos-node.launchd.err.log")),
        ):
            readback = subprocess.run(
                ["plutil", "-extract", key, "raw", "-o", "-", str(plist)],
                text=True, capture_output=True, check=True, timeout=15,
            )
            self.assertEqual(readback.stdout.strip(), expected)
        # 解释器路径由安装期解析，不同机器不同（Homebrew / pyenv / CLT），因此断言的是它的
        # 可用性而非字面量：能执行、且真的是 3.9+，才配被 launchd 当成常驻进程的入口。
        interpreter = subprocess.run(
            ["plutil", "-extract", "EnvironmentVariables.LIFEOS_PYTHON", "raw", "-o", "-", str(plist)],
            text=True, capture_output=True, check=True, timeout=15,
        ).stdout.strip()
        self.assertTrue(os.access(interpreter, os.X_OK), f"plist 里的解释器不可执行：{interpreter}")
        version = subprocess.run(
            [interpreter, "-c", "import sys; print('%d.%d' % sys.version_info[:2])"],
            text=True, capture_output=True, check=True, timeout=15,
        ).stdout.strip()
        self.assertGreaterEqual(tuple(int(part) for part in version.split(".")), (3, 9))

    def test_launch_agent_reports_a_diagnosis_and_removes_the_temporary_when_lint_fails(self) -> None:
        """plist 校验失败是 fail-closed 的，但必须留下诊断、不能留下垃圾。

        用户拿到的原本只有 plutil 的英文原话；现在要求 LifeOS 自己说明「哪一步失败、
        正式 plist 有没有被改动、该去看什么」，并且 `.plist.tmp` 在任何退出路径上都被清掉。
        """
        port = reserve_test_port()
        write_config(self.install_root / "server/runtime/config.json", {
            "host": "127.0.0.1",
            "port": port,
            "accessToken": SENTINEL_TOKEN,
            "allowedHosts": [],
            "timezone": "",
            "timezoneSource": "system",
        })
        binaries = self.sandbox / "failing-bin"
        binaries.mkdir()
        stub = binaries / "plutil"
        stub.write_text(
            '#!/usr/bin/env bash\nprintf "%s\\n" "stub plutil refuses everything" >&2\nexit 1\n',
            encoding="utf-8",
        )
        stub.chmod(0o755)
        environment = self.environment()
        environment["PATH"] = f"{binaries}{os.pathsep}{environment['PATH']}"

        result = subprocess.run(
            ["bash", str(self.install_root / LAUNCH_AGENT_INSTALLER)],
            cwd=self.install_root,
            env=environment,
            text=True,
            capture_output=True,
            check=False,
            timeout=15,
        )

        self.assertEqual(result.returncode, 2, result.stdout)
        self.assertIn("未通过 plutil 校验", result.stderr)
        self.assertIn("LIFEOS_INSTALL_PATH=", result.stderr)
        self.assertIn("stub plutil refuses everything", result.stderr)
        agents = self.isolated_home / "Library/LaunchAgents"
        self.assertFalse((agents / "com.lifeos.node.plist").exists(), "校验失败不得写出正式 plist")
        self.assertEqual(
            sorted(path.name for path in agents.iterdir()), [],
            "失败路径必须清掉 .plist.tmp；uninstall_lifeos.sh 只删正式 plist，不认中间态",
        )

    def test_gitignore_covers_the_atomic_write_temporaries_that_carry_the_token(self) -> None:
        """两份原子写入的中间态与正式文件内容相同，必须同样进不了 Git。

        config.json 与 connection-info.txt 都是「先写同目录 `.<name>.<pid>.tmp` 再 replace」，
        前者是 accessToken 明文，后者是带 `?token=` 的面板地址。而 .gitignore 此前只列了两个
        正式文件名：进程被 SIGKILL 或掉电时留下的中间态是**未跟踪**文件，一次 `git add .`
        就把 Token 提交进历史，「Token 不进 Git」这条铁律的第一道防线在中间态上完全不设防。
        临时名一律不写死，而是让真正的写入器跑一遍、从它自己调用的 replace 上取回。
        """
        root = self.install_root
        self._make_clean_git_repository(root)
        config = root / "server/runtime/config.json"
        connection_info = root / "server/runtime/connection-info.txt"

        captured: dict[Path, bytes] = {}
        original_replace = Path.replace

        def spy(source: Path, target: Path) -> Path:
            captured[Path(source)] = Path(source).read_bytes()
            return original_replace(source, target)

        original_path = list(sys.path)
        original_argv = list(sys.argv)
        try:
            with patch.object(Path, "replace", spy):
                write_config(config, {
                    "host": "127.0.0.1",
                    "port": reserve_test_port(),
                    "accessToken": SENTINEL_TOKEN,
                    "allowedHosts": [],
                    "timezone": "",
                    "timezoneSource": "system",
                })
                # 安装脚本里的 connection-info 写入器是内嵌 heredoc，这里原样取出执行，
                # 于是观察到的就是生产代码自己算出来的临时名，而不是测试的猜测。
                sys.argv = ["connection-info-writer", str(SERVER_ROOT), str(config), str(connection_info)]
                exec(compile(self._installer_python_block("load_config"), str(INSTALLER), "exec"), {})
        finally:
            sys.path[:] = original_path
            sys.argv[:] = original_argv

        temporaries = sorted(captured)
        self.assertEqual(len(temporaries), 2, f"应当只观察到两次原子替换：{temporaries}")
        self.assertTrue(config.is_file() and connection_info.is_file())
        blobs = b"\n".join(captured[path] for path in temporaries)
        self.assertIn(SENTINEL_TOKEN.encode("utf-8"), blobs, "中间态确实携带 Token 明文")
        self.assertIn(f"?token={SENTINEL_TOKEN}".encode("utf-8"), blobs)

        for temporary in temporaries:
            temporary.write_bytes(captured[temporary])
            relative = temporary.relative_to(root).as_posix()
            ignored = subprocess.run(
                ["git", "check-ignore", "--", relative],
                cwd=root, text=True, capture_output=True, check=False, timeout=15,
            )
            self.assertEqual(ignored.returncode, 0, f"{relative} 未被 .gitignore 覆盖")
        status = subprocess.run(
            ["git", "status", "--porcelain"],
            cwd=root, text=True, capture_output=True, check=True, timeout=15,
        )
        self.assertEqual(status.stdout.strip(), "", f"原子写入的中间态仍出现在 git status：\n{status.stdout}")

    def test_installers_refuse_a_declared_isolation_that_is_not_real(self) -> None:
        """LIFEOS_ISOLATED_HOME=1 必须被核实，不能只是调用方的自我声明。

        忘记覆盖 HOME 的一次演练会把真实用户的 ~/.config/lifeos/install.json
        改指到副本：此后每条 timectl/finctl 写入都落进副本账本而回执照常成功，
        用户面板什么都不多，而生产目录的 uninstall 在指针认亲这步 exit 5。
        真相只能向操作系统要——passwd 里的 home 不受 HOME 环境变量影响。
        """
        import pwd
        real_home = pwd.getpwuid(os.getuid()).pw_dir
        for script in ("server/install_and_start_lifeos_node.sh", "server/install_launch_agent.sh"):
            with self.subTest(script=script):
                environment = self.environment(port=reserve_test_port())
                environment["HOME"] = real_home  # 声明隔离，实则没有
                result = subprocess.run(
                    ["bash", str(self.install_root / script)],
                    cwd=self.install_root, env=environment,
                    text=True, capture_output=True, check=False, timeout=15,
                )
                self.assertEqual(result.returncode, 2, result.stdout)
                self.assertIn("仍是真实用户目录", result.stderr)

    def test_release_zip_has_no_runtime_credentials_or_ledgers(self) -> None:
        release_root = repository_copy(self.sandbox / "release-clean")
        self._make_clean_git_repository(release_root)

        result = self._run_release(release_root)

        self.assertEqual(result.returncode, 0, result.stderr)
        archive = release_root / RELEASE_ARCHIVE
        self.assertTrue(archive.is_file())
        # 校验和随包发布，用户才有办法证明下载到的不是被中途换过的东西；
        # 引导 skill 也拿它做完整性判据，对不上就中止安装。
        checksum = release_root / f"{RELEASE_ARCHIVE}.sha256"
        self.assertTrue(checksum.is_file(), "发布物必须附带 .sha256 校验和")
        self.assertIn(hashlib.sha256(archive.read_bytes()).hexdigest(), checksum.read_text(encoding="utf-8"))
        # 引导 skill 要能被粉丝单独拿到，否则「装了 skill 才能装 LifeOS」是个死循环。
        skill_archive = release_root / INSTALL_SKILL_ARCHIVE
        self.assertTrue(skill_archive.is_file(), "必须单独打出引导 skill 小包")
        with zipfile.ZipFile(skill_archive) as package:
            skill_names = package.namelist()
        self.assertTrue(any(name.endswith("lifeos-install/SKILL.md") for name in skill_names), skill_names)
        with zipfile.ZipFile(archive) as package:
            names = package.namelist()
            leaked_paths = [
                name for name in names
                if not name.endswith("/") and HOME_PATH_PATTERN.search(package.read(name))
            ]
        leaked = [name for name in names if Path(name).name in FORBIDDEN_RELEASE_NAMES]
        self.assertEqual(leaked, [], f"发布物包含敏感运行态：{leaked}")
        self.assertFalse(any("/attachments/" in name for name in names))
        self.assertEqual(leaked_paths, [], f"发布物包含本机绝对路径：{leaked_paths}")
        internal = [name for name in names if Path(name).name in INTERNAL_ONLY_DOCUMENTS]
        self.assertEqual(internal, [], f"内部施工记录不得进入发布物：{internal}")

    def test_released_manuals_never_point_at_files_left_out_of_the_package(self) -> None:
        """手册里的每一条相对引用都必须在 ZIP 里解析得到。

        仓库内的链接检查证明不了这件事：`implementation-report.md` 在仓库里存在、
        在发布物里被白名单刻意排除（它含本机绝对路径与私有主机名）。于是 README 指着它
        在开发机上一切正常，用户解开 ZIP 却扑空——而这恰恰是最没耐心的那批读者的第一站。
        判据必须落在发布物内部，不能落在工作树上。
        """
        release_root = repository_copy(self.sandbox / "release-links")
        self._make_clean_git_repository(release_root)
        self.assertEqual(self._run_release(release_root).returncode, 0)

        with zipfile.ZipFile(release_root / RELEASE_ARCHIVE) as package:
            members = {name[len(RELEASE_TREE_NAME) + 1:].rstrip("/") for name in package.namelist()}
            manuals = {
                name for name in package.namelist()
                if name.endswith(".md") and "/web-dashboard/" not in name
            }
            self.assertGreater(len(manuals), 3, "发布物里没扫到手册，这道闸形同虚设")
            broken = []
            for name in sorted(manuals):
                relative = PurePosixPath(name[len(RELEASE_TREE_NAME) + 1:])
                text = package.read(name).decode("utf-8")
                for target in re.findall(r"\]\(([^)#?]+)\)", text):
                    if target.startswith(("http://", "https://", "mailto:", "#", "<")):
                        continue
                    resolved = PurePosixPath(os.path.normpath(relative.parent / target))
                    if str(resolved) not in members:
                        broken.append(f"{relative} → {target}")
        self.assertEqual(broken, [], f"发布物里的手册指向了不存在的成员：{broken}")

    def test_release_refuses_an_untracked_runtime_secret(self) -> None:
        release_root = repository_copy(self.sandbox / "release-secret")
        self._make_clean_git_repository(release_root)
        secret = release_root / "server/runtime/config.json"
        secret.write_text('{"accessToken":"must-never-release"}\n', encoding="utf-8")

        result = self._run_release(release_root)

        self.assertEqual(result.returncode, 2)
        self.assertIn("发布物含敏感运行态", result.stderr)
        self.assertFalse((release_root / RELEASE_ARCHIVE).exists())

    def test_release_zip_replays_core_contracts_after_isolated_extraction(self) -> None:
        release_root = repository_copy(self.sandbox / "release-replay")
        self._make_clean_git_repository(release_root)
        result = self._run_release(release_root)
        self.assertEqual(result.returncode, 0, result.stderr)
        extracted = self.sandbox / "extracted-release"
        with zipfile.ZipFile(release_root / RELEASE_ARCHIVE) as package:
            package.extractall(extracted)
        extracted_root = extracted / RELEASE_TREE_NAME
        environment = os.environ.copy()
        environment["HOME"] = str(self.sandbox / "zip-home")
        environment.pop("LIFEOS_INSTALL_PATH", None)
        environment.pop("LIFEOS_PORT", None)

        replay = subprocess.run(
            [sys.executable, "-m", "unittest", "-v", "test_lifeos_http_core"],
            cwd=extracted_root / "server",
            env=environment,
            text=True,
            capture_output=True,
            check=False,
            timeout=30,
        )

        self.assertEqual(replay.returncode, 0, f"stdout={replay.stdout}\nstderr={replay.stderr}")

    def test_deployment_suite_and_ci_keep_both_production_ports_out_of_test_targets(self) -> None:
        # 套件按关注点拆成三份 + 一份共享底座，端口纪律必须对整套成立，
        # 否则「把连接目标搬去另一个文件」就能绕过这道闸。
        sources = {
            name: (SERVER_ROOT / name).read_text(encoding="utf-8")
            for name in DEPLOYMENT_SUITE_SOURCES
        }
        ci = read_ci_workflow(self)

        self.assertEqual(len(sources), 4)
        for name, source in sources.items():
            with self.subTest(source=name):
                self.assertNotRegex(source, PRODUCTION_PORT_TARGET)
        self.assertIn("if: always()", ci)
        # 断言的是「CI 里存在端口纪律这一步」，而不是端口字面量本身——后者会让 CI 的扫描器自我误伤。
        self.assertIn("Assert production ports are never connection targets", ci)
        self.assertIn("Assert no private paths or credentials in released sources", ci)
        for port in (51440, PROTECTED_DEVELOPMENT_PORT):
            self.assertIn(str(port), ci)
        self.assertNotRegex(ci, PRODUCTION_PORT_TARGET)

    def test_dashboard_source_never_disables_the_type_checker(self) -> None:
        """`@ts-nocheck` 是发布链上唯一能让崩溃绕过 CI 的开关，必须在源码里绝迹。

        面板构建是 `tsc -b && vite build`：类型错误本该在 CI 就红。但 OverviewPage 与
        SettingsPage 为满足单文件 ≤800 行被拆成碎片后，每个碎片都被贴上 `@ts-nocheck`——
        于是 charts.tsx 少写一行 import 也能构建通过，直到用户点开「财务状况」才白屏。
        这道闸看的是文件是否存在该指令，不看它当时是否恰好没掩盖 bug。
        """
        sources = sorted((REPOSITORY_ROOT / "server/web-dashboard/src").rglob("*.ts")) + sorted(
            (REPOSITORY_ROOT / "server/web-dashboard/src").rglob("*.tsx")
        )
        self.assertGreater(len(sources), 50, "面板源码没被扫到，这道闸形同虚设")
        muted = [
            str(path.relative_to(REPOSITORY_ROOT))
            for path in sources
            if "@ts-nocheck" in path.read_text(encoding="utf-8")
        ]
        self.assertEqual(muted, [], f"以下面板源码关闭了类型检查：{muted}")

    def test_committed_dashboard_build_matches_its_own_source(self) -> None:
        """`server/web/` 是被服务、被打包的发布物；它落后于 src/ 时没有任何东西会红。

        Python 静态层只读 `server/web/`，make_release.sh 也直接收录它，而安装脚本里
        没有任何 npm/vite 步骤。于是「改了前端源码但忘记 npm run build」的后果是：
        服务端照常下发新字段，用户加载的仍是旧包，两侧各自都对，功能在最后一跳消失。
        判据取自内容而非 mtime——git 不保留 mtime，时间戳判据一次 checkout 就失效。
        """
        source_root = REPOSITORY_ROOT / "server/web-dashboard/src"
        digest_file = REPOSITORY_ROOT / "server/web/dashboard/source-digest.txt"
        self.assertTrue(
            digest_file.exists(),
            "缺少 server/web/dashboard/source-digest.txt：请在 server/web-dashboard 执行 npm run build",
        )

        # 与 mirror-dashboard-index.mjs 的 IGNORED_ENTRIES 必须同口径：
        # 只哈希进版本库的源码，工具缓存与 .DS_Store 在干净 checkout 里并不存在。
        ignored = {".impeccable", ".DS_Store", ".git"}
        paths = sorted(
            path for path in source_root.rglob("*")
            if path.is_file() and not (ignored & set(path.relative_to(source_root).parts))
        )
        self.assertGreater(len(paths), 50, "面板源码没被扫到，这道闸形同虚设")
        digest = hashlib.sha256()
        for path in paths:
            digest.update(path.relative_to(source_root).as_posix().encode("utf-8"))
            digest.update(b"\0")
            digest.update(path.read_bytes())
            digest.update(b"\0")

        self.assertEqual(
            digest.hexdigest()[:16],
            digest_file.read_text(encoding="utf-8").strip(),
            "已提交的面板产物不是由当前 src/ 构建的：请在 server/web-dashboard 执行 npm run build 并提交 server/web/",
        )

    def test_ci_installs_the_declared_dependency_and_runs_skill_tests(self) -> None:
        """CI 必须真的安装唯一 pip 依赖，并真的跑 skills 下的测试。

        此前两件事都没有：CI 没有任何 pip install，openpyxl 于是必然缺席，
        导出测试无条件断言 200，四条矩阵腿全败，release job 因 needs 永不执行——
        这道门禁看起来在守着发布，实际上从来没有绿过。
        skills/ 下的 timeclock/lifeconn 回归也从不执行：删掉 timeclock 的
        fail-closed 安全闸仍能全绿通过。
        导出正例现在按依赖可用性分支（裸机 skip、装了就真跑），
        因此这条断言是它不退化成「永远 skip」的唯一保证。
        """
        ci = read_ci_workflow(self)
        requirements = REPOSITORY_ROOT / "server/requirements.txt"

        self.assertTrue(requirements.is_file(), "缺少 server/requirements.txt")
        self.assertIn("openpyxl", requirements.read_text(encoding="utf-8"))
        self.assertIn("pip install -r requirements.txt", ci)
        self.assertIn("skills/lifeos/scripts", ci)

    def test_release_whitelist_ships_deliverables_without_internal_records(self) -> None:
        listing = subprocess.run(
            ["bash", str(REPOSITORY_ROOT / RELEASE_SCRIPT), "--print-release-paths"],
            cwd=REPOSITORY_ROOT,
            text=True,
            capture_output=True,
            check=True,
            timeout=15,
        )
        whitelist = [line for line in listing.stdout.splitlines() if line]

        for internal in INTERNAL_ONLY_DOCUMENTS:
            self.assertNotIn(internal, whitelist)
        for required in (
            "README.md", "CLAUDE.md", "VERSION", "docs", "skills",
            "server/core", "server/domains", "server/web", "server/web-dashboard",
            "server/uninstall_lifeos.sh", "server/_port_probe.sh",
            "server/test_lifeos_http_core.py",
            # 部署套件拆成三份后，任何一份掉出白名单，用户在 ZIP 里跑自检都会 ImportError。
            "server/_lifeos_test_support.py",
            "server/test_lifeos_deployment.py",
            "server/test_lifeos_skill_golden.py",
            "server/test_lifeos_migration_rehearsal.py",
            "server/test_finance_attachment_upload.py",
        ):
            self.assertIn(required, whitelist)

    @staticmethod
    def _installer_python_block(marker: str) -> str:
        """取出安装脚本里内嵌的某一段 Python 写入器（引号 heredoc，原样交给解释器）。"""
        source = (REPOSITORY_ROOT / INSTALLER).read_text(encoding="utf-8")
        blocks = [block for block in re.findall(r"<<'PY'\n(.*?)\nPY\n", source, re.DOTALL) if marker in block]
        if len(blocks) != 1:
            raise AssertionError(f"安装脚本里含 {marker!r} 的内嵌写入器应当恰好一段，实际 {len(blocks)} 段")
        return blocks[0]

    def _wait_for_health(self, port: int, config_path: Path) -> dict[str, object]:
        """等待隔离节点完成首次双账本初始化，再认证读取 health。"""
        deadline = time.monotonic() + 10
        last_error: Exception | None = None
        while time.monotonic() < deadline:
            if config_path.is_file():
                token = json.loads(config_path.read_text(encoding="utf-8"))["accessToken"]
                try:
                    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=1)
                    connection.request(
                        "GET",
                        "/v1/health",
                        headers={
                            "Authorization": f"Bearer {token}",
                            "Host": f"127.0.0.1:{port}",
                        },
                    )
                    response = connection.getresponse()
                    body = response.read().decode("utf-8")
                    connection.close()
                    if response.status == 200:
                        return json.loads(body)
                    last_error = RuntimeError(f"health returned {response.status}: {body}")
                except (ConnectionError, OSError, json.JSONDecodeError) as error:
                    last_error = error
            time.sleep(0.05)
        process = self.processes[-1]
        stdout, stderr = process.communicate(timeout=1) if process.poll() is not None else ("", "")
        self.fail(f"隔离节点未通过 health：{last_error}; stdout={stdout!r}; stderr={stderr!r}")

    @staticmethod
    def _make_clean_git_repository(root: Path) -> None:
        commands: Iterator[list[str]] = iter((
            ["git", "init", "-q"],
            ["git", "config", "user.email", "lifeos-test@example.invalid"],
            ["git", "config", "user.name", "LifeOS isolated test"],
            ["git", "add", "."],
            ["git", "commit", "-qm", "isolated release fixture"],
        ))
        for command in commands:
            subprocess.run(command, cwd=root, check=True, capture_output=True, text=True)

    @staticmethod
    def _run_release(root: Path) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            ["bash", str(root / RELEASE_SCRIPT)],
            cwd=root,
            text=True,
            capture_output=True,
            check=False,
            timeout=30,
        )

    @staticmethod
    def _stop_process(process: subprocess.Popen[str]) -> None:
        if process.poll() is None:
            try:
                os.killpg(process.pid, signal.SIGTERM)
                process.wait(timeout=5)
            except (ProcessLookupError, subprocess.TimeoutExpired):
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                process.wait(timeout=5)
        process.communicate(timeout=1)


if __name__ == "__main__":
    unittest.main()
