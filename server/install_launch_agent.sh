#!/usr/bin/env bash
# [INPUT]: 接收明确的 LIFEOS_INSTALL_PATH、可选 LIFEOS_PYTHON 与现有 runtime/config.json；
#          依赖同目录 _port_probe.sh 的端口、health 认亲与 HOME 隔离判据。
# [OUTPUT]: 在端口护栏通过后以 XML 转义的路径原子写入 com.lifeos.node LaunchAgent 并 bootstrap；
#           plist 固化解释器绝对路径，校验失败给出中文诊断且不留临时文件。
# [POS]: LifeOS 的 macOS 自启安装器；不生成旧 FinOS 的 0.0.0.0 手工补丁。
#        launchd 的 GUI 域按 UID 而非 HOME 划分，因此隔离 HOME 下只产出 plist、绝不注册。
# [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
set -euo pipefail
script_dir="$(cd "$(dirname "$0")" && pwd)"
source "$script_dir/_port_probe.sh"
lifeos_assert_isolated_home || exit 2
root=${LIFEOS_INSTALL_PATH:?必须显式设置 LIFEOS_INSTALL_PATH}
runtime="$root/server/runtime"
config="$runtime/config.json"
[ -f "$config" ] || { printf '%s\n' '缺少 LifeOS runtime/config.json；请先运行 install_and_start_lifeos_node.sh。' >&2; exit 2; }
port=$(lifeos_config_field "$config" port) || { printf '%s\n' '无法从 config.json 解析端口。' >&2; exit 2; }
# 解释器必须在安装期定死并写进 plist。此前 plist 只启动 zsh、由启动脚本硬编码 /usr/bin/python3，
# 而用户是照文档用 PATH 上的 python3（Homebrew/pyenv 很常见）装的 openpyxl：
# 前台跑导出正常，装完自启重启后换了解释器，财务导出静默降级成 503——
# 现象是「昨天能导出今天不能」，且没有任何提示指向解释器差异。
python_bin=${LIFEOS_PYTHON:-$(command -v python3 2>/dev/null || true)}
if [ -z "$python_bin" ] || [ ! -x "$python_bin" ]; then
  printf '%s\n' '找不到可执行的 python3；请先安装 Python 3.9+ 或显式设置 LIFEOS_PYTHON=<解释器绝对路径>。' >&2
  exit 2
fi
python_bin="$(cd "$(dirname "$python_bin")" && pwd -P)/$(basename "$python_bin")"
if ! "$python_bin" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 9) else 1)'; then
  printf '%s\n' "${python_bin} 版本低于 3.9，LifeOS 无法在它上面运行；请设置 LIFEOS_PYTHON 指向更新的解释器。" >&2
  exit 2
fi
# plist 里 KeepAlive=true 会在端口冲突时无限重启并刷爆日志，所以占用护栏必须在写 plist 之前。
if lifeos_port_is_occupied "$port"; then
  if lifeos_health_identifies_install "$config" "$runtime"; then
    printf '%s\n' "· 端口 ${port} 上运行的已是本安装的 LifeOS，继续覆盖安装自启。"
  else
    printf '%s\n' "端口 ${port} 已被无法认亲的服务占用；KeepAlive 会导致无限重启，拒绝安装自启。" >&2
    printf '%s\n' '请先按 P7 退役占用方并验尸，或改用未被占用的端口。' >&2
    exit 2
  fi
fi
label=com.lifeos.node
plist="$HOME/Library/LaunchAgents/$label.plist"
mkdir -p "$(dirname "$plist")"
logs="$root/server/logs"
mkdir -p "$logs"
chmod 700 "$logs"
stdout="$logs/lifeos-node.launchd.out.log"
stderr="$logs/lifeos-node.launchd.err.log"
touch "$stdout" "$stderr"
chmod 600 "$stdout" "$stderr"
# plist 是 XML：安装路径里的 & < > 直插进 <string> 会让文档非良构。
# 之前的表现是 plutil 吐一句英文原话就 exit 1，LifeOS 侧一个字的诊断都没有，
# 而 $plist.tmp 永久留在 ~/Library/LaunchAgents（uninstall_lifeos.sh 只删正式 plist）。
# 转义在前、lint 在后：转义负责让合法路径能用，lint 只作兜底。
xml_escape() {
  printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'
}
label_xml=$(xml_escape "$label")
program_xml=$(xml_escape "$root/server/launch_lifeos_node_foreground.sh")
python_xml=$(xml_escape "$python_bin")
workdir_xml=$(xml_escape "$root/server")
stdout_xml=$(xml_escape "$stdout")
stderr_xml=$(xml_escape "$stderr")
temporary="$plist.tmp"
# 任何退出路径都不留中间态；成功时 mv 之后它已不存在，rm -f 是无害的。
trap 'rm -f "$temporary"' EXIT
cat > "$temporary" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$label_xml</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/zsh</string>
    <string>$program_xml</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>LIFEOS_PYTHON</key><string>$python_xml</string>
  </dict>
  <key>WorkingDirectory</key><string>$workdir_xml</string>
  <key>StandardOutPath</key><string>$stdout_xml</string>
  <key>StandardErrorPath</key><string>$stderr_xml</string>
  <key>ProcessType</key><string>Background</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict>
</plist>
EOF
if ! lint_output=$(plutil -lint "$temporary" 2>&1); then
  printf '%s\n' "生成的 LaunchAgent plist 未通过 plutil 校验；已丢弃临时文件，${plist} 未被改动。" >&2
  printf '%s\n' "请检查安装路径能否在 XML 中表达：LIFEOS_INSTALL_PATH=${root}" >&2
  printf '%s\n' "plutil 原文：${lint_output}" >&2
  exit 2
fi
mv "$temporary" "$plist"

# launchd 的 GUI 域按 UID 划分，不按 HOME —— 隔离 HOME 对它完全无效。
# 隔离态下 bootout 会按 label 卸掉当前注册的 com.lifeos.node（也就是用户真正在用的服务），
# bootstrap 再把同一 label 指向沙箱副本：真实账本从此停止接收记录且无任何告警。
# 判据取自 HOME 是否真的被换离 passwd 家目录，而不取自调用方的声明或任何阶段标志。
if lifeos_home_is_isolated; then
  printf '%s\n' "· 已写出 ${plist}（未注册）：launchd GUI 域无法按 HOME 隔离，隔离运行下不执行 bootout/bootstrap。"
  exit 0
fi

launchctl bootout "gui/$(id -u)" "$plist" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$plist"
printf '%s\n' "已安装开机自启 ${label}（解释器 ${python_bin}）。"
printf '%s\n' "验证：服务应在几秒内监听 127.0.0.1:${port}；失败时看 ${stderr}。"
