/**
 * [INPUT]: 依赖 finance_node_server.py 返回的账本、主数据与删除审计字段。
 * [OUTPUT]: 对外提供 React 页面共享的财务领域类型。
 * [POS]: web-dashboard/src 的 API 契约根；被页面、组件与 API 客户端共同消费。
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

export type ViewMode = "company" | "personal" | "combined";

// 记账模式：personal = 个人（隐藏归属/经营/税务等维度）；dual = 个人 + 经营（全量形态）
export type LedgerMode = "personal" | "dual";

export type AccountOwnership = "company" | "personal" | "unspecified";

export type AccountClassification = "asset" | "liability";

export type TransactionKind = "income" | "expense" | "transfer";

export type ReimbursementStatus =
  | "draft"
  | "submitted"
  | "reimbursed"
  | "rejected"
  | "notApplicable";

export type TaxCategory =
  | "business-income"
  | "business-expense-deductible"
  | "business-expense-nondeductible"
  | "personal"
  | "transfer";

export interface CategoryRef {
  id?: string;
  name: string;
  systemImage?: string;
  tintHex?: string;
  keywords?: string[];
  direction?: "收入" | "支出";
  group?: string;
  defaultAccountId?: string;
  projectId?: string;
  note?: string;
  monthlyBudget?: number;
  deletedAt?: string | null;
  deletedBy?: string | null;
  deletionReason?: string | null;
}

export interface BudgetStatusItem {
  categoryId: string;
  name: string;
  budget: number;
  spent: number;
  remaining: number;
  percentUsed: number;
  color: string;
}

export interface BudgetStatus {
  month: string;
  items: BudgetStatusItem[];
  totalBudget: number;
  totalSpent: number;
  totalRemaining: number;
}

export type RecurringFrequency = "daily" | "weekly" | "monthly" | "yearly";

export interface RecurringRule {
  id: string;
  name: string;
  template: Partial<Transaction>;
  frequency: RecurringFrequency;
  intervalN: number;
  dayOfPeriod?: number | null;
  startDate: string;
  endDate?: string | null;
  nextDueAt: string;
  lastRunAt?: string | null;
  enabled: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export interface Account {
  id: string;
  name: string;
  type: string;
  currency: string;
  openingBalance: number;
  currentBalance?: number;
  brand?: string;
  tintHex?: string;
  symbolName?: string;
  keywords?: string[];
  uiAccountType?: string;
  customType?: string;
  logoMode?: string;
  logoPresetId?: string;
  logoEmoji?: string;
  logoImageUrl?: string;
  threshold?: number;
  thresholdZones?: { low?: number; mid?: number };
  note?: string;
  flowRole?: string;
  ownership: AccountOwnership;
  classification?: AccountClassification;
  creditLimit?: number;
  availableCredit?: number;
  deletedAt?: string | null;
  deletedBy?: string | null;
  deletionReason?: string | null;
  deletionImpact?: { balance: number; assetDelta: number; liabilityDelta: number; netWorthDelta: number };
}

export interface ProjectGoal {
  targetAmount: number;
  targetDate?: string | null;
  sourceAccountId?: string;
  description?: string;
}

export interface Project {
  id: string;
  name: string;
  direction: "收入" | "支出";
  group: string;
  note?: string;
  trackingEnabled: boolean;
  goal?: ProjectGoal | null;
  expectedCost?: number;
  expectedRevenue?: number;
  startDate?: string | null;
  endDate?: string | null;
}

export interface FinanceSource {
  id: string;
  name: string;
  defaultAccountId?: string;
  note?: string;
  tintHex?: string;
  deletedAt?: string | null;
  deletedBy?: string | null;
  deletionReason?: string | null;
}

export type CounterpartyKind = "client" | "vendor" | "employer" | "other";

export interface Counterparty {
  id: string;
  name: string;
  kind: CounterpartyKind;
  tintHex?: string;
  defaultAccountId?: string;
  note?: string;
  contactInfo?: string;
}

export interface TaxConfig {
  vatRate: number;
  personalThreshold: number;
  personalRate: number;
  sebRate: number;
  currency?: string;
  note?: string;
}

export interface ExchangeRates {
  baseCurrency: string;
  rates: Record<string, number>;
  autoFetch?: boolean;
  provider?: string;
  lastFetchSource?: string | null;
  lastFetchError?: string | null;
  updatedAt?: string | null;
}

export interface LedgerSettings {
  bookMode: string;
  ledgerMode?: LedgerMode;
  defaultCurrency: string;
  baseUnit: string;
  timezone: string;
  allowManualEntry: boolean;
  projects: Project[];
  financeSources?: FinanceSource[];
  counterparties?: Counterparty[];
  taxConfig?: TaxConfig;
  exchangeRates?: ExchangeRates;
  updatedAt?: string | null;
}

export interface Configuration {
  categories: CategoryRef[];
  accounts: Account[];
  settings: LedgerSettings;
}

export interface AttachmentRef {
  id: string;
  mime: string;
  sizeBytes: number;
  originalName: string;
  createdAt: string;
}

export interface Transaction {
  id: string;
  title: string;
  amount: number;
  kind: TransactionKind;
  occurredAt: string;
  category: CategoryRef;
  tags: string[];
  accountName: string;
  fromAccountName?: string | null;
  toAccountName?: string | null;
  merchant: string;
  projectName?: string | null;
  note: string;
  reimbursementStatus: ReimbursementStatus;
  /** 覆盖这笔垫付的回款收入 id；NULL = 未核销或快捷按钮手动标记 */
  reimbursedBy?: string | null;
  source: string;
  sourceName?: string | null;
  counterpartyId?: string | null;
  invoiceIssued?: boolean;
  invoiceAttachmentId?: string | null;
  taxCategory?: TaxCategory;
  currency?: string | null;
  amountInBaseCurrency?: number | null;
  attachments?: AttachmentRef[];
  deletedAt?: string | null;
  deletedBy?: string | null;
  deletionReason?: string | null;
  deletionOperationId?: string | null;
}

export interface MonthSummary {
  month: string;
  view: ViewMode;
  income: number;
  expense: number;
  balance: number;
  pendingReimbursement: number;
  transactionCount: number;
}

export interface KPIValue {
  value: number;
  display: string;
  change: string;
  trend: "up" | "down" | "flat";
}

export interface SankeyNode {
  name: string;
  itemStyle?: { color?: string };
}

export interface SankeyLink {
  source: string;
  target: string;
  value: number;
}

export interface SunburstNode {
  name: string;
  value?: number;
  itemStyle?: { color?: string };
  children?: SunburstNode[];
}

export interface DashboardOverview {
  health: {
    nodeName: string;
    status: string;
    openClawConnected: boolean;
    remoteAccess: string;
    version: string;
    lastIngestedAt?: string;
  };
  dashboard: {
    kpis: {
      currentCashFlow: KPIValue;
      monthlyNetProfit: KPIValue;
      opexRate: KPIValue;
      emergencyRunway: KPIValue;
    };
    trendData: { months: string[]; income: number[]; expense: number[] };
    sunburstData: SunburstNode[];
    roiData: { projects: string[]; cost: number[]; revenue: number[] };
    sankeyData: { nodes: SankeyNode[]; links: SankeyLink[] };
    accounts: { name: string; amount: number; color?: string }[];
    suggestion: { title: string; description: string; actionLabel?: string };
  };
  allTransactions: Array<Record<string, unknown>>;
  categories: string[];
  meta: {
    month: string;
    transactionCount: number;
    rawTransactionCount: number;
    bookMode: string;
  };
}
