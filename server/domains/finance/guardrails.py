"""
[INPUT]: 依赖 finance 连接内主数据读取、views 的 category 形状投影、currency 的布尔归一与人工/系统来源反转白名单。
[OUTPUT]: 对外提供交易引用校验、主数据操作的用户确认护栏和单笔写入的重复提交时间窗闸。
[POS]: finance 的 AI 写入边界；它只返回 DomainError 所需事实，不接触 HTTP 或 time 账本。
       写入面的判据一律落在这里而不是 service，service 只负责编排顺序。
[PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
"""

from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timezone
from typing import Any

from core.errors import DomainError
from domains.finance.constants import DUPLICATE_WINDOW_SECONDS, HUMAN_OR_SYSTEM_SOURCES, INTERNAL_CATEGORY_NAMES
from domains.finance.currency import coerce_bool
from domains.finance.store import list_categories, load_ledger_settings
from domains.finance.views import category_name, list_accounts


# 「同一笔」的身份由这几列构成：金额、方向、币种、账户三字段与标题。
# 备注、标签、项目、分类不参与——双击重发时它们必然也一样，写进判据只会让
# 一个无关字段的差异把护栏整条关掉。
DUPLICATE_IDENTITY_COLUMNS = ("kind", "amount", "currency", "account_name", "from_account_name", "to_account_name", "title")


def normalize_master_name(value: object) -> str:
    """主数据重名判定口径：去首尾空白、折叠内部空白、大小写不敏感。

    与时间域 rules.normalize_name 同义但各自独立——两域不互相导入。
    """
    return " ".join(str(value or "").split()).casefold()


def assert_unique_master_names(items: list[Any], label: str) -> None:
    """同名主数据一律拒绝。

    财务比时间域更凶险：余额是**按账户名**聚合的（views.current_balance_for_account
    以 account_name 匹配流水），两条同名账户会各自算出同一笔钱，
    净资产直接翻倍，而流水里查不到任何对应的那一笔。
    改名撞车更隐蔽——账户数量不变，用户只是「改了个名字」，净资产就翻倍。
    此前财务侧唯一的冲突判据是「主数据 ID 已存在」，名字从不查重。
    """
    seen: set[str] = set()
    for item in items:
        if not isinstance(item, dict) or item.get("deletedAt"):
            continue
        key = normalize_master_name(item.get("name"))
        if not key:
            continue
        if key in seen:
            raise DomainError(
                "duplicate_master_name",
                f"已存在同名{label}「{str(item.get('name')).strip()}」；余额按名字聚合，重名会让净资产翻倍。",
                status=409,
            )
        seen.add(key)


def source_requires_guardrail(source: object) -> bool:
    value = str(source or "").strip().lower()
    if not value: return True
    if value == "import" or value.startswith("import-"): return False
    return value not in HUMAN_OR_SYSTEM_SOURCES


def collect_master_registry(connection: sqlite3.Connection) -> dict[str, list[str]]:
    settings = load_ledger_settings(connection)
    return {
        "accounts": [str(item.get("name")) for item in list_accounts(connection) if item.get("name") and not item.get("deletedAt")],
        "categories": [str(item.get("name")) for item in list_categories(connection) if item.get("name") and not item.get("deletedAt")],
        "sources": [str(item.get("name")) for item in settings.get("financeSources", []) if item.get("name") and not item.get("deletedAt")],
        "projects": [str(item.get("name")) for item in settings.get("projects", []) if item.get("name")],
    }


def _category_name(row: sqlite3.Row | dict[str, Any] | None) -> str:
    """从交易行里取出类别名，容忍任何 category 形状。

    category 是写入面最外层的用户/Agent 输入，落库前没有形状闸：传成裸字符串、
    数组或数字都会原样序列化进 category_json。此前这里直接 `.get("name")`，
    非对象形状抛出的是 AttributeError——不在捕获元组里，于是校验语句自己被打穿，
    整个请求返回 {"error":"internal_error"}，而不是带 issues/valid/agentInstruction
    的 422。那套 422 回执正是「AI 先问后写」的运转机制：形状错一个字符，
    Agent 就拿不到「向用户逐项列出选择并等待明确答复」的指令，只看到一句服务器内部错误。
    形状口径与报告层共用 views.category_name，裸字符串按「只给了名字」解释。
    """
    if row is None: return ""
    try:
        raw = row.get("category_json", "") if isinstance(row, dict) else row["category_json"]
        return category_name(json.loads(raw or "{}"))
    except (json.JSONDecodeError, KeyError, IndexError, TypeError): return ""


def validate_agent_transaction_refs(connection: sqlite3.Connection, row: dict[str, Any], existing_row: sqlite3.Row | None = None) -> None:
    """按基线反转白名单校验；失败抛出稳定 422 DomainError。"""
    if not source_requires_guardrail(row.get("source")): return
    registry, issues = collect_master_registry(connection), []
    def changed(key: str) -> bool:
        return existing_row is None or str(row.get(key) or "") != str(existing_row[key] or "")
    def check(kind: str, field: str, value: object, valid: set[str]) -> None:
        text = str(value or "").strip()
        if text and text not in valid: issues.append({"field": field, "value": text, "kind": kind})
    accounts = set(registry["accounts"])
    if changed("account_name"): check("account", "accountName", row.get("account_name"), accounts)
    if changed("from_account_name"): check("account", "fromAccountName", row.get("from_account_name"), accounts)
    if changed("to_account_name"): check("account", "toAccountName", row.get("to_account_name"), accounts)
    category, old_category = _category_name(row), _category_name(existing_row)
    if category and category != old_category and category not in INTERNAL_CATEGORY_NAMES and category not in set(registry["categories"]): issues.append({"field": "category", "value": category, "kind": "category"})
    if changed("source_name"): check("financeSource", "sourceName", row.get("source_name"), set(registry["sources"]))
    if changed("project_name"): check("project", "projectName", row.get("project_name"), set(registry["projects"]))
    if not issues: return
    labels = {"account": "账户", "category": "类别", "financeSource": "资金来源", "project": "项目"}
    detail = "、".join(f"{labels[item['kind']]}「{item['value']}」" for item in issues)
    raise DomainError("unknown_master_data", f"{detail} 不存在。AI 不得静默创建或修改主数据——请先向用户确认。", status=422, issues=issues, valid=registry, agentInstruction="向用户逐项列出选择并等待明确答复，禁止代替用户决定：1) 新建该主数据；2) 改用现有项；3) 放弃本笔记录。")


def _as_datetime(value: object) -> datetime | None:
    """把库里的 ISO 时刻读成可比较的绝对时间；读不出来就当作无法判定。

    created_at 有历史包袱：P2 的 schema 迁移给旧行填的默认值是空串。
    读不出来时返回 None 并在调用处放行——护栏宁可漏挡一笔，也不能因为一行脏数据
    把用户所有的正常记账都拒掉。
    """
    try: parsed = datetime.fromisoformat(str(value or "").replace("Z", "+00:00"))
    except ValueError: return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def _within_duplicate_window(left: object, right: object) -> bool:
    first, second = _as_datetime(left), _as_datetime(right)
    if first is None or second is None: return False
    return abs((first - second).total_seconds()) <= DUPLICATE_WINDOW_SECONDS


def assert_not_recent_duplicate(connection: sqlite3.Connection, row: dict[str, Any], payload: dict[str, Any]) -> None:
    """挡住「一次操作被提交两遍」，放行「真的记两笔同样的钱」。

    时间域因 overlap 不变量意外免疫，财务域没有任何天然不变量：同一个 body 连发两次
    就落成两条不同 uuid 的行，¥25 的午饭变成 ¥50，而两条记录在面板上一模一样，
    用户过几天根本认不出该删哪条。触发路径极日常——面板点「保存」时网络抖动再点一次、
    tailscale 超时后客户端重发。

    判据只有窗口，没有内容黑名单：一次操作被提交两遍必然相隔秒级，真实的第二杯咖啡
    总是隔着数十分钟。窗口之外一律放行，这条护栏永远不会变成「同一天不许记两笔同样的钱」。

    occurred_at 参与判定但**不要求逐字相等**：面板的新建 payload 根本不带 occurredAt
    （见 web-dashboard/src/fin/components/TransactionEditSheet.tsx），服务端按 now_record_iso()
    现填，两次点击于是天然差出几百毫秒。要求逐字相等等于让护栏在最需要它的那条路径上恒不触发。
    因此改判「两个发生时刻同样落在这个窗口里」——显式传了 occurredAt 的调用方仍然逐字相等，
    隔天补记的账则因为发生时刻差得远而放行。

    逃生阀是 `allowDuplicate: true`：用户真要连记两笔同样的钱，Agent 收到 409 后
    向用户确认，再带这个字段重发。护栏只负责逼出这次确认，不负责替用户决定。

    只有新建路径该调用它。update 是用户指名改哪一笔，把一笔改成与另一笔相同是合法的更正；
    账单导入天然有同额同日多笔（每天同一家便利店），且它已有自己的重复判据。
    任一处顺手套上，用户的正常操作就会开始被 409 拒绝。
    """
    if coerce_bool(payload.get("allowDuplicate"), False): return
    clause = " AND ".join(f"{column} IS ?" for column in DUPLICATE_IDENTITY_COLUMNS)
    values = [row.get(column) for column in DUPLICATE_IDENTITY_COLUMNS]
    rows = connection.execute(f"SELECT id,occurred_at,created_at FROM transactions WHERE deleted_at IS NULL AND {clause} ORDER BY created_at DESC", values).fetchall()
    for existing in rows:
        if not _within_duplicate_window(existing["created_at"], row.get("created_at")): continue
        if existing["occurred_at"] != row.get("occurred_at") and not _within_duplicate_window(existing["occurred_at"], row.get("occurred_at")): continue
        raise DomainError(
            "duplicate_record",
            f"{DUPLICATE_WINDOW_SECONDS} 秒内已记过一笔完全相同的「{row.get('title')}」，本次未写入。",
            status=409, existingId=existing["id"], windowSeconds=DUPLICATE_WINDOW_SECONDS,
            agentInstruction="这是明确的「未写入」，禁止自动重试。先向用户确认这是不是同一笔；确认确实是两笔不同的钱，再带 allowDuplicate: true 重发。",
        )


def require_user_confirmation(payload: dict[str, Any]) -> str:
    confirmation = str(payload.get("userConfirmation") or "").strip()
    if not confirmation: raise DomainError("user_confirmation_required", "缺少 userConfirmation：AI 不得自行增改主数据，须先向用户提出建议并获得明确同意。", status=422, agentInstruction="说明实体、名称和关键字段；用户明确同意后携带其原话重发请求。")
    return confirmation
