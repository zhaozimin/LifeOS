#!/usr/bin/env bash
# [INPUT]: 读取 ~/.config/lifeos/install.json 指针、本安装的 runtime/config.json，以及同目录 _port_probe.sh
#          提供的端口占用与 health 认亲判据。
# [OUTPUT]: 在当面确认（TTY）或显式 LIFEOS_CONFIRM_UNINSTALL=1 之后，只在指针、health 双 dbPath 与 plist
#           三重认亲都指向本目录时卸载 com.lifeos.node；任一环节存疑即 exit 5，双账本在任何分支下都保持不动。
# [POS]: 退役出口；同标签 plist 与「端口有人应答」都不是身份，「无法认亲」也绝不等价于「服务已停止」。
#        必须先卸载再动 runtime——顺序颠倒时 config 已失效，认亲失败会让脚本 exit 5 而不是卸错服务。
#        收尾提示必须挑明 runtime 是安装目录的子目录：删程序本体等于删掉一生的账本且无从恢复。
# [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
set -euo pipefail
script_dir="$(cd "$(dirname "$0")" && pwd)"
source "$script_dir/_port_probe.sh"
install_dir="$(cd "$script_dir/.." && pwd)"
runtime="$script_dir/runtime"
config="$runtime/config.json"
pointer="$HOME/.config/lifeos/install.json"
label=com.lifeos.node
plist="$HOME/Library/LaunchAgents/$label.plist"

# 卸载是用户在场才该发生的事，但「在场」的判据不该是某个施工阶段。
# 有终端就当面问一次；非交互调用（安装 skill、脚本）必须显式带上确认变量。
if [ "${LIFEOS_CONFIRM_UNINSTALL:-}" != "1" ]; then
  if [ -t 0 ]; then
    printf '%s' '即将卸载 LifeOS 的开机自启与全局指针（双账本不会被删除）。确认请输入 yes：'
    read -r answer
    [ "$answer" = "yes" ] || { printf '%s\n' '已取消，未做任何改动。' >&2; exit 2; }
  else
    printf '%s\n' '非交互调用必须显式设置 LIFEOS_CONFIRM_UNINSTALL=1 才能卸载。' >&2
    exit 2
  fi
fi
if [ "${1:-}" = "--purge-data" ]; then
  printf '%s\n' '拒绝自动清除双账本；请在人工恢复流程中处理。' >&2
  exit 2
fi
if [ -n "${1:-}" ]; then
  printf '%s\n' "未知参数：${1}（本脚本只接受无参数调用）" >&2
  exit 2
fi

printf '%s\n' "LifeOS 卸载"
printf '%s\n' "安装位置：${install_dir}"

# ── 1. 指针认亲：先证明「全局指针说的那套安装就是本目录」 ──────────────────────
if [ ! -f "$pointer" ]; then
  printf '%s\n' "缺少全局指针 ${pointer}，无法确认要卸载的是哪一套安装；拒绝卸载。" >&2
  exit 5
fi
if ! LIFEOS_POINTER="$pointer" LIFEOS_EXPECTED_INSTALL="$install_dir" python3 <<'PY'
import json
import os
from pathlib import Path

try:
    payload = json.loads(Path(os.environ["LIFEOS_POINTER"]).read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ValueError("pointer root must be object")
    declared = Path(str(payload.get("installPath") or "")).expanduser().resolve()
    matched = declared == Path(os.environ["LIFEOS_EXPECTED_INSTALL"]).resolve()
except (OSError, ValueError, TypeError, json.JSONDecodeError):
    matched = False
raise SystemExit(0 if matched else 1)
PY
then
  printf '%s\n' "全局指针指向别的安装，本目录无权卸载它：${pointer}" >&2
  exit 5
fi
printf '%s\n' "✓ 全局指针指向本安装"

# ── 2. health 认亲：端口上应答的必须是本安装的双账本，否则失败关闭 ─────────────
if [ ! -f "$config" ]; then
  printf '%s\n' "缺少 ${config}，无法对 health 认亲；请先恢复配置再卸载。" >&2
  exit 5
fi
port=$(lifeos_config_field "$config" port) || {
  printf '%s\n' '运行配置无效，无法确认服务是否仍在使用本账本；拒绝卸载。' >&2
  exit 5
}
service_was_running=0
if lifeos_health_identifies_install "$config" "$runtime"; then
  service_was_running=1
  printf '%s\n' "✓ health 认亲通过：端口 ${port} 上运行的正是本安装的双账本服务"
elif lifeos_port_is_occupied "$port"; then
  printf '%s\n' "端口 ${port} 仍被占用，但本安装的 config 无法对它认亲；拒绝卸载。" >&2
  printf '%s\n' '请先恢复正确的 runtime/config.json，或人工确认并停止占用该端口的进程。' >&2
  exit 5
else
  printf '%s\n' "· 端口 ${port} 空闲，本安装的服务当前未运行"
fi

# ── 3. plist 认亲：同标签不等于同一套安装 ──────────────────────────────────────
if [ ! -f "$plist" ]; then
  printf '%s\n' "· 本机未安装 ${label} 自启定义"
else
  if ! LIFEOS_PLIST="$plist" LIFEOS_EXPECTED_INSTALL="$install_dir" python3 <<'PY'
import os
import plistlib
from pathlib import Path

expected = Path(os.environ["LIFEOS_EXPECTED_INSTALL"]).resolve()
try:
    with Path(os.environ["LIFEOS_PLIST"]).open("rb") as handle:
        payload = plistlib.load(handle)
    if not isinstance(payload, dict):
        raise ValueError("plist root must be dictionary")
    arguments = payload.get("ProgramArguments")
    matched = isinstance(arguments, list) and any(
        isinstance(value, str) and expected in Path(value).expanduser().resolve().parents
        for value in arguments
    )
except (OSError, ValueError, plistlib.InvalidFileException):
    matched = False
raise SystemExit(0 if matched else 1)
PY
  then
    printf '%s\n' "同标签 LaunchAgent 不属于本安装，保持不动：${plist}" >&2
    exit 5
  fi
  # launchd 的 GUI 域按 UID 划分，认不出 HOME：隔离演练里那份 plist 认亲通过之后，
  # 这一句 bootout 卸掉的仍然是用户真正在用的那个 com.lifeos.node。安装侧同理，
  # 所以 install_launch_agent.sh 在隔离态下只写 plist 不注册；退役侧必须对称，
  # 否则一次沙箱演练就会把真实服务停掉，而两边都不会有任何告警。
  if lifeos_home_is_isolated; then
    rm -f "$plist"
    printf '%s\n' "· 隔离运行：已删除副本 plist ${plist}，未执行 bootout（launchd GUI 域无法按 HOME 隔离）。"
  else
    launchctl bootout "gui/$(id -u)/$label" >/dev/null 2>&1 || true
    rm -f "$plist"
    printf '%s\n' "✓ 已卸载本安装的开机自启：${plist}"
  fi
fi

# ── 4. 退役验收：自启移除后端口必须真的空出来，否则本次退役没有完成 ────────────
if [ "$service_was_running" = "1" ]; then
  for _attempt in $(seq 1 12); do
    lifeos_port_is_occupied "$port" || break
    sleep 0.5
  done
  if lifeos_port_is_occupied "$port"; then
    printf '%s\n' "端口 ${port} 上的 LifeOS 仍在运行（可能是人工前台启动的进程）；退役未完成，拒绝收尾。" >&2
    printf '%s\n' '请手动停止该进程后重新执行本脚本。' >&2
    exit 5
  fi
  printf '%s\n' "✓ 已停止 LifeOS 服务，端口 ${port} 已空出"
fi

rm -f "$pointer"
printf '%s\n' "✓ 已移除指向本安装的全局指针：${pointer}"

printf '%s\n' '── 卸载后仍在本机的东西 ──'
if [ -d "$runtime" ]; then
  printf '%s\n' "  ${runtime}（时间与财务双账本、配置与访问密钥）"
fi
if [ -d "$script_dir/logs" ]; then
  printf '%s\n' "  ${script_dir}/logs（运行日志）"
fi
printf '%s\n' "  ${install_dir}（程序本体）"
printf '%s\n' 'LifeOS LaunchAgent 已卸载；runtime 数据保持不动。'
printf '%s\n' ''
# 此前这里写的是「程序本体；确认无需保留后可整体删除」——而 runtime 就在 install_dir 里面。
# 用户照做一次 rm -rf 就永久销毁双账本、全部附件与全部审计快照，而本系统没有恢复入口。
# 这是整套流程里唯一一条会造成不可逆数据全损的路径，提示词必须把它挑明。
printf '%s\n' '⚠️  注意：你的账本就在程序目录里面。'
printf '%s\n' "    ${runtime} 是 ${install_dir} 的子目录。"
printf '%s\n' "    删除 ${install_dir} 会连同双账本、全部附件与全部审计快照一起永久消失，本系统没有恢复入口。"
printf '%s\n' '    要腾出空间，请先完整拷走整个 runtime 目录再删程序本体；'
printf '%s\n' '    只复制单个 .sqlite3 文件会丢数据（账本是 WAL 模式，未合并的写入在 -wal 文件里）。'
printf '%s\n' '    完整的备份与恢复步骤见 docs/备份与恢复.md。'
