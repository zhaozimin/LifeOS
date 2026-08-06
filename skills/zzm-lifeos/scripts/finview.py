"""
[INPUT]: 接收财务域写入回执中的 transaction、operation.payload.before、核销与导入结果。
[OUTPUT]: 对外提供含 ¥ 的单行或批量账务 display 文本，以及 attach_display 回执包装。
[POS]: 财务写回执纯函数层；与 timeview 物理分离，防止时间行混入金额。
[PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
"""

from __future__ import annotations

from typing import Any


# 账务行六符号（设计 6.4）。判定一律绑账本状态，不绑命令名：
# 同一条 void 命令，作用在转账上和作用在支出上都必须显示「已作废」。
SYMBOL_VOIDED = "✗"
SYMBOL_TRANSFER = "⇄"
SYMBOL_CORRECTED = "↻"
SYMBOL_BOOKED = "✓"
MARK_PENDING = "⚑"
MARK_SETTLED = "✓⚑"

# 服务端 reimbursement_status 的真实枚举（domains/finance/constants.py）。
# 曾经这里写的是 pending / settled——两个服务端从不产出的值，
# 于是 ⚑ 与 ✓⚑ 两个符号永远不可能出现，而金样正好也喂的是同样的虚构值。
PENDING_STATUSES = frozenset({"draft", "submitted", "rejected"})
SETTLED_STATUSES = frozenset({"reimbursed"})


def _reimbursement_mark(transaction: dict[str, Any]) -> str:
    status = transaction.get("reimbursementStatus")
    if status in SETTLED_STATUSES:
        return f" {MARK_SETTLED}"
    if status in PENDING_STATUSES:
        return f" {MARK_PENDING}"
    return ""


def _symbol(transaction: dict[str, Any]) -> str:
    """已作废优先于一切。

    此前 transfer 的判定排在 deletedAt 之前，于是一笔被撤销的转账渲染成
    「⇄ 已转账」，与成功的转账一字不差——用户据此以为钱转成功了。
    """
    if transaction.get("deletedAt"):
        return SYMBOL_VOIDED
    if transaction.get("kind") == "transfer":
        return SYMBOL_TRANSFER
    created, updated = transaction.get("createdAt"), transaction.get("updatedAt")
    if created and updated and created != updated:
        return SYMBOL_CORRECTED
    return SYMBOL_BOOKED


_SEP = " · "  # 与时间行同一个分隔符：两域回执并排出现时读起来是一套东西


def _category_name(transaction: dict[str, Any]) -> str:
    """category 可能是 {name}、{id,name} 或历史遗留的裸字符串，三种都要认。"""
    category = transaction.get("category")
    if isinstance(category, dict):
        return str(category.get("name") or "").strip()
    return str(category or "").strip()


def _money_flow(transaction: dict[str, Any]) -> str:
    """钱从哪来到哪去。

    转账必须画出两端——它唯一的风险就是方向记反，而只印一个账户名时用户看不出
    是转出还是转入。支出/收入各只有一端，印那一端即可。
    """
    source = str(transaction.get("fromAccountName") or "").strip()
    target = str(transaction.get("toAccountName") or "").strip()
    if transaction.get("kind") == "transfer" and source and target:
        return f"{source}→{target}"
    return str(transaction.get("accountName") or source or target or "").strip()


def _line(transaction: dict[str, Any]) -> str:
    """一行说清：多少钱、什么事、走哪个账户、归了哪一类。

    账户与分类此前不在回执里，而它们恰恰是最容易被 Agent 推断错、又最需要用户
    扫一眼就能否决的两个字段——分类归错了统计会偏，账户记错了余额会偏，两者
    当时不说，事后都要靠对账才发现。缺字段就省略该段，绝不印占位符。
    """
    amount = float(transaction.get("amount") or 0)
    title = str(transaction.get("title") or "").strip()
    head = f"{_symbol(transaction)} ¥{amount:.2f} {title}".strip()
    parts = [head] + [value for value in (_money_flow(transaction), _category_name(transaction)) if value]
    return _SEP.join(parts) + _reimbursement_mark(transaction)


def _looks_like_transaction(value: object) -> bool:
    return isinstance(value, dict) and {"id", "kind", "amount"}.issubset(value)


def _voided_from_operation(receipt: dict[str, Any]) -> str | None:
    """删除类回执只带 operation.payload.before，用它还原出被作废的那一行。"""
    operation = receipt.get("operation")
    if not isinstance(operation, dict):
        return None
    previous = (operation.get("payload") or {}).get("before")
    if not isinstance(previous, dict):
        return None
    voided = dict(previous)
    voided["deletedAt"] = operation.get("occurredAt") or "deleted"
    return _line(voided)


def render(receipt: Any) -> str | None:
    """把写回执渲染成一行账务 display；任何异常都降级为不给 display。

    降级绝不能反过来把「已落库的写入」报成失败——这一层只负责好看，
    不负责裁定成败，成败由 HTTP 状态码与 lifeconn 的错误二分类决定。
    """
    try:
        if not isinstance(receipt, dict):
            return None

        # 显式的 transaction 键本身就是意图声明，只要是 dict 就渲染；
        # 未包裹的回执才需要 id/kind/amount 三件套确认它确实是一笔交易，
        # 免得把 settle/import 那类汇总回执误当成交易行。
        wrapped = receipt.get("transaction")
        transaction = wrapped if isinstance(wrapped, dict) else (receipt if _looks_like_transaction(receipt) else None)
        if transaction is not None:
            return _line(transaction)

        voided = _voided_from_operation(receipt)
        if voided is not None:
            return voided

        if "incomeId" in receipt:
            settled = int(receipt.get("settled") or 0)
            unsettled = int(receipt.get("unsettled") or 0)
            invalid = len(receipt.get("invalid") or [])
            tail = f"，{invalid} 笔无法核销" if invalid else ""
            return f"{MARK_SETTLED} 已核销 {settled} 笔，撤销 {unsettled} 笔{tail}"

        if "imported" in receipt:
            imported = int(receipt.get("imported") or 0)
            failed = int(receipt.get("failed") or 0)
            tail = f"，{failed} 笔失败" if failed else ""
            return f"{SYMBOL_BOOKED} 已导入 {imported} 笔账务{tail}"

        # PATCH 报销状态只回 {ok,id,status}，没有交易体，但它确实改了账本状态。
        if "status" in receipt and "id" in receipt:
            status = receipt.get("status")
            if status in SETTLED_STATUSES:
                return f"{MARK_SETTLED} 报销已核销"
            if status in PENDING_STATUSES:
                return f"{MARK_PENDING} 报销状态改为 {status}"
            return f"{SYMBOL_BOOKED} 报销标记已取消"

        transactions = receipt.get("transactions")
        if isinstance(transactions, list):
            return f"{SYMBOL_BOOKED} 已处理 {len(transactions)} 笔账务"
    except Exception:
        return None
    return None


def attach_display(receipt: Any) -> Any:
    """给回执挂上 display；渲染不出来就原样返回，绝不构造假回执。"""
    rendered = render(receipt)
    if rendered is None or not isinstance(receipt, dict):
        return receipt
    return {**receipt, "display": rendered}
