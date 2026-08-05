#!/usr/bin/env python3
"""
[INPUT]: 依赖 core 的 fail-closed 配置、构建身份与 HTTP 边界，依赖 time/finance 域各自的 Ledger 初始化与健康投影。
[OUTPUT]: 对外提供 LifeOS 单进程启动入口、`/v1/health` 和隔离测试可复用的应用工厂。
[POS]: server 的组合根；只编排共享层与域边界，不承载任何时间或财务业务算法。
[PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path
from typing import Sequence

from core.build import calculate_build_id
from core.config import load_config
from core.httpd import Application, Route, create_server, health_handler
from core.sqlite import Ledger
from domains.finance.service import ensure_schema as ensure_finance_schema
from domains.finance.service import health_projection as finance_health
from domains.finance.routes_read import build_routes as build_finance_read_routes
from domains.finance.routes_write import build_routes as build_finance_write_routes
from domains.time.routes import build_routes as build_time_routes
from domains.time.service import reconcile_timezone_state
from domains.time.service import ensure_schema as ensure_time_schema
from domains.time.service import health_projection as time_health


ROOT = Path(__file__).resolve().parent


def _version() -> str:
    """版本真源是仓库根的 VERSION，发布物命名与校验和都取自那里。

    此前这里硬编码 "0.1.0"，于是 health 对外自报的版本与用户下载的 lifeos-1.0.0.zip
    对不上——用户报障时给出的版本号会把人引向错误的代码。VERSION 在发布白名单内，
    随包交付，所以读得到；读不到时退回 unknown 而不是编一个数字，
    因为「装的是哪一版」这件事宁可承认不知道，也不能给出一个不成立的答案。
    """
    try:
        return (ROOT.parent / "VERSION").read_text(encoding="utf-8").strip() or "unknown"
    except OSError:
        return "unknown"


VERSION = _version()


def create_application(runtime_dir: Path) -> Application:
    """构造隔离应用；调用方必须自行提供配置与随机测试端口。"""
    config = load_config(runtime_dir / "config.json")
    time_ledger = Ledger("time", runtime_dir / "time" / "time.sqlite3", runtime_dir / "time" / "audit")
    finance_ledger = Ledger(
        "finance", runtime_dir / "finance" / "finance.sqlite3", runtime_dir / "finance" / "audit"
    )
    config = ensure_time_schema(time_ledger, config)
    config = reconcile_timezone_state(time_ledger, config)
    ensure_finance_schema(finance_ledger)

    app = Application(
        config=config,
        build_id=calculate_build_id(ROOT),
        version=VERSION,
        web_root=ROOT / "web",
        time_ledger=time_ledger,
        finance_ledger=finance_ledger,
        time_health=lambda: time_health(time_ledger, config),
        finance_health=lambda: finance_health(finance_ledger),
    )
    app.register(Route("GET", "/v1/health", health_handler))
    app.register(*build_time_routes(time_ledger, config))
    app.register(*build_finance_read_routes(finance_ledger), *build_finance_write_routes(finance_ledger))
    return app


def run(runtime_dir: Path) -> None:
    """按不可逆的启动顺序起服，任一配置或账本问题都拒绝监听。"""
    os.umask(0o077)
    app = create_application(runtime_dir)
    server = create_server(app)
    print(
        f"LifeOS 已监听 http://{app.config['host']}:{app.config['port']} "
        f"(build {app.build_id})",
        flush=True,
    )
    try:
        server.serve_forever()
    finally:
        server.server_close()


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="LifeOS 单进程本地节点")
    parser.add_argument("--runtime", type=Path, default=ROOT / "runtime", help="隔离 runtime 根目录")
    arguments = parser.parse_args(argv)
    try:
        run(arguments.runtime.resolve())
    except RuntimeError as exc:
        print(f"LifeOS 启动失败：{exc}", file=sys.stderr, flush=True)
        return 2
    except OSError as exc:
        print(f"LifeOS 无法监听：{exc}", file=sys.stderr, flush=True)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
