"""
[INPUT]: 依赖 core HTTP Route/Response、finance Ledger 与 finance.service 只读操作。
[OUTPUT]: 对外提供 11 条 `/v1/fin/*` 读取路由契约，修改历史默认完整返回，及由契约驱动的构造函数。
[POS]: finance 读面适配层；dashboard overview 保留 E9 兼容调用，当前 MVP 中该调用是不写数据的暂停回执。
[PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
"""

from __future__ import annotations

import re
from urllib.parse import quote

from typing import Final
from urllib.parse import parse_qs

from core.httpd import Request, Response, Route, routes_from_contract
from core.sqlite import Ledger
from domains.finance import service

ROUTES: Final[tuple[tuple[str, str], ...]] = (("GET","/v1/fin/transactions"),("GET","/v1/fin/attachments/{id}"),("GET","/v1/fin/recurring"),("GET","/v1/fin/summary/month"),("GET","/v1/fin/dashboard/overview"),("GET","/v1/fin/budget/status"),("GET","/v1/fin/habits"),("GET","/v1/fin/configuration"),("GET","/v1/fin/audit/events"),("GET","/v1/fin/export/xlsx"),("GET","/v1/fin/export/tax-report"))

def _query(request: Request) -> dict[str,str]: return {key: values[0] for key,values in parse_qs(request.query,keep_blank_values=True).items() if values}


# 附件名与 MIME 都是用户可控的：中文名会让 http.server 的 latin-1 头编码在
# 状态行发出之后才炸，产出「200 + 正确 Content-Type + 错误 JSON 体」的畸形响应；
# CRLF 则能提前终结头块，把 nosniff 等安全头挤进响应体。二者都在这里收口。
_MIME_SAFE = re.compile(r"^[A-Za-z0-9!#$%&'*+.^_`|~-]+/[A-Za-z0-9!#$%&'*+.^_`|~-]+$")


def _safe_mime(value: object) -> str:
    text = str(value or "").strip()
    return text if _MIME_SAFE.match(text) else "application/octet-stream"


def _content_disposition(original_name: object) -> str:
    """RFC 6266：ASCII 兜底 filename + UTF-8 的 filename*，中文名才取得回原字节。"""
    name = str(original_name or "attachment").replace("\r", "").replace("\n", "").replace("\0", "")
    name = name.replace("\\", "_").replace('"', "_").strip() or "attachment"
    fallback = name.encode("ascii", "replace").decode("ascii").replace("?", "_")
    return f"attachment; filename=\"{fallback}\"; filename*=UTF-8''{quote(name, safe='')}"


def build_routes(ledger: Ledger) -> tuple[Route,...]:
    def transactions(request: Request) -> Response: return Response.json(200,service.list_transactions(ledger,_query(request)))
    def recurring(request: Request) -> Response: return Response.json(200,service.recurring(ledger,"list"))
    def summary(request: Request) -> Response: return Response.json(200,service.reports(ledger,"summary",_query(request)))
    def dashboard(request: Request) -> Response:
        service.catchup(ledger); return Response.json(200,service.reports(ledger,"dashboard",_query(request)))
    def budget(request: Request) -> Response: return Response.json(200,service.reports(ledger,"budget",_query(request)))
    def habits(request: Request) -> Response: return Response.json(200,service.reports(ledger,"habits",_query(request)))
    def configuration(request: Request) -> Response: return Response.json(200,service.configuration(ledger))
    def audit(request: Request) -> Response:
        raw_limit=_query(request).get("limit")
        try: limit=int(raw_limit) if raw_limit is not None else None
        except ValueError: limit=None
        return Response.json(200,{"events":service.audit_events(ledger,limit)})
    def attachment(request: Request) -> Response:
        meta, body = service.read_attachment(ledger,request.params["id"])
        return Response(200,body,{"Content-Type":_safe_mime(meta["mime"]),"Content-Disposition":_content_disposition(meta["originalName"]),"Cache-Control":"private, max-age=300"})
    def xlsx(request: Request) -> Response:
        body=service.export_xlsx(ledger,_query(request)); return Response(200,body,{"Content-Type":"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet","Content-Disposition":'attachment; filename="finance.xlsx"',"Cache-Control":"no-store"})
    def tax(request: Request) -> Response:
        body=service.export_tax_report(ledger,_query(request)); return Response(200,body,{"Content-Type":"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet","Content-Disposition":'attachment; filename="tax-report.xlsx"',"Cache-Control":"no-store"})
    handlers = {
        ("GET", "/v1/fin/transactions"): transactions,
        ("GET", "/v1/fin/attachments/{id}"): attachment,
        ("GET", "/v1/fin/recurring"): recurring,
        ("GET", "/v1/fin/summary/month"): summary,
        ("GET", "/v1/fin/dashboard/overview"): dashboard,
        ("GET", "/v1/fin/budget/status"): budget,
        ("GET", "/v1/fin/habits"): habits,
        ("GET", "/v1/fin/configuration"): configuration,
        ("GET", "/v1/fin/audit/events"): audit,
        ("GET", "/v1/fin/export/xlsx"): xlsx,
        ("GET", "/v1/fin/export/tax-report"): tax,
    }
    return routes_from_contract(ROUTES, handlers)
