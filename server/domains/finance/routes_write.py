"""
[INPUT]: 依赖 core HTTP Route/JSON 输入、finance Ledger 与 service 写事务。
[OUTPUT]: 对外提供 16 条 `/v1/fin/*` 写入路由契约、附件与导入两类大体积路由的
           请求体上限声明，及由该契约驱动装配的构造函数。
[POS]: finance 写面适配层；保留 E9 catchup 兼容接线，当前 MVP 中由 service 统一返回暂停且绝不生成周期流水。
[PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
"""

from __future__ import annotations

from typing import Final
from urllib.parse import parse_qs

from core.httpd import Request, Response, Route, routes_from_contract
from core.sqlite import Ledger
from core.validation import read_json_object
from domains.finance import service
from domains.finance.constants import ATTACHMENT_MAX_BYTES, IMPORT_MAX_BYTES, base64_body_limit

ROUTES: Final[tuple[tuple[str,str],...]] = (("POST","/v1/fin/transactions"),("PUT","/v1/fin/transactions/{id}"),("DELETE","/v1/fin/transactions/{id}"),("PATCH","/v1/fin/transactions/{id}/reimbursement"),("POST","/v1/fin/transactions/{txid}/attachments"),("DELETE","/v1/fin/attachments/{id}"),("POST","/v1/fin/recurring"),("PUT","/v1/fin/recurring/{id}"),("DELETE","/v1/fin/recurring/{id}"),("PUT","/v1/fin/configuration"),("POST","/v1/fin/import/preview"),("POST","/v1/fin/import/commit"),("POST","/v1/fin/rates/refresh"),("POST","/v1/fin/agent/operations"),("POST","/v1/fin/reimbursements/settle"),("POST","/v1/fin/recurring/catchup"))

# 附件与账单以 base64 塞进 JSON，天然比表单大一个量级。全局 1MB 会让
# service 层的 10MB/20MB 校验永远执行不到，手机拍的收据一张也传不上去。
BODY_LIMITS: Final[dict[tuple[str, str], int]] = {
    ("POST", "/v1/fin/transactions/{txid}/attachments"): base64_body_limit(ATTACHMENT_MAX_BYTES),
    ("POST", "/v1/fin/import/preview"): base64_body_limit(IMPORT_MAX_BYTES),
    ("POST", "/v1/fin/import/commit"): base64_body_limit(IMPORT_MAX_BYTES),
}


def build_routes(ledger: Ledger) -> tuple[Route,...]:
    def mutation(request: Request, operation: object) -> Response:
        service.catchup(ledger); return operation(request)  # type: ignore[operator]
    def create(request: Request) -> Response: return mutation(request,lambda item:Response.json(201,service.create_transaction(ledger,read_json_object(item.body, item.max_body_bytes))))
    def update(request: Request) -> Response: return mutation(request,lambda item:Response.json(200,service.update_transaction(ledger,item.params["id"],read_json_object(item.body, item.max_body_bytes))))
    def delete(request: Request) -> Response:
        query=parse_qs(request.query); return mutation(request,lambda item:Response.json(200,service.delete_transaction(ledger,item.params["id"],actor=item.headers.get("X-FinOS-Actor","dashboard"),reason=(query.get("reason",["删除流水"])[0] or "删除流水"))))
    def reimbursement(request: Request) -> Response: return mutation(request,lambda item:Response.json(200,service.update_reimbursement(ledger,item.params["id"],read_json_object(item.body, item.max_body_bytes).get("status"),actor=item.headers.get("X-FinOS-Actor","dashboard"))))
    # 周期规则的 create/update 内部各跑恰好一次即时追平；不能再套通用 mutation，
    # 否则会同一请求双扫描、最多重复生成 120 条历史交易。
    def recurring_create(request: Request) -> Response: return Response.json(201,service.recurring(ledger,"create",payload=read_json_object(request.body, request.max_body_bytes)))
    def recurring_update(request: Request) -> Response: return Response.json(200,service.recurring(ledger,"update",request.params["id"],read_json_object(request.body, request.max_body_bytes)))
    def recurring_delete(request: Request) -> Response: return mutation(request,lambda item:Response.json(200,service.recurring(ledger,"delete",item.params["id"])))
    def configuration(request: Request) -> Response: return mutation(request,lambda item:Response.json(200,service.update_configuration(ledger,read_json_object(item.body, item.max_body_bytes))))
    # preview 只解析用户上传的账单、并不写 ledger；按 E9 它必须保持纯读，不能顺带 catchup。
    def preview(request: Request) -> Response: return Response.json(200,service.import_preview(ledger,read_json_object(request.body, request.max_body_bytes)))
    def commit(request: Request) -> Response: return mutation(request,lambda item:Response.json(200,service.import_commit(ledger,read_json_object(item.body, item.max_body_bytes))))
    def settle(request: Request) -> Response: return mutation(request,lambda item:Response.json(200,service.settle_reimbursement(ledger,read_json_object(item.body, item.max_body_bytes),actor=item.headers.get("X-FinOS-Actor","dashboard"))))
    def catchup(_request: Request) -> Response: return Response.json(200,service.catchup(ledger))
    def upload(request: Request) -> Response: return mutation(request,lambda item:Response.json(201,service.upload_attachment(ledger,item.params["txid"],read_json_object(item.body, item.max_body_bytes))))
    def delete_attachment(request: Request) -> Response: return mutation(request,lambda item:Response.json(200,service.delete_attachment(ledger,item.params["id"])))
    def rates(request: Request) -> Response: return mutation(request,lambda _item:Response.json(200,service.refresh_rates(ledger)))
    def agent(request: Request) -> Response: return mutation(request,lambda item:Response.json(200,service.agent_operation(ledger,read_json_object(item.body, item.max_body_bytes),item.headers.get("X-FinOS-Actor","agent"))))
    handlers = {
        ("POST", "/v1/fin/transactions"): create,
        ("PUT", "/v1/fin/transactions/{id}"): update,
        ("DELETE", "/v1/fin/transactions/{id}"): delete,
        ("PATCH", "/v1/fin/transactions/{id}/reimbursement"): reimbursement,
        ("POST", "/v1/fin/transactions/{txid}/attachments"): upload,
        ("DELETE", "/v1/fin/attachments/{id}"): delete_attachment,
        ("POST", "/v1/fin/recurring"): recurring_create,
        ("PUT", "/v1/fin/recurring/{id}"): recurring_update,
        ("DELETE", "/v1/fin/recurring/{id}"): recurring_delete,
        ("PUT", "/v1/fin/configuration"): configuration,
        ("POST", "/v1/fin/import/preview"): preview,
        ("POST", "/v1/fin/import/commit"): commit,
        ("POST", "/v1/fin/rates/refresh"): rates,
        ("POST", "/v1/fin/agent/operations"): agent,
        ("POST", "/v1/fin/reimbursements/settle"): settle,
        ("POST", "/v1/fin/recurring/catchup"): catchup,
    }
    return routes_from_contract(ROUTES, handlers, BODY_LIMITS)
