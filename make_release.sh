#!/usr/bin/env bash
# [INPUT]: 读取根 VERSION、干净 Git 工作树、RELEASE_PATHS 白名单与 HEAD 上已提交的发布成员。
# [OUTPUT]: 产出主包 dist/lifeos-<版本>/ 与 dist/lifeos-<版本>.zip，以及只含引导 Skill 的
#           dist/lifeos-install-skill-<版本>.zip；两个包的解包目录与 ZIP 各扫一遍敏感文件名、家目录绝对路径、
#           tailnet 私有主机名与凭证形态，主包另校验根 CLAUDE.md 与发布物同构，各出一份 `shasum -a 256 -c` 可直接吃的 .sha256。
# [POS]: 公开发布边界；`--print-release-paths` 让 CI 的私货扫描与打包共用同一份白名单真源（该接口刻意不依赖 VERSION），
#        根 VERSION 则是版本号的唯一供给——CI 附件、Release 资产与引导 Skill 的下载名全部由它推导，不再各自硬编码。
#        打包走 Python 标准库而非 zip(1)：中文文件名必须带 UTF-8 标志位入包，且发布链不该依赖某个平台的 zip 实现。
# [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
set -euo pipefail

root=$(cd "$(dirname "$0")" && pwd)

# 用白名单而非黑名单：漏一条黑名单等于一次泄漏，漏一条白名单只会少一个文件，用户立刻会发现。
# implementation-notes.md 与 implementation-report.md 是内部施工记录（含本机绝对路径），刻意不在此列。
RELEASE_PATHS=(
  "VERSION"
  "README.md"
  "LICENSE"
  "CLAUDE.md"
  ".gitignore"
  "make_release.sh"
  "docs"
  "skills"
  "server/CLAUDE.md"
  "server/.gitignore"
  "server/__init__.py"
  "server/lifeos_node_server.py"
  "server/migration_rehearsal.py"
  "server/core"
  "server/domains"
  "server/web"
  "server/web-dashboard"
  "server/runtime/CLAUDE.md"
  "server/runtime/config.json.example"
  "server/runtime/time/.gitkeep"
  "server/runtime/finance/.gitkeep"
  "server/_port_probe.sh"
  "server/requirements.txt"
  "server/install_and_start_lifeos_node.sh"
  "server/install_launch_agent.sh"
  "server/launch_lifeos_node_foreground.sh"
  "server/uninstall_lifeos.sh"
  # 用户拿到 ZIP 后 `python -m unittest discover` 要能自证：部署套件的三份用例
  # 与它们共用的 _lifeos_test_support.py 必须同进同出，少一份就是 ImportError。
  "server/_lifeos_test_support.py"
  "server/test_lifeos_http_core.py"
  "server/test_lifeos_http_time.py"
  "server/test_lifeos_http_finance.py"
  "server/test_time_domain.py"
  "server/test_finance_domain.py"
  "server/test_finance_attachment_upload.py"
  "server/test_lifeos_deployment.py"
  "server/test_lifeos_skill_golden.py"
  "server/test_lifeos_migration_rehearsal.py"
)

if [ "${1:-}" = "--print-release-paths" ]; then
  printf '%s\n' "${RELEASE_PATHS[@]}"
  exit 0
fi

# 版本号同时是两个 ZIP 的文件名、主包顶层目录名与 Release 资产名。
# 一个尾随换行或一个 `/` 会静默产出粉丝按文档解压不出来的包，所以这里读一次、校验一次，别处只许引用。
version_file="$root/VERSION"
if [ ! -f "$version_file" ]; then
  printf '%s\n' '缺少根 VERSION 文件，无法确定发布版本号。' >&2
  exit 2
fi
version=$(tr -d '[:space:]' < "$version_file")
case "$version" in
  '' | *[!A-Za-z0-9.+-]*)
    printf '%s\n' "根 VERSION 的内容不是合法版本号（只允许字母、数字与 . + -）：'$version'" >&2
    exit 2
    ;;
esac

release_name="lifeos-$version"
out="$root/dist/$release_name"
archive="$root/dist/$release_name.zip"
# 引导 Skill 单独出一个小包：粉丝先下它、装进自己的 Agent，才有人替他去拉几 MB 的主包。
skill_name="lifeos-install"
skill_source="skills/$skill_name"
skill_stage="$root/dist/lifeos-install-skill-$version"
skill_archive="$root/dist/lifeos-install-skill-$version.zip"

inspect_release() {
  LIFEOS_RELEASE_TARGET="$1" LIFEOS_RELEASE_PREFIX="$2" LIFEOS_RELEASE_MODE="$3" python3 <<'PY'
import os
import re
import stat
import sys
import zipfile
from pathlib import Path, PurePosixPath

target = Path(os.environ["LIFEOS_RELEASE_TARGET"])
prefix = os.environ["LIFEOS_RELEASE_PREFIX"]
# full = 整套系统的主包（自证根 CLAUDE.md 同构）；skill = 只含引导 Skill 的小包（自证自身入口与地图齐全）。
mode = os.environ["LIFEOS_RELEASE_MODE"]

FORBIDDEN_BASENAMES = {
    "config.json",
    "connection-info.txt",
    "openclaw_finance_tools.json",
    ".DS_Store",
}
FORBIDDEN_PARTS = {"attachments", "node_modules", "__pycache__", ".impeccable", "logs", "dist"}

# 规则字面量全部拆开拼装，否则本脚本自己就会命中自己定义的规则。
home_root = b"/" + b"Users" + b"/"
tailnet_suffix = rb"\.ts" + rb"\.net"
token_key = b'"access' + b'Token"'
CONTENT_RULES = (
    ("家目录绝对路径", re.compile(re.escape(home_root) + rb"[A-Za-z0-9._-]+/")),
    ("tailnet 私有主机名", re.compile(rb"[A-Za-z0-9][A-Za-z0-9-]*" + tailnet_suffix)),
    ("疑似真实 accessToken", re.compile(re.escape(token_key) + rb'\s*:\s*"[A-Za-z0-9_-]{32,}"')),
    ("疑似 Token 查询串", re.compile(rb"\?to" + rb"ken=[A-Za-z0-9_-]{32,}")),
    ("疑似凭证或私钥", re.compile(
        rb"(?:gh" + rb"[pousr]_[A-Za-z0-9]{20,}"
        rb"|git" + rb"hub_pat_[A-Za-z0-9_]{20,}"
        rb"|s" + rb"k-[A-Za-z0-9]{24,}"
        rb"|(?:AK" + rb"IA|AS" + rb"IA)[A-Z0-9]{16}"
        rb"|-----BEGIN (?:[A-Z0-9 ]+ )?PRIV" + rb"ATE KEY-----)"
    )),
)

# 顶层目录名被写死在安装文档、安装 Skill 与 CI 的解压路径里；ZIP 里多一个平行顶层成员就是一次安装失败。
stray_roots = []


def members():
    """把解包目录与 ZIP 归一成同一种成员流，让两次扫描共用同一套规则而不是各写一遍。"""
    if target.is_dir():
        for path in sorted(target.rglob("*")):
            relative = path.relative_to(target).as_posix()
            if path.is_symlink():
                yield relative, None, True
            elif path.is_dir():
                yield relative, None, False
            else:
                yield relative, path.read_bytes(), False
        return
    with zipfile.ZipFile(target) as package:
        if package.testzip() is not None:
            raise SystemExit("发布物含敏感运行态：ZIP CRC 校验失败")
        for info in package.infolist():
            relative = info.filename
            if relative.startswith(prefix + "/"):
                relative = relative[len(prefix) + 1:]
            elif relative.rstrip("/") == prefix:
                continue
            else:
                stray_roots.append(info.filename)
                continue
            relative = relative.rstrip("/")
            if not relative:
                continue
            if stat.S_ISLNK((info.external_attr >> 16) & 0xFFFF):
                yield relative, None, True
            elif info.is_dir():
                yield relative, None, False
            else:
                yield relative, package.read(info), False


failures = []
present = set()
contents = {}
for relative, data, is_link in members():
    present.add(relative)
    parent = PurePosixPath(relative).parent
    while str(parent) not in (".", "/"):
        present.add(str(parent))
        parent = parent.parent
    if is_link:
        failures.append(f"符号链接成员：{relative}")
        continue
    name = PurePosixPath(relative).name
    if name in FORBIDDEN_BASENAMES or ".sqlite3" in name:
        failures.append(f"禁止成员：{relative}")
        continue
    if set(PurePosixPath(relative).parts) & FORBIDDEN_PARTS:
        failures.append(f"禁止目录成员：{relative}")
        continue
    if data is None:
        continue
    contents[relative] = data
    for label, rule in CONTENT_RULES:
        if rule.search(data):
            failures.append(f"{label}：{relative}")

for name in stray_roots:
    failures.append(f"ZIP 顶层目录不是唯一的 {prefix}/，混入了 {name}")

if mode == "full":
    # GEB 同构：发布物必须能自证地图与地形一致，根 CLAUDE.md 声明的每个目录与配置都要真实存在。
    root_map = contents.get("CLAUDE.md")
    if root_map is None:
        failures.append("发布物缺少根 CLAUDE.md，无法校验 GEB 同构")
    else:
        text = root_map.decode("utf-8")
        for block in ("directory", "config"):
            section = re.search(rf"<{block}>(.*?)</{block}>", text, re.DOTALL)
            if section is None:
                failures.append(f"根 CLAUDE.md 缺少 <{block}> 块")
                continue
            declared_members = re.findall(r"^(\S+)\s+-\s", section.group(1), re.MULTILINE)
            if not declared_members:
                failures.append(f"根 CLAUDE.md 的 <{block}> 块没有任何成员声明")
            for declared in declared_members:
                if declared.rstrip("/") not in present:
                    failures.append(f"根 CLAUDE.md 的 <{block}> 声明了发布物中不存在的 {declared}")
else:
    # 小包没有根地图可对，它的自证是「Agent 找得到入口、协作者找得到地图」——三者缺一，粉丝下到的就是一个死目录。
    for required in ("SKILL.md", "CLAUDE.md", "scripts/CLAUDE.md"):
        if required not in present:
            failures.append(f"引导 Skill 小包缺少 {required}")

if failures:
    print("发布物含敏感运行态或与 GEB 地图不同构，拒绝发布：", file=sys.stderr)
    for item in failures:
        print(f"  - {item}", file=sys.stderr)
    raise SystemExit(2)
PY
}

pack_archive() {
  # 不用 zip(1)：Info-ZIP 不给非 ASCII 文件名置 UTF-8 标志位（bit 11），Apple 的 zip 又不认 `-UN=UTF8`。
  # 于是 docs/ 下的中文文件名会以「无声明的原始字节」入包，Python zipfile、Windows 资源管理器等
  # 按规范回落到 cp437 解码，用户解压出来就是一串乱码文件名——而安装 Skill 正是用 Python 解的包。
  # 标准库打包在两个平台上行为一致，顺带省掉对外部 zip 二进制的依赖。
  LIFEOS_PACK_BASE="$1" LIFEOS_PACK_TOP="$2" LIFEOS_PACK_ARCHIVE="$3" python3 <<'PY'
import os
import zipfile
from pathlib import Path

base = Path(os.environ["LIFEOS_PACK_BASE"])
top = os.environ["LIFEOS_PACK_TOP"]
archive = Path(os.environ["LIFEOS_PACK_ARCHIVE"])

with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as package:
    package.write(base / top, arcname=top)
    # 排序遍历让同一个 commit 每次都打出同样顺序的包，diff 得动、复现得了。
    for path in sorted((base / top).rglob("*")):
        package.write(path, arcname=path.relative_to(base).as_posix())
PY
}

write_checksum() {
  # 只写 basename：绝对路径既会让 `shasum -a 256 -c` 在别人机器上找不到文件，
  # 也会把打包机的家目录写进跟着 ZIP 一起发出去的校验文件里。
  local name="$1"
  if command -v shasum >/dev/null 2>&1; then
    (cd "$root/dist" && shasum -a 256 "$name" > "$name.sha256" && shasum -a 256 -c "$name.sha256" >/dev/null)
  else
    (cd "$root/dist" && sha256sum "$name" > "$name.sha256" && sha256sum -c "$name.sha256" >/dev/null)
  fi
}

ignored_runtime=$(git -C "$root" ls-files --others --ignored --exclude-standard -- server/runtime)
if ! git -C "$root" diff --quiet \
  || ! git -C "$root" diff --cached --quiet \
  || [ -n "$(git -C "$root" ls-files --others --exclude-standard)" ] \
  || [ -n "$ignored_runtime" ]; then
  printf '%s\n' '工作树含未提交或未跟踪文件；为防止发布物含敏感运行态，拒绝发布。' >&2
  exit 2
fi

# 引导 Skill 是「让 AI 帮你装」这条主推路径的唯一入口；它没进 HEAD 就发布，等于把粉丝挡在门外。
if [ -z "$(git -C "$root" ls-tree --name-only HEAD -- "$skill_source")" ]; then
  printf '%s\n' "HEAD 里没有 $skill_source，引导 Skill 小包无从打起，拒绝发布。" >&2
  exit 2
fi

# 先清掉 dist 里所有历史 LifeOS 产物，再建本次的。产物按版本命名之后，改版当天旧包不会被任何
# 东西覆盖：它会和新包并排躺着，而人是照文件名手工上传的——上一版恰恰可能是加固前那个含家目录
# 绝对路径与 tailnet 主机名的包。范围严格限定在 dist/lifeos-*，dist 之外与非 lifeos 前缀一律不碰。
if [ -d "$root/dist" ]; then
  find "$root/dist" -mindepth 1 -maxdepth 1 -name 'lifeos-*' -exec rm -rf {} +
fi
rm -rf "$out" "$skill_stage"
# zip 对已存在归档是增量更新语义：不先删掉旧包，从 Git 里删除的成员会永久留在 ZIP 里。
rm -f "$archive" "$archive.sha256" "$skill_archive" "$skill_archive.sha256"
mkdir -p "$out" "$skill_stage"
git -C "$root" archive --format=tar HEAD -- "${RELEASE_PATHS[@]}" | tar -xf - -C "$out"

missing=""
for member in "${RELEASE_PATHS[@]}"; do
  if [ ! -e "$out/$member" ]; then
    missing="$missing $member"
  fi
done
if [ -n "$missing" ]; then
  printf '%s\n' "白名单成员未进入发布物，拒绝发布：$missing" >&2
  exit 2
fi

# 内部施工记录不进发布物，发布态根地图必须随之收窄，否则 ZIP 里的地图会指向不存在的成员。
python3 - "$out/CLAUDE.md" <<'PY'
import re
import sys
from pathlib import Path

path = Path(sys.argv[1])
text = path.read_text(encoding="utf-8")
text = re.sub(r"^implementation-(?:notes|report)\.md\s+-\s.*\n", "", text, flags=re.MULTILINE)
path.write_text(text, encoding="utf-8")
PY

inspect_release "$out" "$release_name" full
pack_archive "$root/dist" "$release_name" "$archive"
inspect_release "$archive" "$release_name" full
write_checksum "$release_name.zip"

# --strip-components=1 剥掉 skills/ 这一层，让小包的顶层就是 lifeos-install/：
# 粉丝解压后直接得到一个可以整个丢进 ~/.claude/skills 的目录，不必再自己往里钻一层。
git -C "$root" archive --format=tar HEAD -- "$skill_source" | tar -xf - -C "$skill_stage" --strip-components=1
inspect_release "$skill_stage/$skill_name" "$skill_name" skill
pack_archive "$skill_stage" "$skill_name" "$skill_archive"
inspect_release "$skill_archive" "$skill_name" skill
write_checksum "$(basename "$skill_archive")"

printf '%s\n' "$archive" "$archive.sha256" "$skill_archive" "$skill_archive.sha256"
