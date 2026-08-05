"""
[INPUT]: 无；保存与 FinOS 4778a6b 对齐的财务主数据默认值和有限枚举。
[OUTPUT]: 对外提供默认账户、分类、设置、MVP 功能边界、重复提交窗口和财务域固定值。
[POS]: finance 的静态语义层；service、store 和各算法只从这里取得默认账本形状，绝不依赖 time 域。
[PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
"""

from __future__ import annotations

from typing import Any


ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024
IMPORT_MAX_BYTES = 20 * 1024 * 1024
# 单笔写入的重复提交窗口。窗口本身就是判据：一次操作被提交两遍必然相隔秒级，
# 而真实记两笔同样的钱（今天第二杯 ¥25 咖啡）总是隔着数十分钟以上。
# 取值太小挡不住 tailscale 超时后的重发，太大就会把用户真实的第二笔误判成重复。
DUPLICATE_WINDOW_SECONDS = 90
MVP_SINGLE_CURRENCY = True
MVP_BASE_CURRENCY = "CNY"
MVP_RECURRING_PAUSED = True


def base64_body_limit(payload_bytes: int) -> int:
    """把「文件体积上限」换算成「HTTP 请求体上限」。

    附件与账单都以 base64 塞进 JSON，二进制过一次 base64 膨胀 4/3；再留 64KB
    给文件名、mime 和 JSON 结构本身。少了这一层换算，服务层写着 10MB 上限，
    HTTP 层却在 1MB 就把请求体拒了——检查永远执行不到，手机拍的收据一张也传不上去。
    """
    return payload_bytes * 4 // 3 + 64 * 1024
HUMAN_OR_SYSTEM_SOURCES = frozenset({"manual", "dashboard", "adjustment", "recurring"})
INTERNAL_CATEGORY_NAMES = frozenset({"余额调整"})
VALID_OWNERSHIPS = frozenset({"company", "personal", "unspecified"})
VALID_LEDGER_MODES = frozenset({"personal", "dual"})
REIMBURSEMENT_STATUSES = frozenset({"notApplicable", "draft", "submitted", "reimbursed", "rejected"})
RECURRING_FREQUENCIES = frozenset({"daily", "weekly", "monthly", "yearly"})


def default_categories() -> list[dict[str, Any]]:
    """FinOS v2.2.0 的新手分类；保留 id 与关键词以维持导入建议行为。"""
    entries = (
        ("food", "餐饮", "fork.knife", "#FF8C42", "支出", ["饭", "午饭", "晚饭", "咖啡", "奶茶", "早餐", "餐", "火锅"]),
        ("transport", "交通", "tram.fill", "#4F7CFF", "支出", ["打车", "地铁", "高铁", "机票", "机场", "滴滴", "车费"]),
        ("housing", "住房", "house.fill", "#6F5BD3", "支出", ["房租", "物业", "水电", "酒店", "住宿"]),
        ("shopping", "购物", "bag.fill", "#E64980", "支出", ["购物", "淘宝", "衣服", "鞋", "日用", "京东"]),
        ("entertainment", "娱乐", "gamecontroller.fill", "#F06543", "支出", ["电影", "游戏", "聚餐", "娱乐", "门票"]),
        ("health", "医疗", "cross.case.fill", "#FF5D73", "支出", ["医院", "药", "体检", "挂号"]),
        ("social", "人情往来", "gift.fill", "#E8590C", "支出", ["红包", "礼金", "份子", "请客", "送礼", "人情"]),
        ("salary", "工资", "banknote.fill", "#2F9E44", "收入", ["工资", "薪水", "月薪", "发工资", "奖金", "年终奖"]),
        ("redpacket", "红包", "gift.fill", "#37B24D", "收入", ["红包", "收红包", "转账收款", "收款"]),
        ("other-income", "其他收入", "plus.circle.fill", "#1C7ED6", "收入", ["收入", "报销到账", "退款", "利息", "返现"]),
        ("transfer", "转账", "arrow.left.arrow.right.square.fill", "#546E7A", "支出", ["转账", "转入", "转出"]),
    )
    out: list[dict[str, Any]] = []
    for suffix, name, image, color, direction, keywords in entries:
        item = {"id": f"category-{suffix}", "name": name, "systemImage": image, "tintHex": color,
                "direction": direction, "keywords": keywords}
        if suffix == "salary": item["defaultAccountId"] = "account-salary"
        if suffix == "redpacket": item["defaultAccountId"] = "account-wechat"
        out.append(item)
    return out


def default_accounts() -> list[dict[str, Any]]:
    return [
        {"id": "account-wechat", "name": "微信支付", "type": "digitalWallet", "currency": "CNY", "openingBalance": 0.0, "threshold": 0.0, "brand": "wechat", "tintHex": "#07C160", "symbolName": "message.fill", "keywords": ["微信", "wechat"], "ownership": "personal"},
        {"id": "account-alipay", "name": "支付宝", "type": "digitalWallet", "currency": "CNY", "openingBalance": 0.0, "threshold": 0.0, "brand": "alipay", "tintHex": "#1677FF", "symbolName": "qrcode", "keywords": ["支付宝", "alipay"], "ownership": "personal"},
        {"id": "account-salary", "name": "工资卡", "type": "debitCard", "currency": "CNY", "openingBalance": 0.0, "threshold": 0.0, "brand": "custom", "tintHex": "#5C6BC0", "symbolName": "building.columns.fill", "keywords": ["工资", "工资卡", "银行卡", "储蓄卡", "借记卡"], "ownership": "personal"},
    ]


def default_exchange_rates() -> dict[str, Any]:
    return {"baseCurrency": "CNY", "rates": {"CNY": 1.0, "USD": 7.20, "HKD": 0.92, "EUR": 7.80, "JPY": 0.048}, "autoFetch": False, "provider": "open.er-api.com", "lastFetchSource": None, "lastFetchError": None, "updatedAt": None}


def default_tax_config() -> dict[str, Any]:
    return {"vatRate": 0.03, "personalThreshold": 60000, "personalRate": 0.20, "sebRate": 0.10, "currency": "CNY", "note": "本数据仅供参考，请以专业税务人员意见为准。"}


def default_finance_sources() -> list[dict[str, Any]]:
    return [
        {"id": "source-salary", "name": "工资", "defaultAccountId": "account-salary", "note": "月薪 / 劳务，默认入工资卡。", "tintHex": "#5C6BC0"},
        {"id": "source-redpacket", "name": "红包", "defaultAccountId": "account-wechat", "note": "微信红包 / 转账收款。", "tintHex": "#37B24D"},
        {"id": "source-reimbursement", "name": "报销回款", "defaultAccountId": "account-salary", "note": "报销打回来的钱，默认入工资卡；到账后把原支出的报销状态改为已报销。", "tintHex": "#E8A33D"},
    ]


def default_projects() -> list[dict[str, Any]]:
    return [
        {"id": "project-life-necessary", "name": "必要开销", "direction": "支出", "group": "必要开销", "note": "固定且必要的生活支出。", "trackingEnabled": False},
        {"id": "project-life-extra", "name": "额外开销", "direction": "支出", "group": "额外开销", "note": "弹性和可选的生活消费。", "trackingEnabled": False},
    ]


def default_ledger_settings() -> dict[str, Any]:
    return {"bookMode": "personalAssistant", "ledgerMode": "personal", "defaultCurrency": "CNY", "baseUnit": "yuan", "timezone": "Asia/Shanghai", "allowManualEntry": True, "projects": default_projects(), "financeSources": default_finance_sources(), "counterparties": [], "taxConfig": default_tax_config(), "exchangeRates": default_exchange_rates(), "updatedAt": None}
