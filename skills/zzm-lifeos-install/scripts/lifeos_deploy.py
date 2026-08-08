"""
[INPUT]: 依赖已校验的 LifeOS 发布目录、安装目标与 fresh/upgrade 裁定。
[OUTPUT]: 对外提供可恢复中断状态的同父目录原子部署，升级时只把旧 server/runtime 带入新版。
[POS]: lifeos-install 的文件系统事务层；bootstrap 负责下载/停服编排，本模块保证拷贝失败不污染现有安装。
[PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
"""

from __future__ import annotations

import os
import shutil
import sys
import time
from pathlib import Path
from typing import Callable


RUNTIME_RELATIVE = Path("server/runtime")


def _upgrade_paths(target: Path) -> tuple[Path, Path]:
    return target.parent / f".{target.name}.upgrade-incoming", target.parent / f".{target.name}.upgrade-backup"


def _discard(path: Path) -> None:
    if path.is_symlink() or path.is_file():
        path.unlink()
    elif path.is_dir():
        shutil.rmtree(path)


def recover_interrupted_upgrade(target: Path) -> None:
    """重跑时把上次断电留下的三种状态收敛回可裁定安装。"""
    incoming, backup = _upgrade_paths(target)
    if not target.exists() and backup.exists():
        if backup.is_symlink():
            raise OSError(f"升级备份 {backup} 不应是符号链接")
        _discard(incoming)
        os.replace(backup, target)
        return
    if target.exists() and backup.exists():
        _discard(target)
        os.replace(backup, target)
    _discard(incoming)


def rollback_upgrade(target: Path) -> None:
    """新版尚未通过 health 时恢复旧程序与旧 runtime；备料阶段失败则无事可做。"""
    incoming, backup = _upgrade_paths(target)
    _discard(incoming)
    if backup.exists():
        _discard(target)
        os.replace(backup, target)


def commit_upgrade(target: Path) -> None:
    """只在新版认证 health 通过后退役旧安装。"""
    _, backup = _upgrade_paths(target)
    _discard(backup)


def quiesce_upgrade(target: Path, port: int, *, port_is_occupied: Callable[..., bool], run_step: Callable[..., tuple[int, str]]) -> None:
    """复制 runtime 与交换目录前停止旧服务，避免 SQLite/附件在复制中继续变化。"""
    if not port_is_occupied(port): return
    run_step(["launchctl", "bootout", f"gui/{os.getuid()}/com.lifeos.node"], target)
    deadline = time.monotonic() + 8
    while port_is_occupied(port, timeout=0.1) and time.monotonic() < deadline: time.sleep(0.1)
    if port_is_occupied(port, timeout=0.1): raise OSError(f"无法安全停止端口 {port} 上的旧 LifeOS")


def restore_previous_upgrade(target: Path, *, run_step: Callable[..., tuple[int, str]], python_executable: str | None = None) -> None:
    """停止未通过 health 的新服务，回滚旧目录并尽力恢复其 LaunchAgent。"""
    run_step(["launchctl", "bootout", f"gui/{os.getuid()}/com.lifeos.node"], target)
    rollback_upgrade(target)
    if (target / "server/install_launch_agent.sh").is_file():
        run_step(["bash", "server/install_launch_agent.sh"], target, {"LIFEOS_INSTALL_PATH": str(target), "LIFEOS_PYTHON": python_executable or shutil.which("python3") or sys.executable})


def deploy(source: Path, target: Path, verdict: str) -> None:
    """在同一文件系统暂存并改名；upgrade 的调用方必须先停止旧服务。"""
    target.parent.mkdir(parents=True, exist_ok=True)
    if verdict == "fresh":
        incoming = target.parent / f".{target.name}.incoming-{os.getpid()}"
        _discard(incoming)
        try:
            shutil.copytree(source, incoming)
            if target.is_dir():
                target.rmdir()
            os.replace(incoming, target)
        finally:
            _discard(incoming)
        return

    recover_interrupted_upgrade(target)
    incoming, backup = _upgrade_paths(target)
    try:
        shutil.copytree(source, incoming, symlinks=True)
        old_runtime = target / RUNTIME_RELATIVE
        if old_runtime.is_dir():
            shutil.copytree(old_runtime, incoming / RUNTIME_RELATIVE, dirs_exist_ok=True, symlinks=True)
        os.replace(target, backup)
        try:
            os.replace(incoming, target)
        except BaseException:
            os.replace(backup, target)
            raise
    finally:
        _discard(incoming)
