#!/usr/bin/env bash
# [INPUT]: 依赖同目录的 lifeos_node_server.py、当前安装根、已生成的 runtime/config.json，
#          以及 LaunchAgent 在 plist 里固化下来的 LIFEOS_PYTHON。
# [OUTPUT]: 以 exec 交给 LifeOS Python 节点，供 LaunchAgent 和人工前台诊断复用。
# [POS]: server 的 macOS 进程启动薄包装；让 launchd 只启动受系统许可的 zsh，Python 由同一用户会话继续执行。
# [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
set -euo pipefail

server_root="$(cd "$(dirname "$0")" && pwd)"
# 解释器由安装期决定并写进 plist：用户是用 PATH 上的 python3（Homebrew/pyenv）装的 openpyxl，
# 这里硬编码 /usr/bin/python3 会让自启进程换一个没有该依赖的解释器，财务导出静默降级成 503。
# 保留 /usr/bin/python3 兜底，是为了让手工前台诊断在没有 plist 的情况下也能跑起来。
exec "${LIFEOS_PYTHON:-/usr/bin/python3}" "$server_root/lifeos_node_server.py" --runtime "$server_root/runtime"
