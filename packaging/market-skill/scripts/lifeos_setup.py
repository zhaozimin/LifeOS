#!/usr/bin/env python3
"""
[INPUT]: 依赖同目录（构建时复制进来的）lifeos_bootstrap.py 与本 Skill 自带的 ../payload/。
[OUTPUT]: 对外提供市场形态的安装运维入口：install/status/uninstall/detect 四个子命令，
          install 恒定走离线 payload，并把承载本 Skill 的宿主目录从技能注入名单里排除。
[POS]: market-skill 的薄封装；它不实现任何安装逻辑——放行判据、清单校验、原子部署、
       health 回滚全部在 lifeos_bootstrap.py，本文件只负责把「市场形态的两个既定事实」
       （payload 就在身边、自己已经住在某个宿主里）翻译成 bootstrap 的命令行参数。
[PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
"""

from __future__ import annotations

import sys
from pathlib import Path

SCRIPTS_DIR = Path(__file__).resolve().parent
SKILL_DIR = SCRIPTS_DIR.parent

sys.path.insert(0, str(SCRIPTS_DIR))

import lifeos_bootstrap  # noqa: E402


def main(argv: "list | None" = None) -> int:
    arguments = list(sys.argv[1:] if argv is None else argv)
    if arguments and arguments[0] == "install":
        # payload 与排除宿主都是本形态的结构事实，不是用户选项：
        # 用户显式给了 --payload 才尊重（隔离演练需要），--exclude-host 恒定追加——
        # 本 Skill 所在的宿主里已经有完整记录协议，再注进一份 zzm-lifeos 就是双触发面。
        if "--payload" not in arguments:
            payload = SKILL_DIR / "payload"
            if not (payload / "manifest.json").is_file():
                print("✗ 本 Skill 的 payload 不完整，无法离线安装。", file=sys.stderr)
                print("  下一步：请重新从市场下载安装本 Skill；也可以改用 GitHub 安装路径。", file=sys.stderr)
                return 2
            arguments += ["--payload", str(payload)]
        arguments += ["--exclude-host", str(SKILL_DIR.parent)]
    return lifeos_bootstrap.main(arguments)


if __name__ == "__main__":
    raise SystemExit(main())
