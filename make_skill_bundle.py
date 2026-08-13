#!/usr/bin/env python3
"""
[INPUT]: 读取根 VERSION、make_release.sh 已产出并已扫描的 dist/lifeos-<版本>/ 发布树，
         以及 packaging/market-skill/ 覆盖层与 skills/zzm-lifeos/ 的既有 references 与 ctl 脚本。
[OUTPUT]: 产出可直接上传第三方 Skill 市场的自足包 dist/lifeos-skill-<版本>/zzm-lifeos-full/
          与同名 .zip + .sha256；包内 payload/ 是发布树的可逆扩展名归一化镜像，
          还原后与发布树逐字节相同，落盘前复用 make_release.sh --inspect 的同一套私货扫描。
[POS]: 第四条分发路径的唯一构建边界。payload 的唯一进料是已扫描的发布树，Skill 层的唯一进料是
       skills/ 真源与 packaging/ 覆盖层——市场包是两者的派生形态，不是第二份真源；
       出包前整包（含 Skill 层）再过一遍 make_release.sh --inspect 的同一套私货扫描。
[PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path, PurePosixPath
from typing import Iterable


ROOT = Path(__file__).resolve().parent
SKILL_DIR_NAME = "zzm-lifeos-full"

# 平台明确列出的扩展名白名单。落在名单外的成员一律改名到 .txt（文本）或 .b64.txt（二进制），
# 由 manifest 记账、安装时逐字还原——把判据写死成一张表，而不是散在若干 if 里：
# 名单变了只改这一行，还原逻辑不必跟着动。
ALLOWED_SUFFIXES = frozenset({".md", ".txt", ".html", ".css", ".js", ".py", ".json", ".xml"})
TEXT_SUFFIX = ".txt"
BINARY_SUFFIX = ".b64.txt"

# 从 skills/ 原样搬进市场包的成员。市场包不重写它们，也不留第二份副本在仓库里：
# 时间与财务协议、ctl 脚本、安装编排器的真源永远只有 skills/ 下那一份。
SHARED_REFERENCES = ("deployment.md", "time-recording.md", "fin-bookkeeping.md")
SHARED_SCRIPTS = (
    "lifeconn.py",
    "timectl.py",
    "finctl.py",
    "timeview.py",
    "finview.py",
    "timeclock.py",
    "time_commands.py",
    "install_lifeos_router.py",
)
INSTALL_SCRIPTS = ("lifeos_bootstrap.py", "lifeos_source.py", "lifeos_deploy.py")


class BundleError(RuntimeError):
    """一切可预期失败都走这里；message 说清哪一步断了，advice 说清下一步做什么。"""

    def __init__(self, message: str, advice: str = "") -> None:
        super().__init__(message)
        self.advice = advice


# ── 版本与进料 ────────────────────────────────────────────────────────────────


def read_version() -> str:
    version_file = ROOT / "VERSION"
    try:
        version = version_file.read_text(encoding="utf-8").strip()
    except OSError as exc:
        raise BundleError(f"读不到根 VERSION：{exc}", "确认仓库完整后重试。") from exc
    if not version or re.search(r"[^A-Za-z0-9.+-]", version):
        raise BundleError(f"根 VERSION 不是合法版本号：{version!r}", "只允许字母、数字与 . + -。")
    return version


def release_tree(version: str) -> Path:
    tree = ROOT / "dist" / f"lifeos-{version}"
    if not (tree / "server" / "lifeos_node_server.py").is_file():
        raise BundleError(
            f"缺少已扫描的发布树 {tree}",
            "先跑 `bash make_release.sh` 产出发布物；市场包只从发布树派生，不读工作树。",
        )
    return tree


# ── 扩展名归一化 ──────────────────────────────────────────────────────────────


def classify(data: bytes, relative: PurePosixPath) -> tuple[str, bool]:
    """返回 (payload 内的相对路径, 是否 base64)。规则只有三条，且完全可逆。"""
    if relative.suffix in ALLOWED_SUFFIXES:
        return str(relative), False
    try:
        data.decode("utf-8")
    except UnicodeDecodeError:
        return f"{relative}{BINARY_SUFFIX}", True
    return f"{relative}{TEXT_SUFFIX}", False


def collect(tree: Path) -> list[dict[str, object]]:
    """把发布树扫成 manifest 条目。sha256 记的是**还原后**的内容——安装器校验的
    必须是它真正要写到用户盘上的字节，而不是 payload 里那份编码态。"""
    entries: list[dict[str, object]] = []
    taken: dict[str, str] = {}
    for path in sorted(tree.rglob("*")):
        if path.is_symlink():
            raise BundleError(f"发布树含符号链接 {path}", "市场包不分发符号链接；请检查发布流程。")
        if not path.is_file():
            continue
        relative = PurePosixPath(path.relative_to(tree).as_posix())
        data = path.read_bytes()
        source, encoded = classify(data, relative)
        if source in taken:
            raise BundleError(
                f"归一化后路径撞车：{taken[source]} 与 {relative} 都落到 {source}",
                "给其中一个源文件改名；payload 内的路径必须与 dest 一一对应。",
            )
        taken[source] = str(relative)
        entries.append(
            {
                "dest": str(relative),
                "source": source,
                "mode": "0755" if os.access(path, os.X_OK) else "0644",
                "sha256": hashlib.sha256(data).hexdigest(),
                "bytes": len(data),
                "base64": encoded,
            }
        )
    if not entries:
        raise BundleError("发布树里一个文件都没有", "确认 make_release.sh 正常产出后重试。")
    return entries


def tree_digest(entries: Iterable[dict[str, object]]) -> str:
    """整棵树的单值指纹：安装器与 doctor 用它一句话回答「装的是哪一版 payload」。"""
    digest = hashlib.sha256()
    for entry in sorted(entries, key=lambda item: str(item["dest"])):
        digest.update(f"{entry['dest']}\n{entry['mode']}\n{entry['sha256']}\n".encode("utf-8"))
    return digest.hexdigest()


def write_payload(tree: Path, stage: Path, entries: list[dict[str, object]]) -> None:
    payload = stage / "payload"
    for entry in entries:
        data = (tree / str(entry["dest"])).read_bytes()
        target = payload / "tree" / str(entry["source"])
        target.parent.mkdir(parents=True, exist_ok=True)
        if entry["base64"]:
            # 每行 76 字符的标准换行 base64：单行几十万字符的文件会卡死一部分编辑器与审阅工具，
            # 而市场包是要被人过一遍眼睛的。
            target.write_bytes(base64.encodebytes(data))
        else:
            target.write_bytes(data)


# ── Skill 本体组装 ────────────────────────────────────────────────────────────


def assemble_skill(stage: Path, version: str, entries: list[dict[str, object]]) -> None:
    overlay = ROOT / "packaging" / "market-skill"
    if not (overlay / "SKILL.md").is_file():
        raise BundleError(f"缺少市场 Skill 覆盖层 {overlay}/SKILL.md", "确认仓库完整后重试。")
    # 本机辅助工具会往任何目录里下缓存蛋（.impeccable、.DS_Store）；在进料口过滤掉它们，
    # 私货扫描仍然守在出包口——过滤是为了少炸，扫描才是不许漏。
    shutil.copytree(overlay, stage, dirs_exist_ok=True, ignore=shutil.ignore_patterns(".impeccable", ".DS_Store", "__pycache__"))

    skill_source = ROOT / "skills" / "zzm-lifeos"
    for name in SHARED_REFERENCES:
        shutil.copy2(skill_source / "references" / name, stage / "references" / name)
    scripts = stage / "scripts"
    for name in SHARED_SCRIPTS:
        shutil.copy2(skill_source / "scripts" / name, scripts / name)
    install_source = ROOT / "skills" / "zzm-lifeos-install" / "scripts"
    for name in INSTALL_SCRIPTS:
        shutil.copy2(install_source / name, scripts / name)

    manifest = {
        "schema": 1,
        "product": "LifeOS",
        "version": version,
        "treeSha256": tree_digest(entries),
        "fileCount": len(entries),
        "totalBytes": sum(int(entry["bytes"]) for entry in entries),
        "files": entries,
    }
    (stage / "payload").mkdir(parents=True, exist_ok=True)
    (stage / "payload" / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=1, sort_keys=False) + "\n", encoding="utf-8"
    )

    # SKILL.md 与 README 里的版本号不能靠人手同步：写错的那一版会让用户以为装的是别的东西。
    for name in ("SKILL.md", "README.md"):
        path = stage / name
        if path.is_file():
            path.write_text(
                path.read_text(encoding="utf-8")
                .replace("{{VERSION}}", version)
                .replace("{{FILE_COUNT}}", str(len(entries)))
                .replace("{{TREE_SHA256}}", manifest["treeSha256"][:12]),
                encoding="utf-8",
            )


# ── 自证 ──────────────────────────────────────────────────────────────────────


def verify_roundtrip(tree: Path, stage: Path) -> None:
    """落盘前先自己走一遍还原：市场包唯一的正确性判据是
    materialize(payload) 与发布树逐字节相同，任何一条对不上都不许出包。"""
    manifest = json.loads((stage / "payload" / "manifest.json").read_text(encoding="utf-8"))
    payload = stage / "payload" / "tree"
    seen = set()
    for entry in manifest["files"]:
        raw = (payload / entry["source"]).read_bytes()
        data = base64.decodebytes(raw) if entry["base64"] else raw
        if hashlib.sha256(data).hexdigest() != entry["sha256"]:
            raise BundleError(f"payload 还原后与清单不符：{entry['dest']}")
        original = (tree / entry["dest"]).read_bytes()
        if data != original:
            raise BundleError(f"payload 还原后与发布树不符：{entry['dest']}")
        expected = "0755" if os.access(tree / entry["dest"], os.X_OK) else "0644"
        if entry["mode"] != expected:
            raise BundleError(f"payload 记录的权限与发布树不符：{entry['dest']}")
        seen.add(entry["dest"])
    actual = {
        path.relative_to(tree).as_posix() for path in tree.rglob("*") if path.is_file()
    }
    missing = actual - seen
    if missing:
        raise BundleError(f"发布树有 {len(missing)} 个成员没进 payload：{sorted(missing)[:5]}")


def inspect(target: Path) -> None:
    """私货扫描不另写一套判据：调 make_release.sh 的同一段扫描，
    否则两处规则迟早分叉，而分叉的那一次就是泄漏。"""
    result = subprocess.run(
        ["bash", str(ROOT / "make_release.sh"), "--inspect", str(target), SKILL_DIR_NAME, "skill"],
        cwd=ROOT,
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        raise BundleError(
            f"市场包未通过私货扫描：\n{result.stdout}{result.stderr}".rstrip(),
            "按上面每一条定位到具体成员后修掉，不要绕过扫描出包。",
        )


def budget(stage: Path, limit_total: int, limit_file: int) -> tuple[int, int]:
    total, largest = 0, 0
    for path in stage.rglob("*"):
        if path.is_file():
            size = path.stat().st_size
            total += size
            largest = max(largest, size)
    if largest > limit_file:
        raise BundleError(f"存在超过单文件上限的成员（{largest} > {limit_file} 字节）")
    if total > limit_total:
        raise BundleError(f"包体超过总量上限（{total} > {limit_total} 字节）")
    return total, largest


def pack(base: Path, top: str, archive: Path) -> None:
    # 不用 zip(1)：Info-ZIP 不给非 ASCII 文件名置 UTF-8 标志位，docs/ 下的中文文件名会以
    # 无声明的原始字节入包，解压出来是乱码——与 make_release.sh 的 pack_archive 同一条教训。
    with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as package:
        package.write(base / top, arcname=top)
        for path in sorted((base / top).rglob("*")):
            package.write(path, arcname=path.relative_to(base).as_posix())


def checksum(archive: Path) -> None:
    digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    # 只写 basename：绝对路径会让 `shasum -a 256 -c` 在别人机器上找不到文件。
    archive.with_name(archive.name + ".sha256").write_text(f"{digest}  {archive.name}\n", encoding="utf-8")


# ── 入口 ──────────────────────────────────────────────────────────────────────


def build(limit_total: int, limit_file: int) -> list[Path]:
    version = read_version()
    tree = release_tree(version)
    bundle_name = f"lifeos-skill-{version}"
    out = ROOT / "dist" / bundle_name
    archive = ROOT / "dist" / f"{bundle_name}.zip"
    stage = out / SKILL_DIR_NAME

    for path in (out, archive, archive.with_name(archive.name + ".sha256")):
        if path.is_dir():
            shutil.rmtree(path)
        elif path.exists():
            path.unlink()
    stage.mkdir(parents=True)

    entries = collect(tree)
    write_payload(tree, stage, entries)
    assemble_skill(stage, version, entries)
    verify_roundtrip(tree, stage)
    inspect(stage)
    total, largest = budget(stage, limit_total, limit_file)
    pack(out, SKILL_DIR_NAME, archive)
    inspect(archive)
    checksum(archive)

    print(f"· 源自发布树 {tree.relative_to(ROOT)}（{len(entries)} 个成员，{total} 字节，最大单文件 {largest} 字节）")
    return [archive, archive.with_name(archive.name + ".sha256"), out]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="把 LifeOS 发布树打成可上传 Skill 市场的自足包。")
    parser.add_argument("--max-total-bytes", type=int, default=30 * 1000 * 1000, help="平台总量上限")
    parser.add_argument("--max-file-bytes", type=int, default=10 * 1000 * 1000, help="平台单文件上限")
    args = parser.parse_args(argv)
    try:
        for path in build(args.max_total_bytes, args.max_file_bytes):
            print(path)
    except BundleError as error:
        print(str(error), file=sys.stderr)
        if error.advice:
            print(f"下一步：{error.advice}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
