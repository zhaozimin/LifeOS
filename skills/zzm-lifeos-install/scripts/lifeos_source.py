"""
[INPUT]: 依赖 GitHub 官方发布域的 HTTPS 直连（网络路径）或随包 payload 的 manifest.json（离线路径）；
         只用 Python 3.9+ 标准库，零第三方依赖，不 import 编排层的任何模块。
[OUTPUT]: 对外提供发布树的两种来源与全部验证判据：域白名单与禁代理下载、sha256 摘要、
          压缩包顶层裁定与权限还原、payload 清单裁定与逐文件还原，以及 BootstrapError。
[POS]: lifeos-install 的发布树来源层。编排层（lifeos_bootstrap）只关心「给我一棵已验证的树」，
       树从网上来还是从包里来、怎么验，全部收在本层——两条分发路径共用同一套拒绝语义：
       任何校验不过都发生在触碰安装目标之前。
[PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import json
import shutil
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from pathlib import Path, PurePosixPath
from typing import Any, Iterable


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
HEX_DIGITS = set("0123456789abcdef")
DIGITS = set("0123456789")
ASSET_PREFIX, ASSET_SUFFIX = "lifeos-", ".zip"


class BootstrapError(RuntimeError):
    """一切可预期失败都走这里：message 说清发生了什么，advice 说清用户下一步做什么。

    不带 advice 的失败等于把用户丢在原地，所以调用处应尽量给出下一步。
    """

    def __init__(self, message: str, advice: str = "") -> None:
        super().__init__(message)
        self.advice = advice


# ── 网络路径：附件判据、白名单、下载、解压 ────────────────────────────────────


def is_system_archive(name: str) -> bool:
    """整套系统的包必然叫 `lifeos-<版本>.zip`，而版本号必以数字开头。

    这里曾经用「lifeos-*.zip 减去几个已知前缀」的黑名单判据，v1.2.0 发布当天就被
    自己的新附件击穿：市场包 lifeos-skill-1.2.0.zip 同样匹配 lifeos-*.zip，安装器
    于是看见两个候选、按「有歧义不猜」直接拒绝。真正致命的是波及范围——歧义在
    Release 的附件集合里，不在客户端版本里，所以**已经发出去的旧 skill 一起失效**，
    推荐路径对全体用户静默死掉；而本地金样喂的是手写附件表，只有真实下载才暴露。
    黑名单每加一个附件就得补一条，漏一条的代价就是这个。改成结构正判据之后，
    任何在 `lifeos-` 之后带词的附件天然出局，不必再维护任何名单。
    """
    if not (name.startswith(ASSET_PREFIX) and name.endswith(ASSET_SUFFIX)):
        return False
    version = name[len(ASSET_PREFIX):-len(ASSET_SUFFIX)]
    return bool(version) and version[0] in DIGITS


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


def digest_of(path: Path) -> str:
    hasher = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            hasher.update(block)
    return hasher.hexdigest()


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


# ── 离线路径：随包 payload 的清单裁定与还原 ───────────────────────────────────


def read_payload_manifest(payload: Path) -> dict:
    """读取并裁定随包 payload 的清单。任何一条不合格都整体拒绝——
    payload 是市场包作者签好字的进料单，缺页、涂改与越界路径都不是「尽量装」的理由。"""
    manifest_path = payload / "manifest.json"
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except OSError as exc:
        raise BootstrapError(f"读不到随包清单 {manifest_path}：{exc}", "这个 Skill 包不完整；请重新从市场下载安装本 Skill。") from None
    except json.JSONDecodeError:
        raise BootstrapError("随包清单不是有效 JSON。", "这个 Skill 包已损坏；请重新从市场下载安装本 Skill。") from None
    files = manifest.get("files")
    version = manifest.get("version")
    if manifest.get("schema") != 1 or not isinstance(files, list) or not files or not isinstance(version, str) or not version:
        raise BootstrapError("随包清单的结构不是本安装器认识的形态。", "Skill 与其 payload 版本不匹配；请重新从市场下载安装本 Skill。")
    for entry in files:
        dest, source = entry.get("dest"), entry.get("source")
        for label, value in (("dest", dest), ("source", source)):
            if not isinstance(value, str) or not value:
                raise BootstrapError(f"随包清单有成员缺少 {label}。", "清单被涂改过；请重新从市场下载安装本 Skill。")
            pure = PurePosixPath(value)
            if pure.is_absolute() or ".." in pure.parts or "\\" in value:
                raise BootstrapError(f"随包清单含越界路径：{value}", "这不是 LifeOS 的正常发布形态，已中止安装；什么都没有被写进你的电脑。")
        if entry.get("mode") not in ("0644", "0755") or not isinstance(entry.get("sha256"), str) or len(entry["sha256"]) != 64 or set(entry["sha256"]) - HEX_DIGITS or not isinstance(entry.get("base64"), bool):
            raise BootstrapError(f"随包清单成员 {dest} 的属性不完整。", "清单被涂改过；请重新从市场下载安装本 Skill。")
    return manifest


def materialize_payload(payload: Path, manifest: dict, into: Path) -> Path:
    """把可逆归一化的 payload 还原成与 GitHub 发布树逐字节相同的目录。

    返回值语义与 _extract 完全一致：唯一顶层目录的绝对路径，直接喂给
    assert_release_layout / deploy。逐文件 sha256 对拍的是**还原后**的字节——
    校验的必须是真正要写进用户电脑的内容，而不是 payload 里那份编码态。
    全部写入都发生在临时目录里，任何一条对不上都在触碰安装目标之前中止。
    """
    root = into / f"lifeos-{manifest['version']}"
    tree = payload / "tree"
    for entry in manifest["files"]:
        source = tree / entry["source"]
        try:
            raw = source.read_bytes()
        except OSError as exc:
            raise BootstrapError(f"随包 payload 缺少成员 {entry['source']}：{exc}", "这个 Skill 包不完整；请重新从市场下载安装本 Skill。") from None
        if entry["base64"]:
            try:
                data = base64.decodebytes(raw)
            except (ValueError, binascii.Error):
                raise BootstrapError(f"随包成员 {entry['source']} 不是有效的 base64。", "这个 Skill 包已损坏；请重新从市场下载安装本 Skill。") from None
        else:
            data = raw
        if hashlib.sha256(data).hexdigest() != entry["sha256"]:
            raise BootstrapError(
                f"随包成员 {entry['dest']} 的 sha256 与清单不一致，已中止安装。",
                "安装目标一个字节都没有被改动。请重新从市场下载安装本 Skill；反复不一致请报告给 LifeOS 项目。",
            )
        target = root / entry["dest"]
        target.parent.mkdir(parents=True, exist_ok=True)
        try:
            target.write_bytes(data)
        except OSError as exc:
            raise BootstrapError(f"还原 {entry['dest']} 失败：{exc}", "检查磁盘剩余空间与目录权限后重试。") from None
        target.chmod(0o755 if entry["mode"] == "0755" else 0o644)
    return root
