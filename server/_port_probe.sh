#!/usr/bin/env bash
# [INPUT]: 读取 runtime/config.json 的 port 与 accessToken、~/.config/lifeos/install.json 指针与 passwd 家目录；
#          Token 只经 LIFEOS_PROBE_TOKEN 环境变量传递。
# [OUTPUT]: 对外提供 lifeos_config_field / lifeos_port_is_occupied / lifeos_health_probe /
#           lifeos_health_identifies_install / lifeos_home_is_isolated / lifeos_assert_isolated_home /
#           lifeos_pointer_targets_other_install / lifeos_pointer_install_path；直接执行时充当人工 health 诊断探针。
# [POS]: install_and_start_lifeos_node.sh、install_launch_agent.sh 与 uninstall_lifeos.sh 共享的只读认亲层；
#        「同名 plist」和「端口有人应答」都不是身份，只有当前 config 的 Token 换回双 dbPath 且都落在本安装
#        runtime 内，才构成覆盖安装或停服的授权。三个脚本的放行判据一律取自本层的**本机现状**
#        （指针指向谁、端口上是谁、HOME 是不是真的），而不取自任何施工阶段标志。
# [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
set -euo pipefail

# 一律走环境变量而非 argv：同用户的其他进程能从 ps 读到完整命令行，却读不到子进程环境。
lifeos_config_field() {
  local config_path="$1" field="$2"
  LIFEOS_CONFIG_PATH="$config_path" LIFEOS_CONFIG_FIELD="$field" python3 <<'PY'
import json
import os
from pathlib import Path

path = Path(os.environ["LIFEOS_CONFIG_PATH"])
field = os.environ["LIFEOS_CONFIG_FIELD"]
try:
    payload = json.loads(path.read_text(encoding="utf-8"))
except (OSError, ValueError):
    raise SystemExit(f"无法读取配置：{path}")
if not isinstance(payload, dict):
    raise SystemExit(f"配置顶层必须是 JSON 对象：{path}")
value = payload.get(field)
if value in (None, "", []):
    raise SystemExit(f"配置缺少 {field}：{path}")
print(value)
PY
}

# 返回 0 表示端口已被占用；调用方必须放在 if 条件里，否则 set -e 会把「端口空闲」当成失败。
lifeos_port_is_occupied() {
  LIFEOS_PROBE_PORT="$1" python3 <<'PY'
import os
import socket

probe = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
probe.settimeout(0.5)
try:
    probe.connect(("127.0.0.1", int(os.environ["LIFEOS_PROBE_PORT"])))
except OSError:
    raise SystemExit(1)
finally:
    probe.close()
raise SystemExit(0)
PY
}

# 期望 runtime 非空时会核对双 dbPath 的归属：光是「有人以 200 应答」不足以证明那是本安装的账本。
lifeos_health_probe() {
  LIFEOS_PROBE_PORT="$1" LIFEOS_PROBE_RUNTIME="${2:-}" python3 <<'PY'
import http.client
import json
import os
from pathlib import Path

port = int(os.environ["LIFEOS_PROBE_PORT"])
token = os.environ.get("LIFEOS_PROBE_TOKEN") or ""
expected = os.environ.get("LIFEOS_PROBE_RUNTIME") or ""
if not token:
    raise SystemExit("缺少 LIFEOS_PROBE_TOKEN，无法对 health 认亲")

connection = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
connection.request("GET", "/v1/health", headers={
    "Authorization": f"Bearer {token}",
    "Host": f"127.0.0.1:{port}",
})
response = connection.getresponse()
body = response.read().decode("utf-8")
connection.close()
if response.status != 200:
    raise SystemExit(f"health 未通过认证：{response.status}")
payload = json.loads(body)
domains = payload.get("domains") or {}
ledgers = {name: (domains.get(name) or {}).get("dbPath") for name in ("time", "finance")}
if not all(ledgers.values()):
    raise SystemExit("health 未同时报告 time 与 finance 的 dbPath")
if expected:
    root = Path(expected).resolve()
    for name, value in ledgers.items():
        if root not in Path(value).resolve().parents:
            raise SystemExit(f"{name} 账本 {value} 不在期望 runtime {root} 内")
print(json.dumps(payload, ensure_ascii=False))
PY
}

lifeos_health_identifies_install() {
  local config_path="$1" runtime_dir="$2" port
  port=$(lifeos_config_field "$config_path" port) || return 1
  # 声明与赋值分开：local X=$(...) 会用 local 的退出码盖掉读取失败。
  local LIFEOS_PROBE_TOKEN
  LIFEOS_PROBE_TOKEN=$(lifeos_config_field "$config_path" accessToken) || return 1
  export LIFEOS_PROBE_TOKEN
  lifeos_health_probe "$port" "$runtime_dir" >/dev/null 2>&1
}

# 返回 0 表示 HOME 已被换离真实用户目录。launchd 的 GUI 域按 UID 划分、不按 HOME，
# 所以「隔离」对它完全无效——判据在这里独立成函，是为了让自启安装器能据此
# 拒绝 bootout/bootstrap，而不是靠调用方自觉。
lifeos_home_is_isolated() {
  local real_home
  real_home=$(python3 -c 'import os,pwd;print(pwd.getpwuid(os.getuid()).pw_dir)') || return 1
  [ "$(cd "${HOME}" 2>/dev/null && pwd -P)" != "$(cd "$real_home" 2>/dev/null && pwd -P)" ]
}

lifeos_assert_isolated_home() {
  # LIFEOS_ISOLATED_HOME=1 是调用方的**声明**，本函数只负责核实这个声明是不是真的：
  # 忘记覆盖 HOME 的一次演练就会把真实用户的 ~/.config/lifeos/install.json
  # 改指到副本，此后每一条记录都落进副本账本而回执照常成功。
  # 没有声明隔离就是普通安装，无需核实——真正拦住误装的是指针与端口两道状态判据，
  # 而不是「现在是不是某个施工阶段」。
  [ "${LIFEOS_ISOLATED_HOME:-}" = "1" ] || return 0
  if ! lifeos_home_is_isolated; then
    printf '%s\n' "声明了 LIFEOS_ISOLATED_HOME=1，但 HOME 仍是真实用户目录 $(python3 -c 'import os,pwd;print(pwd.getpwuid(os.getuid()).pw_dir)')；拒绝改动真实安装。" >&2
    return 1
  fi
  return 0
}

# 返回 0 表示全局指针存在、可解析，且指向**别的**安装根；调用方必须放在 if 条件里。
# 指针是「本机哪一套安装在服役」的唯一真源：指向别处时继续安装，会让此后每一条
# timectl/finctl 写入静默改道到新副本，而用户在原面板上什么都不会多出来。
lifeos_pointer_targets_other_install() {
  local pointer_path="$1" expected_install="$2"
  [ -f "$pointer_path" ] || return 1
  LIFEOS_POINTER="$pointer_path" LIFEOS_EXPECTED_INSTALL="$expected_install" python3 <<'PY'
import json
import os
from pathlib import Path

try:
    payload = json.loads(Path(os.environ["LIFEOS_POINTER"]).read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ValueError("pointer root must be object")
    declared = Path(str(payload.get("installPath") or "")).expanduser().resolve()
except (OSError, ValueError, TypeError, json.JSONDecodeError):
    # 指针存在却读不懂，同样不是「可以随便覆盖」——交给调用方当冲突处理。
    raise SystemExit(0)
raise SystemExit(1 if declared == Path(os.environ["LIFEOS_EXPECTED_INSTALL"]).resolve() else 0)
PY
}

# 读出全局指针里声明的安装根；读不出时输出空串。只用于给用户看清冲突对象。
lifeos_pointer_install_path() {
  LIFEOS_POINTER="$1" python3 <<'PY'
import json
import os
from pathlib import Path

try:
    payload = json.loads(Path(os.environ["LIFEOS_POINTER"]).read_text(encoding="utf-8"))
    print(str(payload.get("installPath") or "") if isinstance(payload, dict) else "")
except (OSError, ValueError, TypeError, json.JSONDecodeError):
    print("")
PY
}

if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
  lifeos_health_probe "${1:?用法：LIFEOS_PROBE_TOKEN=... bash _port_probe.sh <port> [expected-runtime]}" "${2:-}"
fi
