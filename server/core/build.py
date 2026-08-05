"""
[INPUT]: 依赖 server 根目录下可发布的 Python 源文件。
[OUTPUT]: 对外提供排序清单式 calculate_build_id，标记当前运行进程的真实代码身份。
[POS]: core 的部署认亲原语；新增模块会自动进入哈希，避免旧双文件硬编码遗漏。
[PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
"""

from __future__ import annotations

import hashlib
from pathlib import Path


def calculate_build_id(server_root: Path) -> str:
    """按相对路径排序后逐文件哈希，跳过运行时与构建产物。"""
    digest = hashlib.sha256()
    paths = sorted(
        path for path in server_root.rglob("*.py")
        if "runtime" not in path.parts and "__pycache__" not in path.parts
    )
    if not paths:
        raise RuntimeError("服务端没有 Python 源文件，无法生成 buildId。")
    for path in paths:
        relative = path.relative_to(server_root).as_posix().encode("utf-8")
        digest.update(relative)
        digest.update(b"\0")
        digest.update(path.read_bytes())
        digest.update(b"\0")
    return digest.hexdigest()[:16]
