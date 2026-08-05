/**
 * [INPUT]: 依赖财务领域枚举。
 * [OUTPUT]: 提供设置面板 ID 与共享选择项；MVP 导航清单不暴露货币和周期账目。
 * [POS]: settings 的不可变领域常量。
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import type {
  AccountClassification,
  AccountOwnership,
  CounterpartyKind,
  LedgerMode,
  RecurringFrequency,
  TransactionKind,
} from "../../types";

export type SettingsPanel = "currency" | "accounts" | "projects" | "sources" | "categories" | "counterparties" | "recurring" | "import" | "tax" | "dashboard" | "developer";

export const FREQUENCY_OPTIONS: Array<{ value: RecurringFrequency; label: string }> = [
  { value: "daily", label: "每天" },
  { value: "weekly", label: "每周" },
  { value: "monthly", label: "每月" },
  { value: "yearly", label: "每年" },
];

export const FREQUENCY_LABEL: Record<RecurringFrequency, string> = {
  daily: "每天",
  weekly: "每周",
  monthly: "每月",
  yearly: "每年",
};

export const TRANSACTION_KIND_OPTIONS: Array<{ value: TransactionKind; label: string }> = [
  { value: "expense", label: "支出" },
  { value: "income", label: "收入" },
  { value: "transfer", label: "转账" },
];

export const COUNTERPARTY_KIND_OPTIONS: Array<{ value: CounterpartyKind; label: string }> = [
  { value: "client", label: "客户" },
  { value: "vendor", label: "供应商" },
  { value: "employer", label: "雇主 / 用人方" },
  { value: "other", label: "其他" },
];

export const COUNTERPARTY_KIND_TONE: Record<CounterpartyKind, "primary" | "neutral" | "success" | "brand-blue"> = {
  client: "success",
  vendor: "brand-blue",
  employer: "primary",
  other: "neutral",
};

export const OWNERSHIP_OPTIONS: Array<{ value: AccountOwnership; label: string }> = [
  { value: "company", label: "工作账户" },
  { value: "personal", label: "生活账户" },
  { value: "unspecified", label: "未指定" },
];

export const LEDGER_MODE_OPTIONS: Array<{ value: LedgerMode; label: string }> = [
  { value: "personal", label: "个人记账" },
  { value: "dual", label: "个人 + 经营" },
];

export const CLASSIFICATION_OPTIONS: Array<{ value: AccountClassification; label: string }> = [
  { value: "asset", label: "资产" },
  { value: "liability", label: "负债（信用卡 / 贷款）" },
];

export const CURRENCY_OPTIONS = [
  { value: "CNY", label: "人民币 CNY" },
  { value: "USD", label: "美元 USD" },
  { value: "HKD", label: "港币 HKD" },
  { value: "EUR", label: "欧元 EUR" },
  { value: "JPY", label: "日元 JPY" },
];

export const UNIT_OPTIONS = [
  { value: "yuan", label: "元" },
  { value: "wan", label: "万元" },
];

export const SETTINGS_PANEL_OPTIONS: Array<{ value: SettingsPanel; label: string }> = [
  { value: "accounts", label: "账户管理" },
  { value: "projects", label: "项目管理" },
  { value: "sources", label: "资金来源管理" },
  { value: "categories", label: "类别管理设置" },
  { value: "counterparties", label: "客户与合作方" },
  { value: "import", label: "账单导入" },
  { value: "tax", label: "税务设置" },
  { value: "dashboard", label: "仪表盘" },
  { value: "developer", label: "开发者模式" },
];
