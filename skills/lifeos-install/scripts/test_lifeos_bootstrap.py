"""
[INPUT]: 只依赖同目录的 lifeos_bootstrap 与标准库 unittest/tempfile；不发网络、不读真实家目录、不碰任何安装。
[OUTPUT]: 对外提供引导安装的纯函数金样：地址白名单、Release 附件挑选、校验和解析、压缩包顶层目录、
          安装目标裁定、宿主自动探测、skill 覆盖护栏、health 归属判据与 Token 掩码。
[POS]: skills/lifeos-install/scripts 的回归底座。锁的是那些「放行一次就无法挽回」的判据——
       校验和对不上、压缩包越界、把别人的目录当成升级目标、把别人的 skill 覆盖掉——
       而不是命令行长什么样。副作用四处（下载/解压/部署/子进程）不在此文件覆盖范围内。
[PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
"""

from __future__ import annotations

import json
import tempfile
import unittest
import zipfile
from pathlib import Path

import lifeos_bootstrap as boot


def _release(*names: str, tag: str = "v1.0.0") -> dict:
    return {"tag_name": tag, "assets": [{"name": name, "browser_download_url": f"https://github.com/x/y/releases/download/{tag}/{name}"} for name in names]}


class NetworkBoundaryTests(unittest.TestCase):
    """下载地址是这条链上唯一的外部输入，白名单必须是硬判据而不是提示。"""

    def test_only_official_github_hosts_over_https_are_reachable(self) -> None:
        for url in (
            "https://api.github.com/repos/x/y",
            "https://github.com/x/y",
            # Release 附件 302 的真实落点（2026-08 实测）；objects 域是前代，保留兼容
            "https://release-assets.githubusercontent.com/github-production-release-asset/1?sig=x",
            "https://objects.githubusercontent.com/a",
        ):
            with self.subTest(url=url):
                self.assertEqual(boot.assert_allowed_url(url), url)
        for url in (
            "http://api.github.com/repos/x/y",          # 明文 http：中间人可直接改包
            "https://api.github.com.evil.example/x",    # 后缀伪装
            "https://raw.githubusercontent.com/x/y",    # 官方域但不是发布面
            "https://evil.example/lifeos.zip",
        ):
            with self.subTest(url=url):
                with self.assertRaises(boot.BootstrapError):
                    boot.assert_allowed_url(url)

    def test_a_version_tag_can_never_escape_the_releases_endpoint(self) -> None:
        """--version 是用户可控字符串，直接拼进 URL 就能拐去别的仓库甚至别的接口。"""
        self.assertTrue(boot.release_endpoint(None).endswith("/releases/latest"))
        endpoint = boot.release_endpoint("../../../../orgs/evil/repos")
        self.assertNotIn("/orgs/", endpoint)
        self.assertIn("%2F", endpoint)
        boot.assert_allowed_url(endpoint)


class ReleaseAssetTests(unittest.TestCase):
    def test_the_bootstrap_sidecar_is_never_mistaken_for_the_system_itself(self) -> None:
        """两个附件都叫 lifeos-*.zip；挑错的后果要到 health 才暴露，那时程序已经落盘了。"""
        archive, checksum = boot.select_release_assets(_release(
            "lifeos-1.0.0.zip", "lifeos-1.0.0.zip.sha256",
            "lifeos-install-skill-1.0.0.zip", "lifeos-install-skill-1.0.0.zip.sha256",
        ))
        self.assertEqual(archive["name"], "lifeos-1.0.0.zip")
        self.assertEqual(checksum["name"], "lifeos-1.0.0.zip.sha256")

    def test_an_archive_without_its_checksum_stops_the_install(self) -> None:
        with self.assertRaises(boot.BootstrapError) as caught:
            boot.select_release_assets(_release("lifeos-1.0.0.zip"))
        self.assertIn(".sha256", str(caught.exception))
        self.assertIn("校验和", caught.exception.advice)

    def test_an_ambiguous_or_empty_release_is_never_guessed(self) -> None:
        with self.assertRaises(boot.BootstrapError):
            boot.select_release_assets(_release("readme.txt"))
        with self.assertRaises(boot.BootstrapError):
            boot.select_release_assets(_release(
                "lifeos-1.0.0.zip", "lifeos-1.0.0.zip.sha256",
                "lifeos-1.0.1.zip", "lifeos-1.0.1.zip.sha256",
            ))


class ChecksumTests(unittest.TestCase):
    DIGEST = "a" * 64
    OTHER = "b" * 64

    def test_all_three_shasum_dialects_are_understood(self) -> None:
        for document in (
            f"{self.DIGEST}  lifeos-1.0.0.zip\n",                     # GNU / shasum 默认
            f"SHA256 (lifeos-1.0.0.zip) = {self.DIGEST}\n",           # BSD
            f"{self.DIGEST} *lifeos-1.0.0.zip\n",                     # 二进制模式的星号前缀
            f"{self.DIGEST}\n",                                       # 裸摘要，只有一条时才认
        ):
            with self.subTest(document=document.strip()):
                self.assertEqual(boot.parse_sha256_document(document, "lifeos-1.0.0.zip"), self.DIGEST)

    def test_a_digest_belonging_to_another_file_is_treated_as_absent(self) -> None:
        """拿另一个文件的摘要来校验本文件，比不校验更危险——它会给出「已验证」的错觉。"""
        document = f"{self.OTHER}  lifeos-install-skill-1.0.0.zip\n"
        with self.assertRaises(boot.BootstrapError):
            boot.parse_sha256_document(document, "lifeos-1.0.0.zip")

    def test_two_bare_digests_are_ambiguous_and_therefore_refused(self) -> None:
        with self.assertRaises(boot.BootstrapError):
            boot.parse_sha256_document(f"{self.DIGEST}\n{self.OTHER}\n", "lifeos-1.0.0.zip")


class ArchiveShapeTests(unittest.TestCase):
    def test_the_single_top_level_directory_is_discovered_not_hardcoded(self) -> None:
        """目录名带版本号，硬编码等于每发一版都要改脚本。"""
        self.assertEqual(boot.archive_root(["lifeos-1.0.0/", "lifeos-1.0.0/server/x.py"]), "lifeos-1.0.0")
        self.assertEqual(boot.archive_root(["lifeos-9.9.9/README.md"]), "lifeos-9.9.9")

    def test_zip_slip_members_are_refused_before_anything_is_written(self) -> None:
        for names in (
            ["lifeos-1.0.0/../../../../etc/passwd"],
            ["/etc/passwd"],
            ["lifeos-1.0.0/a", "../evil"],
        ):
            with self.subTest(names=names):
                with self.assertRaises(boot.BootstrapError):
                    boot.archive_root(names)

    def test_a_stray_top_level_file_or_a_second_root_stops_extraction(self) -> None:
        with self.assertRaises(boot.BootstrapError):
            boot.archive_root(["lifeos-1.0.0/server/x.py", "READ_ME_FIRST.txt"])
        with self.assertRaises(boot.BootstrapError):
            boot.archive_root(["lifeos-1.0.0/a", "lifeos-1.0.1/a"])


class ExtractionTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.sandbox = Path(self.temporary.name)
        self.addCleanup(self.temporary.cleanup)

    def test_unix_permission_bits_survive_extraction(self) -> None:
        """`zipfile.extractall` 丢弃权限位：ZIP 里 0755 的脚本解出来是 0644。

        用 unzip(1) 或访达解包的人拿到可执行文件，走引导安装的人拿不到——
        同一份发布物在两条路径上行为不同，而差异只在「直接执行脚本」那一刻才暴露。
        """
        package = self.sandbox / "lifeos-9.9.9.zip"
        with zipfile.ZipFile(package, "w") as bundle:
            for name, mode in (("lifeos-9.9.9/server/install.sh", 0o755), ("lifeos-9.9.9/README.md", 0o644)):
                info = zipfile.ZipInfo(name)
                info.external_attr = mode << 16
                bundle.writestr(info, "x")

        source = boot._extract(package, self.sandbox / "out")

        self.assertEqual(source.name, "lifeos-9.9.9")
        self.assertEqual((source / "server/install.sh").stat().st_mode & 0o777, 0o755)
        self.assertEqual((source / "README.md").stat().st_mode & 0o777, 0o644)

    def test_a_corrupt_archive_is_reported_in_plain_chinese(self) -> None:
        broken = self.sandbox / "broken.zip"
        broken.write_bytes(b"not a zip at all")
        with self.assertRaises(boot.BootstrapError) as caught:
            boot._extract(broken, self.sandbox / "out2")
        self.assertIn("截断", caught.exception.advice)


class InstallTargetTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.sandbox = Path(self.temporary.name)
        self.addCleanup(self.temporary.cleanup)

    def test_a_missing_or_empty_directory_is_a_fresh_install(self) -> None:
        self.assertEqual(boot.install_target_verdict(self.sandbox / "nope", False), "fresh")
        empty = self.sandbox / "empty"
        empty.mkdir()
        self.assertEqual(boot.install_target_verdict(empty, False), "fresh")

    def test_a_directory_with_content_is_never_silently_overwritten(self) -> None:
        """这条闸挡的是「用户随手指了个文档目录」，一次覆盖就是别人的资料没了。

        判据必须落在**错误正文**而不是 advice 上，也必须覆盖「目标里恰好就是 LifeOS」这一格：
        非空且没有程序本体时，即便拆掉本闸，后面那道「升级目标必须真的是 LifeOS」也会抛错，
        于是只测这一格的断言会以错误的理由通过——护栏被拆了，测试还是绿的。
        """
        occupied = self.sandbox / "occupied"
        (occupied / "sub").mkdir(parents=True)
        (occupied / "sub" / "notes.txt").write_text("别人的东西", encoding="utf-8")
        with self.assertRaises(boot.BootstrapError) as caught:
            boot.install_target_verdict(occupied, False)
        self.assertIn("已经有内容了", str(caught.exception))
        self.assertIn("--upgrade", caught.exception.advice)

        # 没有 --upgrade 时，即使目标里装的**正是** LifeOS 也必须拒绝：
        # 这一格只有本闸能拦，是它唯一无法被下游检查代偿的证据。
        existing = self.sandbox / "existing-lifeos"
        marker = existing / boot.INSTALL_MARKER
        marker.parent.mkdir(parents=True)
        marker.write_text("# lifeos", encoding="utf-8")
        with self.assertRaises(boot.BootstrapError) as caught:
            boot.install_target_verdict(existing, False)
        self.assertIn("已经有内容了", str(caught.exception))

    def test_upgrade_only_accepts_a_directory_that_really_holds_lifeos(self) -> None:
        """--upgrade 是覆盖复制，判据必须是程序本体在不在，而不是目录叫什么名字。"""
        stranger = self.sandbox / "stranger"
        stranger.mkdir()
        (stranger / "notes.txt").write_text("x", encoding="utf-8")
        with self.assertRaises(boot.BootstrapError):
            boot.install_target_verdict(stranger, True)
        marker = stranger / boot.INSTALL_MARKER
        marker.parent.mkdir(parents=True, exist_ok=True)
        marker.write_text("# lifeos", encoding="utf-8")
        self.assertEqual(boot.install_target_verdict(stranger, True), "upgrade")

    def test_a_plain_file_as_the_target_is_refused(self) -> None:
        target = self.sandbox / "afile"
        target.write_text("x", encoding="utf-8")
        with self.assertRaises(boot.BootstrapError):
            boot.install_target_verdict(target, False)


class HostDetectionTests(unittest.TestCase):
    """宿主必须是探出来的。写死任何一种，别的 Agent 用户就装不上。"""

    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.home = Path(self.temporary.name)
        self.addCleanup(self.temporary.cleanup)

    def test_only_existing_host_directories_are_reported_available(self) -> None:
        (self.home / ".claude/skills").mkdir(parents=True)
        (self.home / ".agents/skills").mkdir(parents=True)
        hosts = boot.detect_hosts(self.home)
        self.assertEqual({item["name"] for item in hosts}, {name for name, _ in boot.SKILL_HOSTS})
        self.assertEqual(
            sorted(path.name for path in boot.available_hosts(hosts)), ["skills", "skills"],
        )
        self.assertEqual(
            sorted(str(path.relative_to(self.home)) for path in boot.available_hosts(hosts)),
            [".agents/skills", ".claude/skills"],
        )

    def test_the_hermes_router_runs_only_when_hermes_is_actually_present(self) -> None:
        """SOUL.md 是 Hermes 独有的常驻人格层；对别的宿主跑路由安装器是去写坏它们的配置。"""
        (self.home / ".claude/skills").mkdir(parents=True)
        self.assertFalse(boot.router_requested(boot.detect_hosts(self.home)))
        (self.home / ".hermes/skills").mkdir(parents=True)
        self.assertTrue(boot.router_requested(boot.detect_hosts(self.home)))

    def test_no_host_at_all_yields_advice_instead_of_a_guess(self) -> None:
        self.assertEqual(boot.available_hosts(boot.detect_hosts(self.home)), [])
        self.assertIn("--skill-host", boot.host_advice())


class SkillOverwriteTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.sandbox = Path(self.temporary.name)
        self.addCleanup(self.temporary.cleanup)
        self.source = self.sandbox / "source" / "lifeos"
        self.source.mkdir(parents=True)
        (self.source / "SKILL.md").write_text("---\nname: lifeos\n---\n", encoding="utf-8")
        (self.source / "marker-new").write_text("new", encoding="utf-8")

    def test_a_foreign_skill_of_the_same_name_is_never_overwritten(self) -> None:
        host = self.sandbox / "host"
        squatter = host / "lifeos"
        squatter.mkdir(parents=True)
        (squatter / "SKILL.md").write_text("---\nname: someone-elses-lifeos\n---\n", encoding="utf-8")
        with self.assertRaises(boot.BootstrapError):
            boot.install_skill_into_host(host, self.source)
        self.assertIn("someone-elses", (squatter / "SKILL.md").read_text(encoding="utf-8"))

    def test_an_older_lifeos_skill_is_replaced_wholesale_not_merged(self) -> None:
        """叠加复制会把上一版残留的脚本留在目录里，而它们照样会被 import。"""
        host = self.sandbox / "host"
        previous = host / "lifeos"
        previous.mkdir(parents=True)
        (previous / "SKILL.md").write_text("---\nname: lifeos\n---\n", encoding="utf-8")
        (previous / "stale-script.py").write_text("旧版残留", encoding="utf-8")
        installed = boot.install_skill_into_host(host, self.source)
        self.assertTrue((installed / "marker-new").is_file())
        self.assertFalse((installed / "stale-script.py").exists())


class HealthOwnershipTests(unittest.TestCase):
    """「端口上有人以 200 应答」证明不了那是本次安装——判据是双 dbPath 的归属。"""

    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.runtime = Path(self.temporary.name) / "app/server/runtime"
        self.runtime.mkdir(parents=True)
        self.addCleanup(self.temporary.cleanup)

    def _payload(self, time_path: Path, finance_path: Path) -> dict:
        return {"domains": {"time": {"dbPath": str(time_path)}, "finance": {"dbPath": str(finance_path)}}}

    def test_both_ledgers_inside_this_installation_is_the_only_clean_verdict(self) -> None:
        payload = self._payload(self.runtime / "time/time.sqlite3", self.runtime / "finance/finance.sqlite3")
        self.assertEqual(boot.health_problems(payload, self.runtime), [])

    def test_a_ledger_belonging_to_another_installation_is_reported(self) -> None:
        elsewhere = Path(self.temporary.name) / "other/server/runtime"
        payload = self._payload(self.runtime / "time/time.sqlite3", elsewhere / "finance/finance.sqlite3")
        problems = boot.health_problems(payload, self.runtime)
        self.assertEqual(len(problems), 1)
        self.assertIn("finance", problems[0])

    def test_a_health_body_without_dbpaths_is_a_problem_not_a_pass(self) -> None:
        self.assertEqual(len(boot.health_problems({}, self.runtime)), 2)
        self.assertEqual(len(boot.health_problems({"domains": {"time": {}, "finance": None}}, self.runtime)), 2)


class SecretTests(unittest.TestCase):
    """Token 一旦被插进异常消息或日志就再也收不回来，而插入点无法穷举。"""

    def test_the_token_never_appears_through_str_or_repr_or_formatting(self) -> None:
        secret = boot.Secret("super-secret-token")
        self.assertNotIn("super-secret-token", f"{secret} {secret!r} {[secret]} {json.dumps(str(secret))}")

    def test_subprocess_output_is_scrubbed_before_it_reaches_the_user(self) -> None:
        """安装脚本会把含 Token 的面板地址打到 stdout，原样转发就是泄漏。"""
        secret = boot.Secret("super-secret-token")
        noisy = "Dashboard: http://127.0.0.1:59418/dashboard/?token=super-secret-token"
        self.assertNotIn("super-secret-token", boot.scrub(noisy, secret))
        self.assertEqual(boot.scrub(noisy, None), noisy)

    def test_the_dashboard_url_is_the_one_deliberate_exit(self) -> None:
        """唯一允许出现明文的地方；缺了它用户就登不进面板，这正是首装必卡的那一步。"""
        self.assertIn("super-secret-token", boot.dashboard_url(59418, boot.Secret("super-secret-token")))


class PointerTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.sandbox = Path(self.temporary.name)
        self.addCleanup(self.temporary.cleanup)

    def test_a_missing_or_broken_pointer_yields_advice_instead_of_a_default(self) -> None:
        """猜一个默认路径然后对着它卸载或体检，是拿别人的安装赌。"""
        missing = self.sandbox / "nope.json"
        with self.assertRaises(boot.BootstrapError) as caught:
            boot.resolve_install_root(None, missing)
        self.assertIn("--install-path", caught.exception.advice)
        broken = self.sandbox / "broken.json"
        broken.write_text("{不是 json", encoding="utf-8")
        with self.assertRaises(boot.BootstrapError):
            boot.resolve_install_root(None, broken)
        empty = self.sandbox / "empty.json"
        empty.write_text(json.dumps({"installPath": ""}), encoding="utf-8")
        with self.assertRaises(boot.BootstrapError):
            boot.resolve_install_root(None, empty)

    def test_an_explicit_path_wins_over_the_pointer(self) -> None:
        pointer = self.sandbox / "pointer.json"
        pointer.write_text(json.dumps({"installPath": str(self.sandbox / "from-pointer")}), encoding="utf-8")
        self.assertEqual(
            boot.resolve_install_root(str(self.sandbox / "explicit"), pointer),
            (self.sandbox / "explicit").resolve(),
        )


if __name__ == "__main__":
    unittest.main()
