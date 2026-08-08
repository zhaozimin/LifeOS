/**
 * [INPUT]: 依赖 core.ts 单 Token 传输层与 fin/types.ts 的财务领域契约。
 * [OUTPUT]: 提供全部 `/v1/fin/*` 财务账本请求、默认全量的不可覆盖修改版本、附件与受保护下载。
 * [POS]: 财务页面的 API 门面；这是 fin 域前缀的唯一前端真源。
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

import { request, requestBlob } from "./core";
import type { AuditEvent } from "../types";
import type {
  AttachmentRef, BudgetStatus, Configuration, DashboardOverview, ExchangeRates,
  MonthSummary, RecurringRule, Transaction, ViewMode,
} from "../fin/types";

type TransactionParams = { view?: ViewMode; month?: string; kind?: string; reimbursementStatus?: string; tag?: string; q?: string; categoryId?: string; accountName?: string; includeDeleted?: 0 | 1; limit?: number };

function downloadName(response: Response, fallback: string): string {
  const matched = /filename="([^"]+)"/.exec(response.headers.get("Content-Disposition") || "");
  return matched ? matched[1] : fallback;
}

async function fileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const value = String(reader.result || "");
      resolve(value.slice(value.indexOf(",") + 1));
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

export const finApi = {
  configuration: () => request<Configuration>("GET", "/v1/fin/configuration"),
  putConfiguration: (payload: Configuration) => request<Configuration>("PUT", "/v1/fin/configuration", { body: payload }),
  listTransactions: (params: TransactionParams = {}) => request<Transaction[]>("GET", "/v1/fin/transactions", { params }),
  createTransaction: (payload: Partial<Transaction>) => request<Transaction>("POST", "/v1/fin/transactions", { body: payload }),
  updateTransaction: (id: string, payload: Partial<Transaction>) => request<Transaction>("PUT", `/v1/fin/transactions/${encodeURIComponent(id)}`, { body: payload }),
  deleteTransaction: (id: string) => request<{ ok: true; id: string }>("DELETE", `/v1/fin/transactions/${encodeURIComponent(id)}`),
  updateReimbursement: (id: string, status: Transaction["reimbursementStatus"]) => request<{ ok: true; id: string; status: string; operations: AuditEvent[]; auditWarning?: string }>("PATCH", `/v1/fin/transactions/${encodeURIComponent(id)}/reimbursement`, { body: { status } }),
  settleReimbursement: (payload: { incomeId: string; settleIds: string[]; unsettleIds: string[] }) => request<{ ok: true; incomeId: string; settled: number; unsettled: number; invalid: string[]; operations: AuditEvent[]; auditWarning?: string }>("POST", "/v1/fin/reimbursements/settle", { body: payload }),
  summaryMonth: (params: { view?: ViewMode; month?: string }) => request<MonthSummary>("GET", "/v1/fin/summary/month", { params }),
  dashboardOverview: (params: { view?: ViewMode } = {}) => request<DashboardOverview>("GET", "/v1/fin/dashboard/overview", { params }),
  budgetStatus: (params: { month?: string } = {}) => request<BudgetStatus>("GET", "/v1/fin/budget/status", { params }),
  auditEvents: () => request<{ events: AuditEvent[] }>("GET", "/v1/fin/audit/events"),
  listRecurring: () => request<RecurringRule[]>("GET", "/v1/fin/recurring"),
  createRecurring: (payload: Partial<RecurringRule>) => request<RecurringRule>("POST", "/v1/fin/recurring", { body: payload }),
  updateRecurring: (id: string, payload: Partial<RecurringRule>) => request<RecurringRule>("PUT", `/v1/fin/recurring/${encodeURIComponent(id)}`, { body: payload }),
  deleteRecurring: (id: string) => request<{ ok: true; id: string }>("DELETE", `/v1/fin/recurring/${encodeURIComponent(id)}`),
  refreshExchangeRates: () => request<ExchangeRates>("POST", "/v1/fin/rates/refresh", { body: {} }),
  importPreview: async (template: string, file: File) => request<{ transactions: Array<Partial<Transaction>>; warnings: string[]; detected_columns: Record<string, number | null>; headers?: string[]; template: string }>("POST", "/v1/fin/import/preview", { body: { template, content: await fileAsBase64(file) } }),
  importCommit: (transactions: Array<Partial<Transaction>>) => request<{ imported: number; failed: number; errors: Array<{ index: number; error: string }> }>("POST", "/v1/fin/import/commit", { body: { transactions } }),
  fetchAttachmentBlob: async (id: string) => (await requestBlob("GET", `/v1/fin/attachments/${encodeURIComponent(id)}`)).blob(),
  uploadAttachment: async (transactionId: string, file: File) => request<AttachmentRef>("POST", `/v1/fin/transactions/${encodeURIComponent(transactionId)}/attachments`, { body: { filename: file.name, mime: file.type || "application/octet-stream", data: await fileAsBase64(file) } }),
  deleteAttachment: (id: string) => request<{ ok: true; id: string }>("DELETE", `/v1/fin/attachments/${encodeURIComponent(id)}`),
  downloadTaxReport: async (params: { year: number; quarter?: number }) => {
    const response = await requestBlob("GET", "/v1/fin/export/tax-report", { params });
    return { blob: await response.blob(), filename: downloadName(response, `tax-report-${params.year}.xlsx`) };
  },
  downloadXlsx: async (params: { view?: ViewMode; from?: string; to?: string }) => {
    const response = await requestBlob("GET", "/v1/fin/export/xlsx", { params });
    return { blob: await response.blob(), filename: downloadName(response, "finance.xlsx") };
  },
};
