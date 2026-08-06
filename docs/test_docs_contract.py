"""
[INPUT]: 依赖仓库内 server 安装脚本、lifeos_node_server.py 的 Ledger 布线、core.audit 的快照写盘、
         domains.finance.constants 与 domains.time.constants 的真实常量，以及 docs/ 下四份中文手册与 README.md。
[OUTPUT]: 对外提供用户手册与代码现实的同构断言：路径、端口、目录布局、以及手册里每一条「做不到」的声明。
[POS]: docs 的唯一自证机制。手册是代码的产物，而代码变了手册不会自己变——本项目已经栽过一次
       （FinOS 的 docs/api.md 被实测认定失实，只能整篇作废）。所以「已知问题」里每一条否定式声明，
       这里都要有一条断言把它钉在源码上：功能一旦被实现，测试先红，逼人回来改手册，而不是让用户
       读着一份骗人的边界说明去托付一年的记录。
[PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
"""

from __future__ import annotations

import re
import sys
import unittest
from pathlib import Path

DOCS = Path(__file__).resolve().parent
ROOT = DOCS.parent
SERVER = ROOT / "server"
sys.path.insert(0, str(SERVER))

from domains.finance.constants import MVP_RECURRING_PAUSED, MVP_SINGLE_CURRENCY  # noqa: E402
from domains.finance.routes_read import ROUTES as FINANCE_READ_ROUTES  # noqa: E402
from domains.finance.routes_write import ROUTES as FINANCE_WRITE_ROUTES  # noqa: E402
from domains.time.constants import OVERLONG_SEGMENT_MINUTES  # noqa: E402
from domains.time.routes import ROUTES as TIME_ROUTES  # noqa: E402

INSTALL_GUIDE = DOCS / "安装指南.md"
BACKUP_GUIDE = DOCS / "备份与恢复.md"
KNOWN_ISSUES = DOCS / "已知问题.md"
READ_ME = ROOT / "README.md"
# 中文 README 是发布物里给用户看的那一份，与英文 README 同样受私货扫描与路径存在性约束——
# 两份轮流更新时，漏改的那一份正是用户会照着走的那一份。
READ_ME_ZH = ROOT / "README.zh-CN.md"
USER_DOCS = (READ_ME, READ_ME_ZH, INSTALL_GUIDE, BACKUP_GUIDE, KNOWN_ISSUES)


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def flatten(text: str) -> str:
    """折叠换行与缩进，让跨行的 Python 调用能用一条平铺正则命中。"""
    return re.sub(r"\s+", " ", text)


class DocumentedPathsExist(unittest.TestCase):
    """手册里点名的每一个仓库文件都必须真实存在——写错文件名是最廉价也最常见的失实。"""

    def test_referenced_repository_files_exist(self):
        pattern = re.compile(r"(?:server|skills)/[A-Za-z0-9_./-]+\.(?:sh|py|txt)")
        # runtime/ 下的东西是安装器现场生成的，仓库里本就没有；它们的正确性由 InstallContractMatchesScripts 管。
        referenced = {
            match for path in USER_DOCS for match in pattern.findall(read(path))
            if not match.startswith("server/runtime/")
        }
        self.assertTrue(referenced, "手册里一个仓库文件都没引用，说明正则或手册出了问题")
        for relative in sorted(referenced):
            with self.subTest(relative=relative):
                self.assertTrue((ROOT / relative).exists(), f"手册引用了不存在的文件：{relative}")


class InstallContractMatchesScripts(unittest.TestCase):
    """安装位置、端口与全局指针写错一个字，用户就会照着手册把自己引到别处。"""

    def setUp(self):
        self.installer = read(SERVER / "install_and_start_lifeos_node.sh")
        self.guide = read(INSTALL_GUIDE)

    def test_default_port_matches_installer(self):
        match = re.search(r"port=\$\{LIFEOS_PORT:-(\d+)\}", self.installer)
        self.assertIsNotNone(match, "安装器里找不到默认端口的定义")
        self.assertIn(match.group(1), self.guide, "安装指南写的默认端口与安装器不一致")

    def test_pointer_path_matches_installer(self):
        self.assertIn("$HOME/.config/lifeos/install.json", self.installer)
        self.assertIn("~/.config/lifeos/install.json", self.guide)

    def test_setup_only_switch_is_the_one_the_guide_teaches(self):
        """指南教用户先备料后装自启；备料开关一旦改名，指南那一步就变成死命令。"""
        self.assertIn("LIFEOS_SETUP_ONLY", self.installer)
        self.assertIn("LIFEOS_SETUP_ONLY=1", self.guide)

    def test_ready_banner_matches_installer(self):
        """指南把安装器的输出原样抄给了用户当「你会看到」。原话变了，用户会以为自己装失败了。"""
        banner = re.search(r"printf '%s\\n' '(── LifeOS [^']+ ──)'", self.installer)
        self.assertIsNotNone(banner, "安装器不再打印就绪横幅，安装指南第 5 步的『你会看到』必须重写")
        self.assertIn(banner.group(1), self.guide)

    def test_launch_agent_success_line_matches_guide(self):
        """自启装完那一句是用户唯一的成功信号，指南照抄了它的固定前半句。

        后半句含解释器绝对路径，逐机不同，所以只锁到 label 为止——再往后抄就是抄了一台机器的偶然。
        """
        agent = read(SERVER / "install_launch_agent.sh")
        label = re.search(r"^label=(\S+)$", agent, re.MULTILINE)
        message = re.search(r'"(已安装[^"$]*)\$\{label\}', agent)
        self.assertIsNotNone(label, "自启安装器里找不到 LaunchAgent label")
        self.assertIsNotNone(message, "自启安装器不再打印成功提示，安装指南第 6 步必须重写")
        self.assertIn(f"{message.group(1)}{label.group(1)}", self.guide)

    def test_retired_timeos_port_is_never_taught(self):
        for path in USER_DOCS:
            with self.subTest(doc=path.name):
                self.assertNotIn("51440", read(path), "手册不得把已退役的旧 TimeOS 端口教给用户")


class RuntimeLayoutMatchesServer(unittest.TestCase):
    """备份教的是「拷哪个目录」。目录布局是从 Ledger 接线推导出来的，不能靠记忆。"""

    def setUp(self):
        self.wiring = flatten(read(SERVER / "lifeos_node_server.py"))
        self.backup = read(BACKUP_GUIDE)

    def ledgers(self) -> dict[str, tuple[str, str]]:
        pattern = re.compile(
            r'Ledger\( ?"(?P<name>\w+)", runtime_dir / "(?P<domain>[^"]+)" / "(?P<db>[^"]+)", '
            r'runtime_dir / "(?P=domain)" / "(?P<audit>[^"]+)" ?\)'
        )
        return {m.group("name"): (f"{m.group('domain')}/{m.group('db')}", f"{m.group('domain')}/{m.group('audit')}")
                for m in pattern.finditer(self.wiring)}

    def test_both_ledger_files_are_documented(self):
        ledgers = self.ledgers()
        self.assertEqual(set(ledgers), {"time", "finance"}, "解析不到两本账本的接线")
        for name, (db_path, audit_path) in ledgers.items():
            with self.subTest(ledger=name):
                self.assertIn(db_path, self.backup, f"备份手册没写 {name} 账本的真实位置")
                self.assertIn(audit_path, self.backup, f"备份手册没写 {name} 的审计目录")

    def test_snapshot_directory_name_matches_audit_module(self):
        audit = read(SERVER / "core" / "audit.py")
        match = re.search(r'snapshots = ledger\.audit_root / "([^"]+)"', audit)
        self.assertIsNotNone(match, "core/audit.py 里找不到快照目录的定义")
        self.assertIn(f"audit/{match.group(1)}", self.backup)
        self.assertIn(f"audit/{match.group(1)}", read(KNOWN_ISSUES))

    def test_attachment_directory_name_matches_finance_service(self):
        service = read(SERVER / "domains" / "finance" / "service.py")
        match = re.search(r'relative = Path\("([^"]+)"\) / transaction_id', service)
        self.assertIsNotNone(match, "finance/service.py 里找不到附件目录的定义")
        self.assertIn(f"finance/{match.group(1)}/", self.backup)

    def test_wal_sidecars_are_taught(self):
        """WAL 是「只拷单个 .sqlite3 会丢数据」这条警告的全部理由；模式变了警告就得改写。"""
        self.assertIn("PRAGMA journal_mode=WAL", read(SERVER / "core" / "sqlite.py"))
        self.assertIn("-wal", self.backup)
        self.assertIn("-shm", self.backup)


class KnownIssuesStayTrue(unittest.TestCase):
    """《已知问题》里每一条否定式声明都在这里挂钩源码：功能被实现时先红的是测试，不是用户的信任。"""

    def setUp(self):
        self.issues = read(KNOWN_ISSUES)
        self.routes = tuple(path for _, path in TIME_ROUTES + FINANCE_READ_ROUTES + FINANCE_WRITE_ROUTES)

    def test_no_restore_endpoint_exists(self):
        offenders = [path for path in self.routes if "restore" in path or "rollback" in path]
        self.assertEqual(offenders, [], "已经有恢复端点了，《已知问题》第 1/6 条必须重写")

    def test_snapshots_are_never_reclaimed(self):
        """无保留策略是一条磁盘承诺。一旦有人加了回收，手册的「只增不减」立刻变成谎言。"""
        audit = read(SERVER / "core" / "audit.py")
        for reclaim in ("unlink(", "rmtree(", "retention"):
            with self.subTest(reclaim=reclaim):
                self.assertNotIn(reclaim, audit, "core/audit.py 出现了快照回收，《已知问题》第 5 条必须重写")

    def test_finance_exports_are_reports_only(self):
        exports = {path for path in self.routes if path.startswith("/v1/fin/export")}
        self.assertEqual(
            exports, {"/v1/fin/export/xlsx", "/v1/fin/export/tax-report"},
            "财务导出面变了，《已知问题》第 7 条（报表不是备份）必须重写",
        )

    def test_time_domain_has_no_import_endpoint(self):
        offenders = [path for _, path in TIME_ROUTES if "import" in path]
        self.assertEqual(offenders, [], "时间域有导入端了，《已知问题》第 8 条必须重写")

    def test_single_currency_and_recurring_are_still_closed(self):
        self.assertTrue(MVP_SINGLE_CURRENCY, "多币种开了，《已知问题》第 9 条必须重写")
        self.assertTrue(MVP_RECURRING_PAUSED, "周期账目开了，《已知问题》第 10 条必须重写")

    def test_overlong_threshold_matches_the_hours_users_are_told(self):
        self.assertEqual(OVERLONG_SEGMENT_MINUTES % 60, 0, "阈值不再是整小时，手册的说法需要改写")
        self.assertIn(f"{OVERLONG_SEGMENT_MINUTES // 60} 小时", self.issues)

    def test_uninstaller_still_refuses_to_delete_data(self):
        """「卸载不删数据」是手册反复给出的承诺，也是用户敢按下卸载的唯一理由。"""
        uninstaller = read(SERVER / "uninstall_lifeos.sh")
        self.assertIn("--purge-data", uninstaller)
        self.assertIn("拒绝自动清除双账本", uninstaller)


class BilingualReadmesStayInSync(unittest.TestCase):
    """两份 README 是同一件事的两个语种，漂移的那一刻起就有一半读者被指错路。

    只锁「会让用户走错」的那几样：版本号、技能目录名、图片资源、彼此的互链。文案不锁——
    中文版本来就该说得比英文版更贴近用户，逐字对齐反而会逼出翻译腔。
    """

    def setUp(self):
        self.pair = {"README.md": read(READ_ME), "README.zh-CN.md": read(READ_ME_ZH)}

    def test_both_teach_the_current_version(self):
        version = read(ROOT / "VERSION").strip()
        for name, text in self.pair.items():
            with self.subTest(doc=name):
                self.assertIn(f"lifeos-install-skill-{version}.zip", text, "安装话术里的引导包版本落后于 VERSION")
                self.assertIn(f"lifeos-{version}.zip", text, "下载指引里的主包版本落后于 VERSION")

    def test_both_teach_the_current_skill_directory(self):
        """技能目录改过一次名；两份 README 里任何一处旧名都会让用户把技能装进不存在的地方。"""
        for name, text in self.pair.items():
            with self.subTest(doc=name):
                self.assertIn("zzm-lifeos-install", text)
                self.assertNotRegex(text, r"skills/lifeos-install|~/\.claude/skills/lifeos\b")

    def test_both_link_to_each_other_and_to_existing_assets(self):
        self.assertIn("README.zh-CN.md", self.pair["README.md"], "英文 README 没有给出中文版入口")
        self.assertIn("README.md", self.pair["README.zh-CN.md"], "中文 README 没有给出英文版入口")
        for name, text in self.pair.items():
            for asset in re.findall(r"docs/assets/[A-Za-z0-9_.-]+\.svg", text):
                with self.subTest(doc=name, asset=asset):
                    self.assertTrue((ROOT / asset).is_file(), f"README 引用了不存在的图片：{asset}")


class DocsCarryNoSecrets(unittest.TestCase):
    """手册是要进发布 ZIP 的。这里复刻 make_release.sh 的两条内容规则，让失误在写手册时就红。"""

    def test_no_real_token_or_home_path_leaks(self):
        # 规则字面量拆开拼装，否则本文件自己就会命中自己定义的规则（与 make_release.sh 同一手法）。
        home_path = re.compile("/" + "Users" + "/" + r"[A-Za-z0-9._-]+/")
        token_query = re.compile(r"\?to" + r"ken=[A-Za-z0-9_-]{32,}")
        for path in USER_DOCS:
            text = read(path)
            with self.subTest(doc=path.name):
                self.assertIsNone(home_path.search(text), "手册里出现了真实家目录绝对路径，发布扫描会拒包")
                self.assertIsNone(token_query.search(text), "手册里出现了疑似真实 Token，发布扫描会拒包")


class DocsMapMatchesTerrain(unittest.TestCase):
    """GEB SEVERE-002：docs/ 的 L2 成员清单漏一个文件，地图就不再等于地形。"""

    def test_l2_lists_every_member(self):
        catalog = read(DOCS / "CLAUDE.md")
        members = sorted(
            item.name for item in DOCS.iterdir()
            if item.is_file() and item.name != "CLAUDE.md" and not item.name.startswith(".")
        )
        self.assertTrue(members, "docs/ 是空的")
        for name in members:
            with self.subTest(member=name):
                self.assertIn(name, catalog, f"docs/CLAUDE.md 没有登记成员 {name}")


if __name__ == "__main__":
    unittest.main()
