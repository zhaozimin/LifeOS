"""
[INPUT]: 依赖 GitHub Release API（api.github.com）、发布物内的 server 安装/自启/卸载脚本，
         以及本机 `~/.config/lifeos/install.json` 指针；只用 Python 3.9+ 标准库，零第三方依赖。
[OUTPUT]: 对外提供 detect/install/status/uninstall 四个子命令，以及 Secret、资产挑选、校验和解析、
          压缩包顶层目录、指针/安装目标裁定、宿主探测、原子升级编排与 health 回滚。
[POS]: lifeos-install 的唯一实现。SKILL.md 只做意图判断，一切正确性——域白名单、sha256、目标占用、
       双 dbPath 归属、Token 不外泄——都在此裁定；它不 import lifeos skill 的任何脚本，
       因为引导阶段那套脚本还没落到本机。
[PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
"""

from __future__ import annotations
import argparse
import hashlib
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from pathlib import Path, PurePosixPath
from typing import Any, Iterable, Sequence
from lifeos_deploy import commit_upgrade, deploy, quiesce_upgrade, recover_interrupted_upgrade, restore_previous_upgrade, rollback_upgrade


REPOSITORY = "zhaozimin/LifeOS"
API_ROOT = "https://api.github.com"
RELEASES_PAGE = f"https://github.com/{REPOSITORY}/releases"
# 只认这几个域，除此之外的任何跳转都按劫持处理直接拒绝——「先跟过去再校验 sha256」
# 不成立，因为校验和也是同一次会话给的。Release 附件的 302 实测落在
# release-assets.githubusercontent.com（2026-08 对 v1.0.0 真实下载验证），
# objects.githubusercontent.com 是它的前代资产域，保留以兼容 GitHub 的灰度回切。
ALLOWED_HOSTS = (
    "api.github.com",
    "github.com",
    "release-assets.githubusercontent.com",
    "objects.githubusercontent.com",
)
DEFAULT_INSTALL_PATH = Path("~/Library/Application Support/LifeOS/app")
DEFAULT_PORT = 59418
POINTER_RELATIVE = Path(".config/lifeos/install.json")
# 宿主是一张表而不是一串 if：判据永远是「这个目录在不在」，新 Agent 出现时只加一行。
SKILL_HOSTS = (
    ("claude", ".claude/skills"),
    ("hermes", ".hermes/skills"),
    ("agents", ".agents/skills"),
    ("codex", ".codex/skills"),
    ("grok", ".grok/skills"),
)
# 只有 Hermes 有 SOUL.md 这层常驻人格；对别的宿主跑路由安装器等于去写坏它们的配置。
ROUTER_HOST = "hermes"
ASSET_PREFIX, ASSET_SUFFIX = "lifeos-", ".zip"
# lifeos-install-skill-<版本>.zip 同样匹配 lifeos-*.zip，但它只装引导 skill 自己。
# 选错的后果是把引导包当成整套系统解压进安装目录，而且直到 health 才会暴露。
SIDECAR_PREFIX = "lifeos-install-skill-"
HEALTH_DOMAINS = ("time", "finance")
# 「这个目录里到底是不是 LifeOS」的唯一判据，升级与卸载都靠它，不靠目录名。
INSTALL_MARKER = "server/lifeos_node_server.py"
# 记录技能的目录名带 zzm- 前缀：宿主的 skills/ 是所有来源共用的扁平命名空间，
# 一个叫 lifeos 的通名迟早撞上别人家的同名 skill，而撞上的后果是拒绝覆盖、整条安装中止。
SKILL_DIR_NAME = "zzm-lifeos"
# 改名之前发布过的目录名；升级时要认得出来才能退役，不然新旧两份一起留在触发面上。
LEGACY_SKILL_DIR_NAMES = ("lifeos", "lifeos-install")
OWN_SKILL_NAME_LINES = frozenset(
    {"name: zzm-lifeos", "name: zzm-lifeos-install", "name: lifeos", "name: lifeos-install"}
)
REQUIRED_MEMBERS = (
    "server/install_and_start_lifeos_node.sh",
    "server/install_launch_agent.sh",
    "server/uninstall_lifeos.sh",
    f"skills/{SKILL_DIR_NAME}/SKILL.md",
)
HEX_DIGITS = set("0123456789abcdef")

class BootstrapError(RuntimeError):
    """一切可预期失败都走这里：message 说清发生了什么，advice 说清用户下一步做什么。

    不带 advice 的失败等于把用户丢在原地，所以调用处应尽量给出下一步。
    """

    def __init__(self, message: str, advice: str = "") -> None:
        super().__init__(message)
        self.advice = advice


class Secret:
    """访问密钥只以此形态在进程内流转：str() 与 repr() 恒为掩码。

    Token 一旦被插进异常消息、日志行或调试打印就再也收不回来，而这些插入点无法穷举。
    因此把「明文只能从 reveal() 出去」做成类型层面的事实，比在每个打印点自觉更可靠。
    """

    __slots__ = ("_value",)

    def __init__(self, value: str) -> None:
        self._value = value

    def __str__(self) -> str:
        return "***"

    def __repr__(self) -> str:
        return "***"

    def reveal(self) -> str:
        return self._value

    def scrub(self, text: str) -> str:
        return text.replace(self._value, "***") if self._value else text


def scrub(text: str, secret: "Secret | None") -> str:
    """子进程输出一律经此层。安装器会把含 Token 的面板地址打到 stdout，直接转发就是泄漏。"""
    return secret.scrub(text) if secret is not None else text

def say(message: str) -> None:
    print(f"· {message}")


# ── GitHub 侧：地址白名单、Release 解析、校验和 ────────────────────────────────

def assert_allowed_url(url: str) -> str:
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme != "https" or parsed.hostname not in ALLOWED_HOSTS:
        raise BootstrapError(
            f"拒绝访问非 GitHub 官方地址：{url}",
            "只允许 " + "、".join(ALLOWED_HOSTS) + "。如果发布地址真的变了，请先人工核实，再改脚本里的 ALLOWED_HOSTS。",
        )
    return url


class _GuardedRedirect(urllib.request.HTTPRedirectHandler):
    """跟随重定向前先过白名单：附件下载必须跳一次，但只能跳到官方对象存储。"""

    def redirect_request(self, req: Any, fp: Any, code: int, msg: str, headers: Any, newurl: str) -> Any:
        assert_allowed_url(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def _open(url: str, *, timeout: float = 30.0) -> Any:
    # 关掉代理：代理能把 ZIP 和它的 sha256 一起换掉，而 https 直连至少让证书说话。
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), _GuardedRedirect())
    request = urllib.request.Request(assert_allowed_url(url), headers={"Accept": "application/vnd.github+json", "User-Agent": "lifeos-install"})
    return opener.open(request, timeout=timeout)


def release_endpoint(version: "str | None") -> str:
    if version:
        return f"{API_ROOT}/repos/{REPOSITORY}/releases/tags/{urllib.parse.quote(version, safe='')}"
    return f"{API_ROOT}/repos/{REPOSITORY}/releases/latest"

def fetch_release(version: "str | None" = None) -> dict:
    try:
        with _open(release_endpoint(version)) as response:
            raw = response.read()
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            target = f"版本 {version}" if version else "任何已发布版本"
            raise BootstrapError(
                f"GitHub 上找不到 {REPOSITORY} 的{target}。",
                f"到 {RELEASES_PAGE} 看一眼是否已经发布；如果只是想装某个旧版本，用 --version 指定实际存在的标签。",
            ) from None
        if exc.code in (403, 429):
            raise BootstrapError(
                "GitHub 暂时拒绝了请求，通常是匿名调用次数用完了。",
                "等一小时后重跑同一条命令即可；急用可以自己到发布页手工下载 ZIP。",
            ) from None
        raise BootstrapError(f"GitHub API 返回 HTTP {exc.code}。", "稍后重试；持续失败请检查本机网络或 GitHub 状态页。") from None
    except (OSError, urllib.error.URLError):
        raise BootstrapError("连不上 GitHub。", "检查网络与代理设置后重试；公司网络常见的是 https 被拦。") from None
    try:
        payload = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise BootstrapError("GitHub 返回的内容不是有效 JSON。", "多半是网络中间设备插了一页登录框；换个网络重试。") from None
    if not isinstance(payload, dict):
        raise BootstrapError("GitHub 返回的 Release 信息格式异常。", "稍后重试；持续出现请报告给 LifeOS 项目。")
    return payload


def select_release_assets(payload: dict) -> "tuple[dict, dict]":
    """从 Release 附件里挑出「整套系统的 ZIP」与它配套的 sha256。"""
    assets: dict = {}
    for item in payload.get("assets") or []:
        if not isinstance(item, dict):
            continue
        name, url = str(item.get("name") or ""), str(item.get("browser_download_url") or "")
        if name and url:
            assets[name] = url
    tag = str(payload.get("tag_name") or "未知版本")
    archives = sorted(
        name for name in assets
        if name.startswith(ASSET_PREFIX) and name.endswith(ASSET_SUFFIX) and not name.startswith(SIDECAR_PREFIX)
    )
    if not archives:
        raise BootstrapError(
            f"Release {tag} 里没有 lifeos-*.zip 安装包附件。",
            f"到 {RELEASES_PAGE} 确认这个版本是否真的带了安装包；也可能是发布还在上传中，过几分钟再试。",
        )
    if len(archives) > 1:
        raise BootstrapError(
            f"Release {tag} 里有多个候选安装包：{'、'.join(archives)}。",
            "用 --version 指定一个明确的版本；有歧义时脚本不猜该装哪一个。",
        )
    archive = archives[0]
    checksum = archive + ".sha256"
    if checksum not in assets:
        raise BootstrapError(
            f"Release {tag} 的 {archive} 没有配套的 {checksum}。",
            "没有校验和就无法证明下载没被掉包，安装到此为止；请让发布者补上校验和附件。",
        )
    return {"name": archive, "url": assets[archive], "tag": tag}, {"name": checksum, "url": assets[checksum]}


def _is_digest(value: str) -> bool:
    return len(value) == 64 and set(value.lower()) <= HEX_DIGITS


def parse_sha256_document(text: str, filename: str) -> str:
    """兼容 `shasum -a 256` 的两种输出与裸摘要；文件名对不上就当没找到。

    对不上而放行等于用另一个文件的摘要去校验本文件，那比不校验更危险。
    """
    bare: list = []
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if line.upper().startswith("SHA256 (") and ")" in line and "=" in line:
            named, _, digest = line.partition("=")
            name = named[named.index("(") + 1:named.rindex(")")].strip()
            digest = digest.strip()
            if _is_digest(digest) and PurePosixPath(name).name == filename:
                return digest.lower()
            continue
        parts = line.split()
        if len(parts) == 1 and _is_digest(parts[0]):
            bare.append(parts[0].lower())
            continue
        if len(parts) >= 2 and _is_digest(parts[0]) and PurePosixPath(parts[-1].lstrip("*")).name == filename:
            return parts[0].lower()
    if len(bare) == 1:
        return bare[0]
    raise BootstrapError(
        f"校验和文件里找不到 {filename} 对应的 sha256。",
        "这一版的校验和附件可能没传对；请到发布页确认，或换 --version 装另一个版本。",
    )


def digest_of(path: Path) -> str:
    hasher = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            hasher.update(block)
    return hasher.hexdigest()


# ── 压缩包与安装目标 ──────────────────────────────────────────────────────────

def archive_root(names: Iterable) -> str:
    """取出压缩包唯一的顶层目录名；顺带挡掉 zip slip 与散落顶层文件。

    目录名里带版本号，硬编码就等于每发一版都要改脚本，所以这里只认「唯一」这个结构事实。
    """
    roots, stray = set(), []
    for name in names:
        pure = PurePosixPath(name)
        if pure.is_absolute() or ".." in pure.parts:
            raise BootstrapError(f"压缩包里有越界成员：{name}", "这不是 LifeOS 的正常发布物，已中止解压；请重新下载或换一个版本。")
        parts = [part for part in pure.parts if part not in ("", ".")]
        if not parts:
            continue
        roots.add(parts[0])
        if len(parts) == 1 and not name.endswith("/"):
            stray.append(name)
    if stray:
        raise BootstrapError(
            f"压缩包顶层散落着文件：{'、'.join(sorted(stray)[:3])}",
            "LifeOS 发布物应当只有一个顶层目录；请确认下载的是 lifeos-<版本>.zip 而不是别的包。",
        )
    if len(roots) != 1:
        found = "、".join(sorted(roots)) or "（空包）"
        raise BootstrapError(f"压缩包的顶层目录不唯一：{found}", "请重新下载；文件可能在传输中被截断或拼接了。")
    return roots.pop()


def assert_release_layout(source: Path) -> None:
    missing = [member for member in REQUIRED_MEMBERS if not (source / member).exists()]
    if missing:
        raise BootstrapError(
            f"解压出来的目录缺少 {'、'.join(missing)}。",
            "这不像完整的 LifeOS 发布物；请换一个版本重试，或到发布页确认附件是否传全。",
        )


def install_target_verdict(target: Path, upgrade: bool) -> str:
    """返回 fresh 或 upgrade；任何「会把别人的东西盖掉」的情形一律拒绝。"""
    if target.is_symlink():
        raise BootstrapError(f"安装目标 {target} 是符号链接，拒绝跟随覆盖。", "请用 --install-path 指向真实安装目录。")
    if target.exists() and not target.is_dir():
        raise BootstrapError(f"安装目标 {target} 是一个文件，不是目录。", "换一个 --install-path，或先把这个文件挪走。")
    if not target.is_dir() or not any(target.iterdir()):
        return "fresh"
    if not upgrade:
        raise BootstrapError(
            f"安装目标 {target} 已经有内容了。",
            "如果这里就是你现有的 LifeOS，加 --upgrade 就地升级（两本账本、Token 与端口都会保留）；如果不是，请换一个 --install-path。",
        )
    if not (target / INSTALL_MARKER).is_file():
        raise BootstrapError(
            f"{target} 里没有 LifeOS 的程序本体，不能当成升级目标。",
            "--upgrade 只覆盖已有的 LifeOS 安装。请确认路径是否写错，或换一个空目录做全新安装。",
        )
    return "upgrade"


def pointer_install_path(pointer: Path) -> "Path | None":
    """只读全局指针；缺失表示未安装，存在但损坏则必须显式覆盖。"""
    if not pointer.exists(): return None
    try: payload = json.loads(pointer.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError): raise BootstrapError(f"全局指针 {pointer} 存在但无法解析，拒绝猜测正在服役的安装。", "什么都没有被写入。确实要改指本次安装时，加 --replace-pointer 重跑。") from None
    candidate = payload.get("installPath") if isinstance(payload, dict) else None
    if not isinstance(candidate, str) or not candidate: raise BootstrapError(f"全局指针 {pointer} 没有有效 installPath，拒绝覆盖。", "什么都没有被写入。确实要改指本次安装时，加 --replace-pointer 重跑。")
    return Path(candidate).expanduser().resolve()


def port_is_occupied(port: int, *, timeout: float = 1.0) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.settimeout(timeout)
        return probe.connect_ex(("127.0.0.1", port)) == 0


def port_answers_as_this_install(target: Path, port: int) -> bool:
    """端口上那个服务能否被本安装自己的 config 认亲——「有人以 200 应答」不是身份。"""
    try:
        configured_port, token = read_connection(target)
    except BootstrapError:
        return False
    if configured_port != port:
        return False
    try:
        payload = probe_health(port, token)
    except (OSError, urllib.error.URLError, json.JSONDecodeError, ValueError):
        return False
    return not health_problems(payload, target / "server" / "runtime")


def intended_port(target: Path, explicit: "int | None") -> int:
    """预检要用的端口：命令行 > 已有 config > 默认。升级时不指定端口就该沿用现有的那个。"""
    if explicit:
        return explicit
    try:
        return read_connection(target)[0]
    except BootstrapError:
        return DEFAULT_PORT


def preflight_local_conflicts(
    target: Path, port: int, verdict: str, *, pointer: Path, replace_pointer: bool
) -> None:
    """把「指针指向别的安装」与「端口被无法认亲的服务占用」这两道否决闸提到下载与写盘之前。

    这两条判据只需要一个指针文件和一次 TCP 连接，不依赖任何已部署的文件。让它们跑在 deploy
    之后没有技术必然性，代价却是每一次拒绝都在用户磁盘上留下一套没有 config、没有自启的半安装，
    而重跑时又会被「目标已有内容」挡回去——安装宪法要求任何拒绝都发生在第一次写盘之前。
    """
    resolved = target.expanduser().resolve()
    if not replace_pointer:
        serving = pointer_install_path(pointer)
        if serving and serving != resolved and (serving / INSTALL_MARKER).is_file():
            raise BootstrapError(
                f"本机已有一套在服役的 LifeOS：{pointer} 指向 {serving}。",
                "什么都没有被写进你的电脑。继续安装会把 Agent 的每一条记录改道到新目录，而原面板上"
                "什么都不会多出来，因此拒绝。确实要把服役安装换成本目录，加 --replace-pointer 重跑"
                "（原安装的两本账本不会被动）。",
            )
    if port_is_occupied(port) and not (verdict == "upgrade" and port_answers_as_this_install(target, port)):
        raise BootstrapError(
            f"端口 {port} 已被一个无法认亲的服务占用，拒绝安装。",
            "什么都没有被写进你的电脑。请先停止占用该端口的程序，或用 --port <其它端口> 重跑。",
        )


# ── Agent 宿主 ───────────────────────────────────────────────────────────────

def detect_hosts(home: Path) -> list:
    return [{"name": name, "path": str(home / relative), "present": (home / relative).is_dir()} for name, relative in SKILL_HOSTS]


def available_hosts(hosts: Iterable) -> list:
    return [Path(item["path"]) for item in hosts if item["present"]]


def router_requested(hosts: Iterable) -> bool:
    return any(item["present"] and item["name"] == ROUTER_HOST for item in hosts)


def host_advice() -> str:
    known = "、".join(f"~/{relative}" for _, relative in SKILL_HOSTS)
    return f"没有发现任何已知 Agent 宿主目录（{known}）。请确认你的 AI 客户端已安装，或安装时用 --skill-host <目录> 明确指定 skill 要放到哪里。"


def looks_like_lifeos_skill(path: Path) -> bool:
    """只认 SKILL.md 前言里的 `name:` 那一行，避免把同名的别人家 skill 当成自己的旧版本删掉。

    改名成 zzm-lifeos 之前发布过 `lifeos`/`lifeos-install`，升级路径要认得出它们才能退役掉，
    否则旧目录会连同新目录一起留在触发面上，两份描述几乎一样，宿主加载哪一份全凭运气。
    """
    try:
        text = (path / "SKILL.md").read_text(encoding="utf-8")
    except OSError:
        return False
    return any(line.strip() in OWN_SKILL_NAME_LINES for line in text.splitlines())


def install_skill_into_host(host_dir: Path, source: Path) -> Path:
    target = host_dir / source.name
    # 软链接要先看是不是链接再看存不存在：桥接工具（dbs-bridge 之流）把 skill 链进宿主是常态，
    # 而 exists() 会跟着链接走进源目录，rmtree 对符号链接则直接抛 OSError。
    if target.is_symlink():
        target.unlink()
    elif target.exists():
        if not looks_like_lifeos_skill(target):
            raise BootstrapError(
                f"{target} 已存在，但它不是 LifeOS 的 skill，拒绝覆盖。",
                "请人工确认那是什么、挪走之后重跑本命令。",
            )
        # 整目录换新而不是叠加：旧版本残留的脚本仍会被 import，出问题时极难看出来。
        shutil.rmtree(target)
    host_dir.mkdir(parents=True, exist_ok=True)
    shutil.copytree(source, target)
    return target


def retire_legacy_skills(host_dir: Path) -> list:
    """删掉改名前留在同一宿主里的 lifeos / lifeos-install。

    只删经 SKILL.md 认亲确实是本项目的那两个目录；别人家的同名 skill 一律不碰。不删的代价是
    新旧两份同时留在触发面上，而旧那份指向的脚本已经不再随发布更新。
    """
    retired = []
    for legacy in LEGACY_SKILL_DIR_NAMES:
        stale = host_dir / legacy
        try:
            if stale.is_symlink():
                if looks_like_lifeos_skill(stale):
                    stale.unlink()
                    retired.append(str(stale))
            elif stale.is_dir() and looks_like_lifeos_skill(stale):
                shutil.rmtree(stale)
                retired.append(str(stale))
        except OSError:
            continue
    return retired


# ── 本机安装状态 ─────────────────────────────────────────────────────────────

def resolve_install_root(explicit: "str | None", pointer: Path) -> Path:
    if explicit:
        return Path(explicit).expanduser().resolve()
    try:
        payload = json.loads(pointer.read_text(encoding="utf-8"))
        candidate = payload.get("installPath") if isinstance(payload, dict) else None
    except (OSError, json.JSONDecodeError):
        candidate = None
    if not isinstance(candidate, str) or not candidate:
        raise BootstrapError(
            f"没找到全局指针 {pointer}，不知道 LifeOS 装在哪。",
            "先跑 install 完成安装；如果你确实装过，用 --install-path 指出安装目录。",
        )
    return Path(candidate).expanduser().resolve()


def read_connection(root: Path) -> "tuple[int, Secret]":
    config = root / "server" / "runtime" / "config.json"
    try:
        payload = json.loads(config.read_text(encoding="utf-8"))
        port, token = payload["port"], payload["accessToken"]
    except (OSError, KeyError, TypeError, json.JSONDecodeError):
        raise BootstrapError(
            f"读不到 {config} 里的端口与访问密钥。",
            "这个文件由安装脚本生成，权限 0600。如果它不存在，说明安装没走完，请重跑 install。",
        ) from None
    if not isinstance(port, int) or not 1 <= port <= 65535 or not isinstance(token, str) or not token:
        raise BootstrapError(f"{config} 里的端口或访问密钥无效。", "请重跑 install 让安装脚本重新生成配置。")
    return port, Secret(token)


def _secret_quietly(root: Path) -> "Secret | None":
    """只为脱敏子进程输出而读；读不到就返回 None，不打断主流程也不报错。"""
    try:
        return read_connection(root)[1]
    except BootstrapError:
        return None


def read_version(root: Path) -> "str | None":
    try:
        return (root / "VERSION").read_text(encoding="utf-8").strip() or None
    except OSError:
        return None


def probe_health(port: int, token: Secret, *, timeout: float = 5.0) -> dict:
    request = urllib.request.Request(
        f"http://127.0.0.1:{port}/v1/health",
        headers={"Authorization": f"Bearer {token.reveal()}", "Host": f"127.0.0.1:{port}"},
    )
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def health_problems(payload: dict, runtime: Path) -> list:
    """双 dbPath 都必须落在这次安装的 runtime 内——「有人以 200 应答」证明不了那是本安装。"""
    problems: list = []
    domains = payload.get("domains")
    domains = domains if isinstance(domains, dict) else {}
    root = Path(runtime).expanduser().resolve()
    for name in HEALTH_DOMAINS:
        entry = domains.get(name)
        raw = entry.get("dbPath") if isinstance(entry, dict) else None
        if not raw:
            problems.append(f"health 没有报告 {name} 账本的位置")
            continue
        if root not in Path(str(raw)).expanduser().resolve().parents:
            problems.append(f"{name} 账本落在 {raw}，不在这次安装的 {root} 里")
    return problems


def wait_for_health(port: int, token: Secret, runtime: Path, *, seconds: float = 45.0) -> dict:
    deadline, reason = time.monotonic() + seconds, "服务始终没有应答"
    while True:
        try:
            payload = probe_health(port, token)
        except urllib.error.HTTPError as exc:
            reason = f"health 返回 HTTP {exc.code}" + ("（访问密钥与配置对不上）" if exc.code == 401 else "")
        except (OSError, urllib.error.URLError, ValueError):
            reason = "服务还没起来"
        else:
            problems = health_problems(payload, runtime)
            if not problems:
                return payload
            reason = "；".join(problems)
        if time.monotonic() >= deadline:
            raise BootstrapError(
                f"安装后的自检没有通过：{reason}。",
                f"跑 `python3 {Path(__file__).name} status` 看当前状态；服务日志在 <安装目录>/server/logs/ 下。",
            )
        time.sleep(1.0)


# ── 子进程 ───────────────────────────────────────────────────────────────────

def run_step(command: Sequence, cwd: Path, extra_env: "dict | None" = None) -> "tuple[int, str]":
    """返回退出码与合并输出，**不打印**。

    调用方必须先把 Token 拿到手再决定怎么打印这段输出：安装脚本成功时会把含 Token 的
    面板地址打到 stdout，原样转发就等于把密钥写进对话记录。
    """
    env = dict(os.environ)
    if extra_env:
        env.update(extra_env)
    try:
        completed = subprocess.run(list(command), cwd=str(cwd), env=env, capture_output=True, text=True)
    except OSError as exc:
        raise BootstrapError(f"无法执行 {command[0]}：{exc.strerror}。", "确认本机有 bash 与 python3；macOS 自带，通常是 PATH 被改过。") from None
    return completed.returncode, ((completed.stdout or "") + (completed.stderr or "")).strip()




# ── 子命令 ───────────────────────────────────────────────────────────────────

def command_detect(args: argparse.Namespace) -> int:
    hosts = detect_hosts(Path.home())
    report = {
        "command": "detect",
        "hosts": hosts,
        "available": [item["name"] for item in hosts if item["present"]],
        "installRouter": router_requested(hosts),
    }
    if not report["available"]:
        report["advice"] = host_advice()
    print(json.dumps(report, ensure_ascii=False))
    return 0

def command_install(args: argparse.Namespace) -> int:
    home = Path.home()
    target = Path(args.install_path).expanduser() if args.install_path else DEFAULT_INSTALL_PATH.expanduser()
    recover_interrupted_upgrade(target)
    verdict = install_target_verdict(target, args.upgrade)
    install_port = intended_port(target, args.port)
    # 三道否决闸（目标占用、指针冲突、端口占用）全部跑完才允许下载：它们只需要本机现状，
    # 排在 deploy 之后就等于用一套半安装换一条本可以早说的拒绝。
    preflight_local_conflicts(
        target,
        install_port,
        verdict,
        pointer=home / POINTER_RELATIVE,
        replace_pointer=args.replace_pointer,
    )
    say(f"安装目标：{target}（{'全新安装' if verdict == 'fresh' else '就地升级，保留现有账本与访问密钥'}）")

    archive, checksum = select_release_assets(fetch_release(args.version))
    say(f"发布版本 {archive['tag']}，安装包 {archive['name']}")
    staging = Path(tempfile.mkdtemp(prefix="lifeos-bootstrap-"))
    try:
        package = staging / archive["name"]
        _download(archive["url"], package)
        expected = parse_sha256_document(_download_text(checksum["url"]), archive["name"])
        if digest_of(package) != expected:
            raise BootstrapError(
                "下载到的安装包 sha256 与发布方公布的不一致，已中止安装。",
                "什么都没有被写进你的电脑。换个网络重试；反复不一致请立刻停手并报告给 LifeOS 项目。",
            )
        say("sha256 校验通过")
        source = _extract(package, staging / "unpacked")
        assert_release_layout(source)
        if verdict == "upgrade":
            quiesce_upgrade(target, install_port, port_is_occupied=port_is_occupied, run_step=run_step)
        try:
            deploy(source, target, verdict)
        except BaseException:
            if verdict == "upgrade": restore_previous_upgrade(target, run_step=run_step)
            raise
        say(f"程序本体已就位：{target}")
    finally:
        shutil.rmtree(staging, ignore_errors=True)

    setup_env = {"LIFEOS_SETUP_ONLY": "1", "LIFEOS_INSTALL_PATH": str(target)}
    if args.port:
        setup_env["LIFEOS_PORT"] = str(args.port)
    if args.replace_pointer:
        setup_env["LIFEOS_REPLACE_POINTER"] = "1"
    code, output = run_step(["bash", "server/install_and_start_lifeos_node.sh"], target, setup_env)
    secret = _secret_quietly(target)
    if code != 0:
        if verdict == "upgrade": restore_previous_upgrade(target, run_step=run_step)
        raise BootstrapError(
            "配置阶段失败，服务没有启动。",
            scrub(output, secret) or "安装脚本没有给出更多信息；请把这段输出发给 LifeOS 项目。",
        )
    say("配置、双账本目录与全局指针已生成")

    try:
        port, token = read_connection(target)
    except BaseException:
        if verdict == "upgrade": restore_previous_upgrade(target, run_step=run_step)
        raise
    # 自启的 plist 里要写死解释器绝对路径：装 openpyxl 的那个 python3 和 launchd 默认拿到的
    # /usr/bin/python3 往往不是同一个，差别只会在导出报表时以 503 的形态暴露。
    agent_env = {"LIFEOS_INSTALL_PATH": str(target), "LIFEOS_PYTHON": shutil.which("python3") or sys.executable}
    code, output = run_step(["bash", "server/install_launch_agent.sh"], target, agent_env)
    if code != 0:
        if verdict == "upgrade": restore_previous_upgrade(target, run_step=run_step)
        raise BootstrapError("开机自启安装失败。", scrub(output, token) or "请把这段输出发给 LifeOS 项目。")
    say("开机自启已安装（label com.lifeos.node）")

    try:
        wait_for_health(port, token, target / "server" / "runtime")
    except BaseException:
        if verdict == "upgrade": restore_previous_upgrade(target, run_step=run_step)
        raise
    if verdict == "upgrade": commit_upgrade(target)
    say("认证 health 通过：时间与财务两本账本都落在本次安装内")

    # 服务此刻已经常驻并自证过了：面板地址必须在这里交付，不能押在后面的宿主注入之后。
    # 注入是「锦上添花」，而密钥是用户唯一的入口——让一个装不进去的 skill 扣下密钥，
    # 等于把一套跑得好好的服务报告成没装上。
    connection_info = target / "server" / "runtime" / "connection-info.txt"
    print("面板地址如下，含访问密钥，只交付给用户本人一次，不要回写进任何对话摘要、日志或文件：")
    print(dashboard_url(port, token))
    print(f"这行地址也保存在 {connection_info}（权限 0600），忘了随时自己去看。")

    hosts = detect_hosts(home)
    installed_hosts, warnings = [], []
    skill_source = target / "skills" / SKILL_DIR_NAME
    targets = available_hosts(hosts) + [Path(extra).expanduser() for extra in args.skill_host or []]
    for host_dir in targets:
        # 一个宿主装不上不该连累其余宿主，更不该连累已经装好的服务：逐个降级成提醒。
        try:
            installed_hosts.append(str(install_skill_into_host(host_dir, skill_source)))
        except BootstrapError as error:
            warnings.append(f"{host_dir} 没装上：{error} {error.advice}")
            continue
        except OSError as error:
            warnings.append(f"{host_dir} 没装上：{error}。请确认这个目录存在且可写，然后重跑 install --upgrade。")
            continue
        for retired in retire_legacy_skills(host_dir):
            say(f"已退役改名前的旧技能目录：{retired}")
    if installed_hosts:
        say(f"LifeOS 记录技能已装进 {len(installed_hosts)} 个 Agent 宿主")
    else:
        warnings.append(host_advice())

    if router_requested(hosts):
        router = home / ".hermes" / "skills" / SKILL_DIR_NAME / "scripts" / "install_lifeos_router.py"
        if router.is_file():
            code, output = run_step([sys.executable, str(router)], target)
            if code != 0:
                warnings.append(f"Hermes 常驻路由没装上：{scrub(output, token)}")
            else:
                say("Hermes 常驻路由已切换到 LifeOS")
        else:
            warnings.append("Hermes 宿主里没有本次安装的技能脚本，跳过常驻路由切换。")

    if not _dependency_present():
        warnings.append("本机 python3 没有 openpyxl，财务报表导出会返回 503。想用导出就跑一次：python3 -m pip install -r " + str(target / "server" / "requirements.txt"))

    for warning in warnings:
        say(f"提醒：{warning}")
    print(json.dumps({
        "command": "install",
        "ok": True,
        "installPath": str(target),
        "version": read_version(target),
        "port": port,
        "dashboard": f"http://127.0.0.1:{port}/dashboard/",
        "connectionInfo": str(connection_info),
        "skills": installed_hosts,
        "warnings": warnings,
    }, ensure_ascii=False))
    return 0


def command_status(args: argparse.Namespace) -> int:
    pointer = Path.home() / POINTER_RELATIVE
    root = resolve_install_root(args.install_path, pointer)
    report = {
        "command": "status",
        "pointer": str(pointer),
        "pointerExists": pointer.is_file(),
        "installPath": str(root),
        "installed": (root / INSTALL_MARKER).is_file(),
        "version": read_version(root),
    }
    if not report["installed"]:
        report["problems"] = [f"{root} 里没有 LifeOS 的程序本体"]
        print(json.dumps(report, ensure_ascii=False))
        return 0
    port, token = read_connection(root)
    report["port"] = port
    try:
        payload = probe_health(port, token)
    except (OSError, urllib.error.URLError, ValueError) as exc:
        report["running"] = False
        report["problems"] = [f"端口 {port} 上的服务没有正常应答（{type(exc).__name__}）"]
    else:
        domains = payload.get("domains") if isinstance(payload.get("domains"), dict) else {}
        report["running"] = True
        report["buildId"] = payload.get("buildId")
        report["dbPaths"] = {name: (domains.get(name) or {}).get("dbPath") for name in HEALTH_DOMAINS}
        report["problems"] = health_problems(payload, root / "server" / "runtime")
    print(json.dumps(report, ensure_ascii=False))
    return 0


def command_uninstall(args: argparse.Namespace) -> int:
    root = resolve_install_root(args.install_path, Path.home() / POINTER_RELATIVE)
    if not (root / INSTALL_MARKER).is_file():
        raise BootstrapError(f"{root} 里没有 LifeOS 的程序本体。", "确认路径是否写对；本命令只卸载真正的 LifeOS 安装。")
    secret = _secret_quietly(root)
    code, output = run_step(["bash", "server/uninstall_lifeos.sh"], root, {"LIFEOS_CONFIRM_UNINSTALL": "1"})
    if output:
        print(scrub(output, secret))
    if code != 0:
        raise BootstrapError(f"卸载脚本以退出码 {code} 结束。", "卸载脚本的三重认亲有任何一环存疑就会拒绝动手，这是设计行为；请按上面的中文提示处理。")
    # 服务停了而 skill 还留在宿主里，Agent 下一句「我开始写代码了」仍会照常调用 timectl，
    # 对着一个已经没人监听的端口报连接失败——用户刚卸载完，看到的却是一条像是坏了的报错。
    removed_skills = []
    for host_dir in available_hosts(detect_hosts(Path.home())):
        for name in (SKILL_DIR_NAME,) + LEGACY_SKILL_DIR_NAMES:
            stale = host_dir / name
            try:
                if stale.is_symlink():
                    if looks_like_lifeos_skill(stale):
                        stale.unlink()
                        removed_skills.append(str(stale))
                elif stale.is_dir() and looks_like_lifeos_skill(stale):
                    shutil.rmtree(stale)
                    removed_skills.append(str(stale))
            except OSError:
                continue
    if removed_skills:
        print(f"已从 {len(removed_skills)} 个 Agent 宿主移除记录技能，AI 不会再对着已停的服务下命令。")
    runtime = root / "server" / "runtime"
    print(f"只卸载了服务、开机自启与记录技能。你的两本账本仍在 {runtime}，一条记录都没有删。")
    print(json.dumps({
        "command": "uninstall",
        "ok": True,
        "installPath": str(root),
        "dataKept": str(runtime),
        "skillsRemoved": removed_skills,
    }, ensure_ascii=False))
    return 0


# ── 下载与解压（副作用集中在这几行，便于纯函数部分独立回归） ──────────────────

def _download(url: str, target: Path) -> None:
    try:
        with _open(url, timeout=180.0) as response, target.open("wb") as handle:
            shutil.copyfileobj(response, handle)
    except (OSError, urllib.error.URLError):
        raise BootstrapError("安装包下载失败。", "检查网络后重跑同一条命令；已下载的内容在临时目录里，会被自动清掉。") from None


def _download_text(url: str) -> str:
    try:
        with _open(url, timeout=60.0) as response:
            return response.read().decode("utf-8", errors="replace")
    except (OSError, urllib.error.URLError):
        raise BootstrapError("校验和文件下载失败。", "检查网络后重跑同一条命令。") from None


def _extract(package: Path, into: Path) -> Path:
    try:
        with zipfile.ZipFile(package) as bundle:
            root = archive_root(bundle.namelist())
            bundle.extractall(into)
            # zipfile.extractall 丢弃 Unix 权限位：ZIP 里 0755 的部署脚本解出来是 0644。
            # 用 unzip(1) 或访达解包的人拿到的是可执行文件，走引导安装的人拿到的不是——
            # 同一份发布物在两条路径上行为不同，而差异只在「直接执行脚本」那一刻才暴露。
            for info in bundle.infolist():
                mode = (info.external_attr >> 16) & 0o7777
                if mode and not info.is_dir():
                    (into / info.filename).chmod(mode)
    except zipfile.BadZipFile:
        raise BootstrapError("下载到的文件不是有效的 ZIP。", "多半是下载被中途截断；重跑同一条命令。") from None
    except OSError as exc:
        raise BootstrapError(f"解压失败：{exc}", "检查磁盘剩余空间与目录权限后重试。") from None
    return into / root


def _dependency_present() -> bool:
    code, _ = run_step([shutil.which("python3") or sys.executable, "-c", "import openpyxl"], Path.home())
    return code == 0


def dashboard_url(port: int, token: Secret) -> str:
    return f"http://127.0.0.1:{port}/dashboard/?token={token.reveal()}"


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="lifeos_bootstrap.py", description="把 LifeOS 从 GitHub Release 装到本机")
    sub = parser.add_subparsers(dest="command", required=True)

    detect = sub.add_parser("detect", help="探测本机装了哪些 Agent 宿主")
    detect.set_defaults(handler=command_detect)

    install = sub.add_parser("install", help="下载、校验、部署并自检")
    install.add_argument("--version", help="指定 Release 标签；不给就装最新版")
    install.add_argument("--install-path", help=f"安装目录，默认 {DEFAULT_INSTALL_PATH}")
    install.add_argument("--port", type=int, help="监听端口，默认 59418")
    install.add_argument("--upgrade", action="store_true", help="目标已是 LifeOS 时就地升级，保留账本")
    install.add_argument("--replace-pointer", action="store_true", help="全局指针指向别的安装时，改指本次安装")
    install.add_argument("--skill-host", action="append", help="额外的 skill 安装目录，可重复")
    install.set_defaults(handler=command_install)

    status = sub.add_parser("status", help="只读体检：装在哪、在不在跑、双账本在哪")
    status.add_argument("--install-path", help="不用全局指针，直接指定安装目录")
    status.set_defaults(handler=command_status)

    uninstall = sub.add_parser("uninstall", help="卸载服务与开机自启；不删除任何数据")
    uninstall.add_argument("--install-path", help="不用全局指针，直接指定安装目录")
    uninstall.set_defaults(handler=command_uninstall)
    return parser


def main(argv: "list | None" = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        return int(args.handler(args))
    except BootstrapError as exc:
        print(f"✗ {exc}", file=sys.stderr)
        if exc.advice:
            print(f"  下一步：{exc.advice}", file=sys.stderr)
        return 2
    except KeyboardInterrupt:
        print("✗ 已中断，本次操作没有走完。", file=sys.stderr)
        print("  下一步：重跑本命令；已经落盘的部分会被下一次安装判据重新裁定。", file=sys.stderr)
        return 130
    except OSError as exc:
        # 权限、磁盘满、目录不存在、连接被掐断都落在这里。裸 traceback 对一个不懂技术的用户
        # 等于没有信息，而本项目的法则是任何失败都必须带下一步。
        print(f"✗ 本机文件或网络操作失败：{exc}", file=sys.stderr)
        print("  下一步：确认目标目录存在且可写、磁盘仍有空间、网络通畅，然后重跑本命令。", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
