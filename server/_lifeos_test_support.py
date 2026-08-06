"""
[INPUT]: 依赖仓库目录布局与标准库 socket；不读取任何 runtime、配置或生产端口。
[OUTPUT]: 对外提供仓库/服务端/Skill 脚本根路径、受保护端口常量、一次性回环端口分配，
          以及部署套件三个测试模块的源码清单。
[POS]: server 测试套件的唯一共享底座；三份 test_lifeos_* 与 test_finance_attachment_upload
       从这里取路径与端口，避免同一段发现逻辑被复制成三份而各自漂移。
       文件名以下划线开头，因此不会被 `unittest discover` 的 `test*.py` 收进用例。
[PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
"""

from __future__ import annotations

import socket
import sys
from pathlib import Path


SERVER_ROOT = Path(__file__).resolve().parent
REPOSITORY_ROOT = SERVER_ROOT.parent
SKILL_SCRIPTS = REPOSITORY_ROOT / "skills/zzm-lifeos/scripts"
PROTECTED_DEVELOPMENT_PORT = 59418

# 部署套件按关注点拆成三份，端口纪律这类「整套都必须成立」的断言要对它们同时成立；
# 支撑模块自己也在内，因为它同样会被打包进发布物。
DEPLOYMENT_SUITE_SOURCES = (
    "_lifeos_test_support.py",
    "test_lifeos_deployment.py",
    "test_lifeos_skill_golden.py",
    "test_lifeos_migration_rehearsal.py",
)

# Skill 脚本以顶层模块名被导入（timectl / finctl / lifeconn ...），与 CI 里
# `cd skills/zzm-lifeos/scripts && unittest discover` 的导入方式保持一致。
if str(SKILL_SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SKILL_SCRIPTS))


def reserve_test_port() -> int:
    """取得一次性回环端口，并排除任何现役服务端口。"""
    while True:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
            probe.bind(("127.0.0.1", 0))
            port = int(probe.getsockname()[1])
        if port not in {51440, PROTECTED_DEVELOPMENT_PORT}:
            return port
