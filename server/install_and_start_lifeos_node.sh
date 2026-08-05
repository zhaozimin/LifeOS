#!/usr/bin/env bash
# [INPUT]: 接收可选 LIFEOS_INSTALL_PATH / LIFEOS_PORT / LIFEOS_SETUP_ONLY / LIFEOS_REPLACE_POINTER；
#          依赖同目录 _port_probe.sh 的指针、端口占用与 health 认亲判据，以及 core.config。
# [OUTPUT]: 初始化安全配置、双账本目录、全局指针与 connection-info，向 stdout 交付一次面板地址，
#           然后前台启动 LifeOS（LIFEOS_SETUP_ONLY=1 时只备料不启动，交给自启入口常驻）。
# [POS]: LifeOS 安装入口。放行判据是本机现状而非施工阶段：指针指向别的安装、或端口被无法认亲的服务
#        占用，都在任何写入之前拒绝；两者都干净时首次安装无需任何环境变量。
# [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
set -euo pipefail
script_dir="$(cd "$(dirname "$0")" && pwd)"
source "$script_dir/_port_probe.sh"
root=${LIFEOS_INSTALL_PATH:-$(cd "$script_dir/.." && pwd)}
runtime="$root/server/runtime"
port=${LIFEOS_PORT:-59418}
config="$runtime/config.json"
pointer="$HOME/.config/lifeos/install.json"
lifeos_assert_isolated_home || exit 2
# 两道护栏都必须跑在任何 mkdir/写盘之前：拒绝的那条路径上不能留下半套安装，
# 否则用户下一次重试会撞见一个「已经有 config 了」的中间态而无从判断该信哪个。
if lifeos_pointer_targets_other_install "$pointer" "$root"; then
  if [ "${LIFEOS_REPLACE_POINTER:-}" != "1" ]; then
    printf '%s\n' "本机已有一套在服役的 LifeOS：${pointer} 指向 $(lifeos_pointer_install_path "$pointer")" >&2
    printf '%s\n' "继续安装会把 Agent 的每一条记录改道到本目录，而原面板上什么都不会多出来，因此拒绝。" >&2
    printf '%s\n' "确实要把服役安装换成本目录，请显式设置 LIFEOS_REPLACE_POINTER=1 重跑（原安装的数据不会被动）。" >&2
    exit 2
  fi
  printf '%s\n' "· LIFEOS_REPLACE_POINTER=1：全局指针将从旧安装改指到本目录（旧安装的双账本保持不动）。"
fi
# 「端口上有人以 200 应答」不是身份。只有当前 config 的 Token 能换回落在本安装 runtime 内的
# 双 dbPath，才证明占用方就是本安装自己（升级/重装）；否则一律拒绝——KeepAlive 会把端口
# 冲突放大成无限重启，而覆盖一个认不出来的服务等于拿别人的账本赌。
if lifeos_port_is_occupied "$port"; then
  if [ -f "$config" ] && lifeos_health_identifies_install "$config" "$runtime"; then
    printf '%s\n' "· 端口 ${port} 上运行的已是本安装的 LifeOS。"
    if [ "${LIFEOS_SETUP_ONLY:-}" != "1" ]; then
      printf '%s\n' "服务已在运行，无需重复前台启动；面板地址见 ${runtime}/connection-info.txt。"
      exit 0
    fi
  else
    printf '%s\n' "端口 ${port} 已被一个无法认亲的服务占用，拒绝安装。" >&2
    printf '%s\n' "请先停止占用该端口的程序，或用 LIFEOS_PORT=<其它端口> 重跑。" >&2
    exit 2
  fi
fi
mkdir -p "$runtime/time" "$runtime/finance"
if [ ! -f "$config" ]; then
  # Token 在写盘的同一个进程里生成：既不经 argv 暴露给 ps，也不在 shell 变量里留驻。
  LIFEOS_CONFIG_PORT="$port" python3 - "$root/server" "$config" <<'PY'
import os
import pathlib
import secrets
import sys

sys.path.insert(0, sys.argv[1])
from core.config import write_config

write_config(pathlib.Path(sys.argv[2]), {
    "host": "127.0.0.1",
    "port": int(os.environ["LIFEOS_CONFIG_PORT"]),
    "accessToken": secrets.token_urlsafe(32),
    "allowedHosts": [],
    "timezone": "",
    "timezoneSource": "system",
})
PY
fi
mkdir -p "${HOME}/.config/lifeos"
python3 - "$HOME/.config/lifeos/install.json" "$root" <<'PY'
import json
import os
import pathlib
import sys

path = pathlib.Path(sys.argv[1])
path.parent.mkdir(parents=True, exist_ok=True)
temporary = path.with_suffix(".tmp")
temporary.write_text(json.dumps({"installPath": sys.argv[2]}, ensure_ascii=False) + "\n", encoding="utf-8")
os.chmod(temporary, 0o600)
temporary.replace(path)
PY
connection_info="$runtime/connection-info.txt"
if [ ! -e "$connection_info" ]; then
  python3 - "$root/server" "$config" "$connection_info" <<'PY'
import os
import pathlib
import sys

sys.path.insert(0, sys.argv[1])
from core.config import load_config

config = load_config(pathlib.Path(sys.argv[2]))
target = pathlib.Path(sys.argv[3])
temporary = target.with_name(f".{target.name}.{os.getpid()}.tmp")
# 引号 heredoc 不做 shell 展开，所以这里的 \n 必须是单反斜杠，否则用户拿到的是一行字面量 \n。
temporary.write_text(
    "LifeOS 本地连接（仅此本机文件保存 Token）\n"
    f"Dashboard: http://127.0.0.1:{config['port']}/dashboard/?token={config['accessToken']}\n",
    encoding="utf-8",
)
os.chmod(temporary, 0o600)
temporary.replace(target)
PY
fi

# 首发用户必须在屏幕上看见面板地址。此前安装器写完 0600 的 connection-info.txt 就一个字都不打印：
# 用户面对 TokenGate 的「粘贴 accessToken」输入框，既不知道 Token 存在，也不知道该去哪找它，
# 而那个文件名只写在一份给 Agent 看的部署协议里。这是首次安装 100% 卡死的那一步。
printf '%s\n' '── LifeOS 已就绪 ──'
printf '%s\n' "安装位置：${root}"
grep -m1 '^Dashboard: ' "$connection_info" || printf '%s\n' "面板地址见 ${connection_info}"
printf '%s\n' "上面这行地址含访问密钥，只保存在本机 ${connection_info}（权限 0600），不要转发给任何人。"

if [ "${LIFEOS_SETUP_ONLY:-}" = "1" ]; then
  # 备料与常驻分离：安装 skill 需要先把配置、指针与账本目录准备好，再由 LaunchAgent 拉起后台进程。
  # 前台启动会一直占住调用方，让自动化安装无法继续往下走。
  printf '%s\n' '· 已完成配置（LIFEOS_SETUP_ONLY=1），未启动服务；请用 install_launch_agent.sh 安装开机自启。'
  exit 0
fi
python3 "$root/server/lifeos_node_server.py" --runtime "$runtime"
