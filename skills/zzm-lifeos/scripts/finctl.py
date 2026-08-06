"""
[INPUT]: 依赖 lifeconn 的安全连接与 finview 的账务回执渲染。
[OUTPUT]: 对外提供 expense、income、transfer、correct、void、settle、transactions、habits 和受限 request 财务命令，
          三条新建命令带 --allow-duplicate 逃生阀。
[POS]: 财务命令边界；金额、kind、账户存在性与信用卡资金方向在本地判定，跨域路径由 lifeconn 二次拒绝；
       重复提交的窗口判定归服务端，本层只负责把用户的明确确认转成 allowDuplicate 字段。
[PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any
from urllib.parse import quote

from finview import render
from lifeconn import LifeOSHTTPError, LifeOSTransportError, request_api, request_write_api


PREFIX = "/v1/fin"
CREDIT_CARD_TYPE = "creditCard"
ACCOUNT_KEYS = ("accountName", "fromAccountName", "toAccountName")
# 兜底词表只在结构判据看不见的那一格生效（见 _reject_credit_card_repayment），
# 匹配前统一小写并删空白，因此英文词条以无空格形态收录。
REPAYMENT_WORDS = ("还款", "还卡", "还信用卡", "信用卡账单", "账单还款", "cardpayment", "repayment", "payoffcard")


def _payload(path: str) -> dict[str, Any]:
    try:
        value = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ValueError("payload 文件必须是 JSON 对象。") from exc
    if not isinstance(value, dict):
        raise ValueError("payload 文件必须是 JSON 对象。")
    return value


def _identifiers(path: str) -> list[str]:
    try:
        value = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ValueError("ID 文件必须是 JSON 数组。") from exc
    if not isinstance(value, list) or not all(isinstance(item, str) and item.strip() for item in value):
        raise ValueError("ID 文件必须是非空字符串组成的 JSON 数组。")
    return [item.strip() for item in value]


def _live_accounts(configuration: dict[str, Any]) -> dict[str, dict[str, Any]]:
    """账户存在性与账户类型共用同一份索引，避免两处各自定义「什么算有效账户」。"""
    index: dict[str, dict[str, Any]] = {}
    for item in configuration.get("accounts", []) or []:
        if not isinstance(item, dict) or item.get("deletedAt"):
            continue
        name = str(item.get("name") or "").strip()
        if name:
            index[name] = item
    return index


def _named_accounts(body: dict[str, Any]) -> list[str]:
    return [str(body[key]).strip() for key in ACCOUNT_KEYS if str(body.get(key) or "").strip()]


def _looks_like_repayment(title: Any) -> bool:
    normalized = "".join(str(title or "").split()).lower()
    return any(word in normalized for word in REPAYMENT_WORDS)


def _reject_credit_card_repayment(
    body: dict[str, Any],
    accounts: dict[str, dict[str, Any]],
    external_inflow: bool,
) -> None:
    """
    还款判据首先看资金方向与账户类型，与标题措辞无关。

    「还款」「还信用卡」「信用卡账单」「card payment」这类词表永远补不全，把正确性
    押在用户怎么措辞上等于把护栏交给运气。结构判据有三条：

    - 钱从信用卡出去（expense 落在信用卡账户上）是刷卡消费，本来就该这么记，绝不拦；
    - 钱进入信用卡账户才是还款方向。它必须写成 transfer，否则账本凭空多出一笔收入，
      而且看不见这笔钱从哪个自有账户流出，两边余额同时失真；
    - 非 transfer 却同时写出两个自有账户，形态本身就是一笔转账被记错了 kind。

    商户退款、返现同样是钱进入信用卡，但资金来自外部而非自有账户，那是真实的 income。
    这一种结构上与还款不可分辨，交给 `--external-inflow` 显式声明放行：判据仍然留在脚本里，
    只是把无法结构区分的那一步交还给明确声明，而不是交还给标题里有没有「还款」两个字。

    只剩一格结构永远看不见：expense 单独落在信用卡上——刷卡消费与「把还款记成卡上支出」
    形态完全相同。这一格保留收窄后的词表兜底：结构说是消费、措辞说是还款，二者自相矛盾，
    交给用户澄清比默默写歪账本安全。词表只在这一格生效，绝不参与上面三条判据。
    """
    kind = str(body.get("kind") or "")
    if kind == "transfer":
        return
    named = _named_accounts(body)
    cards = [name for name in named if (accounts.get(name) or {}).get("type") == CREDIT_CARD_TYPE]
    if not cards:
        return
    if len(set(named)) > 1:
        raise ValueError(
            f"「{'、'.join(cards)}」是信用卡，而本笔同时写出了来源与目标账户："
            "自有账户之间的资金往来必须用 transfer 记录。"
        )
    inflow = str(body.get("toAccountName") or body.get("accountName") or "").strip()
    if kind == "income" and inflow in cards and not external_inflow:
        raise ValueError(
            f"资金流入信用卡「{inflow}」属于还款方向：请改用 transfer 写出来源账户与目标信用卡；"
            "若这笔确实是商户退款、返现等外部流入，加 --external-inflow 明确声明。"
        )
    if kind == "expense" and _looks_like_repayment(body.get("title")):
        raise ValueError(
            f"这笔落在信用卡「{cards[0]}」上的支出被描述成还款：刷卡消费才是卡上支出，"
            "还款请改用 transfer 写出来源账户与目标信用卡。"
        )


def _effective_transaction(transaction_id: str, patch: dict[str, Any]) -> dict[str, Any]:
    """库里现状叠上本次补丁，得到这次写入实际会产出的形态。

    correct 是部分补丁，常常不带 kind 与账户三字段；护栏若只看补丁字面，
    `kind == ""` 会让还款判据整条失效——一笔 income 就能被挪进信用卡账户，
    正是 _reject_credit_card_repayment 明写要阻止的形态。
    护栏必须判「写完会变成什么样」，不是「这次传了什么」。
    """
    listed = request_api("GET", f"{PREFIX}/transactions", domain="fin")
    items = listed if isinstance(listed, list) else (listed or {}).get("transactions", [])
    current = next((item for item in items if isinstance(item, dict) and item.get("id") == transaction_id), None)
    if current is None:
        raise ValueError(f"流水 {transaction_id} 不存在；请先用 transactions 核查。")
    merged = {key: current.get(key) for key in ("kind", "title", "accountName", "fromAccountName", "toAccountName", "category")}
    merged.update({key: value for key, value in patch.items() if value is not None})

    # 复刻服务端的方向字段推导（service.transaction_row_from_payload）：
    # 显式 accountName 会连带改写对应方向字段，旧方向值只是尚未被覆盖的残留。
    # 不复刻的话，护栏看到的是「一笔同时写出两个账户」这种服务端根本不会产出的形态，
    # 于是诊断出一条不存在的问题，真正的还款方向反而没被指名。
    stated = str(patch.get("accountName") or "").strip()
    if stated:
        if merged.get("kind") == "income" and "toAccountName" not in patch:
            merged["toAccountName"], merged["fromAccountName"] = stated, None
        elif merged.get("kind") == "expense" and "fromAccountName" not in patch:
            merged["fromAccountName"], merged["toAccountName"] = stated, None
    return merged


def _validate_master_data(body: dict[str, Any], *, external_inflow: bool = False, effective: dict[str, Any] | None = None) -> None:
    """写前只读配置对拍，拒绝把未知账户、未知分类或记错 kind 的信用卡还款送到服务端。

    存在性校验只看 body（本次真正提交的字段），免得「改个标题」被历史上已删除的
    账户名连坐；结构性还款判据看 effective（写完的形态），否则部分补丁能绕过它。
    """
    configuration = request_api("GET", f"{PREFIX}/configuration", domain="fin")
    accounts = _live_accounts(configuration)
    categories = {
        str(item.get("name"))
        for item in configuration.get("categories", []) or []
        if isinstance(item, dict) and not item.get("deletedAt")
    }
    for name in _named_accounts(body):
        if name not in accounts:
            raise ValueError(f"账户「{name}」不存在；请先向用户确认主数据。")
    category = body.get("category")
    if isinstance(category, dict) and category.get("name") and str(category["name"]) not in categories:
        raise ValueError(f"分类「{category['name']}」不存在；请先向用户确认主数据。")
    _reject_credit_card_repayment(effective or body, accounts, external_inflow)


def _write(method: str, path: str, body: dict[str, Any]) -> int:
    try:
        receipt = request_write_api(method, path, domain="fin", payload=body)
    except LifeOSHTTPError as exc:
        print(json.dumps({"ok": False, "status": exc.status, **exc.payload}, ensure_ascii=False))
        return 2
    except LifeOSTransportError as exc:
        print(json.dumps({"ok": False, "error": "result_unknown", "message": str(exc)}, ensure_ascii=False))
        return 3
    display = render(receipt)
    print(json.dumps({**receipt, **({"display": display} if display else {})}, ensure_ascii=False))
    return 0


def _external_inflow_flag(command: argparse.ArgumentParser) -> None:
    command.add_argument(
        "--external-inflow",
        action="store_true",
        help="声明这笔流入信用卡的钱来自商户退款、返现等外部来源，不是从自有账户还款。",
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="LifeOS 财务命令")
    commands = parser.add_subparsers(dest="command", required=True)
    for kind in ("expense", "income", "transfer"):
        command = commands.add_parser(kind)
        command.set_defaults(kind=kind)
        command.add_argument("--title", required=True)
        command.add_argument("--amount", required=True, type=float)
        command.add_argument("--payload-file")
        # 服务端在一个短时间窗内拒绝完全相同的第二笔（409 duplicate_record）；窗口长度是服务端的判据，
        # 这里刻意不复述秒数——两处各写一个数字，改了一处就开始互相说谎。
        # 这个开关是逃生阀而不是重试开关：收到 409 就自动加它重发，等于把护栏原地拆掉。
        command.add_argument(
            "--allow-duplicate",
            action="store_true",
            help="已向用户确认这确实是另一笔金额、账户、标题都相同的真实记录，放行服务端的重复提交闸。",
        )
        if kind == "income":
            _external_inflow_flag(command)

    correct = commands.add_parser("correct")
    correct.add_argument("--id", required=True)
    correct.add_argument("--payload-file", required=True)
    _external_inflow_flag(correct)

    void = commands.add_parser("void")
    void.add_argument("--id", required=True)
    void.add_argument("--reason", required=True)

    settle = commands.add_parser("settle")
    settle.add_argument("--income-id", required=True)
    settle.add_argument("--settle-ids-file", required=True)
    settle.add_argument("--unsettle-ids-file")

    commands.add_parser("transactions")
    commands.add_parser("habits")

    request = commands.add_parser("request")
    request.add_argument("method", choices=["GET", "POST", "PUT", "PATCH", "DELETE"])
    request.add_argument("path")
    request.add_argument("--payload-file")
    return parser


def _settle_body(args: argparse.Namespace) -> dict[str, Any]:
    return {
        "incomeId": args.income_id,
        "settleIds": _identifiers(args.settle_ids_file),
        "unsettleIds": _identifiers(args.unsettle_ids_file) if args.unsettle_ids_file else [],
    }


# 主数据整表重写有专属的受确认入口（POST /v1/fin/agent/operations 强制 userConfirmation）。
# PUT /v1/fin/configuration 会 DELETE 后整表重灌且服务端不要求任何确认字段——
# 面板走它是因为键盘前坐着人，确认是隐含的；Agent 走它则等于绕开「AI 先问后写」，
# 一次请求就能硬删掉全部账户与分类（非软删，不可逆），已落库交易随即变成孤儿。
_MASTER_DATA_REWRITE = (("PUT", f"{PREFIX}/configuration"),)


def _reject_unconfirmed_master_data_rewrite(method: str, path: str) -> None:
    if (method, path.split("?", 1)[0]) in _MASTER_DATA_REWRITE:
        raise ValueError(
            "request 不得整表重写财务主数据：该路径没有 userConfirmation 闸门，"
            "一次提交即可硬删全部账户与分类。请改用 POST /v1/fin/agent/operations "
            "逐项增删改，并带上用户确认原话。"
        )


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    external_inflow = bool(getattr(args, "external_inflow", False))
    try:
        if args.command in {"expense", "income", "transfer"}:
            if args.amount < 0:
                raise ValueError("金额必须非负。")
            body = _payload(args.payload_file) if args.payload_file else {}
            body.update({"title": args.title, "amount": args.amount, "kind": args.kind})
            # 只在明确声明时才带这个字段：默认不发，服务端的重复闸就永远是开着的。
            if args.allow_duplicate: body["allowDuplicate"] = True
            _validate_master_data(body, external_inflow=external_inflow)
            return _write("POST", f"{PREFIX}/transactions", body)
        if args.command == "correct":
            body = _payload(args.payload_file)
            _validate_master_data(
                body, external_inflow=external_inflow,
                effective=_effective_transaction(args.id, body),
            )
            return _write("PUT", f"{PREFIX}/transactions/{args.id}", body)
        if args.command == "void":
            path = f"{PREFIX}/transactions/{args.id}?reason={quote(args.reason, safe='')}"
            return _write("DELETE", path, {})
        if args.command == "settle":
            return _write("POST", f"{PREFIX}/reimbursements/settle", _settle_body(args))
        if args.command == "transactions":
            print(json.dumps(request_api("GET", f"{PREFIX}/transactions", domain="fin"), ensure_ascii=False))
            return 0
        if args.command == "habits":
            print(json.dumps(request_api("GET", f"{PREFIX}/habits", domain="fin"), ensure_ascii=False))
            return 0
        body = _payload(args.payload_file) if args.payload_file else None
        method = args.method.upper()
        shared_readonly = method == "GET" and args.path == "/v1/health"
        if not args.path.startswith(PREFIX + "/") and not shared_readonly:
            raise ValueError("request 只能访问 /v1/fin/* 或 GET /v1/health。")
        _reject_unconfirmed_master_data_rewrite(method, args.path)
        if method != "GET":
            # 写方法必须走 _write：它是「4xx 明确未写 / 传输失败结果未知」这条纪律的唯一实现。
            # 此前 request 直接调 request_api，5xx 与断连一律退化成退出码 2、且丢掉
            # error: result_unknown——而 fin-bookkeeping.md 正是拿「退出码 3 + result_unknown」
            # 当作「去核查而不是去重发」的机器判据，Agent 会照着把结果未知当成明确未写入。
            return _write(method, args.path, body or {})
        print(json.dumps(request_api(method, args.path, domain="fin", payload=body), ensure_ascii=False))
        return 0
    except (ValueError, LifeOSHTTPError, LifeOSTransportError) as exc:
        print(json.dumps({"ok": False, "message": str(exc)}, ensure_ascii=False))
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
