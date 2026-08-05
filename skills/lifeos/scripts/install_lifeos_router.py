"""
[INPUT]: 依赖目标 Hermes SOUL.md 文本与 LifeOS 托管块版本。
[OUTPUT]: 对外提供幂等安装、旧 TIMEOS 托管块清除、托管块真实行数统计与四断言 JSON 检查。
[POS]: Skill 的常驻路由安装器；只替换受标记保护的文本，保留块外人格并拒绝残缺旧块。
[PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
"""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path


VERSION = "0.1.0"
START, END = "<!-- LIFEOS_MANAGED_ROUTER_START -->", "<!-- LIFEOS_MANAGED_ROUTER_END -->"
OLD_START, OLD_END = "<!-- TIMEOS_MANAGED_ROUTER_START -->", "<!-- TIMEOS_MANAGED_ROUTER_END -->"
# 托管块的上限行数：Hermes 常驻层越长越容易被模型忽略，deployment.md 把它写成上线闸门之一。
MAX_MANAGED_LINES = 20


def managed_block() -> str:
    return "\n".join((START, f"LifeOS router v{VERSION}", "活动/时间表达与花了、买了、收到、转账、工资、报销表达都先 skill_view(name=lifeos)。", "时间真实调用 timectl.py；财务真实调用 finctl.py；混合句必须拆两笔。", "逐行原样转达 display；没有 display 视为未成功写入。", "5xx、超时、断连先只读核查，禁止重试。", END))


def _replace(text: str, start: str, end: str, replacement: str) -> str:
    starts, ends = text.count(start), text.count(end)
    if starts != ends: raise RuntimeError("发现残缺托管块，请人工修复后重试。")
    if starts > 1: raise RuntimeError("发现多个托管块，拒绝猜测应保留哪一个。")
    pattern = re.compile(re.escape(start) + r".*?" + re.escape(end), re.DOTALL)
    return pattern.sub(replacement, text) if starts else text.rstrip() + "\n\n" + replacement + "\n"


def render(text: str) -> str:
    without_old = _replace(text, OLD_START, OLD_END, "") if OLD_START in text or OLD_END in text else text
    return _replace(without_old, START, END, managed_block())


def managed_block_line_count(text: str) -> int:
    """数出 `text` 里托管块**实际**占用的行数；没有完整块时记 0。

    这里必须量被检查的文本，不是量 managed_block() 自己 —— 后者是编译期常量，
    与 20 比较恒为真。--check 的四条断言是 deployment.md 明写的上线闸门，
    而它面对的正是「块被人手改写、撑大或塞进额外指令」的 SOUL.md：
    量常量等于对所有被篡改的托管块一律放行。
    """
    match = re.search(re.escape(START) + r".*?" + re.escape(END), text, re.DOTALL)
    return match.group(0).count("\n") + 1 if match else 0


def check(text: str) -> dict[str, bool | int]:
    lines = managed_block_line_count(text)
    return {"single_block": text.count(START) == text.count(END) == 1, "no_legacy_timeos_block": OLD_START not in text and OLD_END not in text, "version_match": f"v{VERSION}" in text, "line_count_within_limit": 0 < lines <= MAX_MANAGED_LINES}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="安装 LifeOS Hermes 路由")
    parser.add_argument("--soul", type=Path, default=Path.home() / ".hermes" / "SOUL.md")
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args(argv)
    original = args.soul.read_text(encoding="utf-8") if args.soul.exists() else ""
    if args.check:
        print(json.dumps(check(original), ensure_ascii=False)); return 0
    rendered = render(original)
    args.soul.parent.mkdir(parents=True, exist_ok=True)
    temporary = args.soul.with_suffix(".tmp")
    temporary.write_text(rendered, encoding="utf-8")
    temporary.replace(args.soul)
    print(json.dumps(check(rendered), ensure_ascii=False)); return 0


if __name__ == "__main__": raise SystemExit(main())
