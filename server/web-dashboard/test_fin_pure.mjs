/**
 * [INPUT]: 依赖 src/fin/lib/timeRange.ts 的区间键编解码与边界推导、src/fin/lib/reimbursement.ts 的报销状态语义、
 *   src/fin/lib/financeAnalytics.ts 的余额聚合/桑基模型、src/fin/store/timeRange.ts 的区间归一规则，
 *   并以 node:fs 读取财务页、抽屉与时间范围选择器的源码，校验只存在于 tsx 里的取数接线。
 * [OUTPUT]: 提供跨月/跨年/单日区间边界、报销状态迁移不变式、软删除账户聚合、桑基连线还原、
 *   区间显示与过滤同源、全历史无上限取数、刷新信号接线与 MVP 暂停入口的 Node 回归测试。
 * [POS]: web-dashboard 的财务纯函数变异锁；直接 import 真实实现，
 *   任何对月末推导、ISO 周起点、闭区间判定、「已驳回仍计入待回款」、桑基连线编码或取数口径的改动都必须在此显形。
 *   少数接线只存在于 .tsx（node --test 无法 import JSX），这类断言退化为对真实源码文本的结构检查，
 *   已单独成组并在用例名里点明，不与纯函数断言混淆。
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  bucketOf,
  currentBucket,
  deriveBuckets,
  isoDay,
  isoWeek,
  parseRangeBucket,
  rangeBounds,
  rangeBucket,
  transactionMatchesRange,
} from "./src/fin/lib/timeRange.ts";
import {
  REIMBURSEMENT_INCOME_SOURCE,
  REIMBURSEMENT_STATUS_META,
  isPendingReimbursement,
  isReimbursable,
  isReimbursementIncome,
} from "./src/fin/lib/reimbursement.ts";
import {
  accountBalance,
  buildSankey,
  filterTransactions,
  totalAssets,
  totalLiabilities,
} from "./src/fin/lib/financeAnalytics.ts";
import { reconcileBucket } from "./src/fin/store/timeRange.ts";

/** 只有 occurredAt 参与区间判定，其余字段补齐到最小可判定形态。 */
function expense(occurredAt, reimbursementStatus = "notApplicable") {
  return { id: occurredAt, kind: "expense", occurredAt, amount: 100, reimbursementStatus };
}

function income(occurredAt, sourceName) {
  return { id: occurredAt, kind: "income", occurredAt, amount: 100, sourceName };
}

function boundsAsDays(dim, bucket) {
  const { from, to } = rangeBounds(dim, bucket);
  return [from ? isoDay(from) : null, to ? isoDay(to) : null];
}

test("月区间收在自然月最后一天，闰年二月不丢一天", () => {
  assert.deepEqual(boundsAsDays("month", "2026-02"), ["2026-02-01", "2026-02-28"]);
  assert.deepEqual(boundsAsDays("month", "2024-02"), ["2024-02-01", "2024-02-29"]);
  // 12 月的月末推导会撞上年份进位，必须停在 12-31 而不是溢出到次年
  assert.deepEqual(boundsAsDays("month", "2026-12"), ["2026-12-01", "2026-12-31"]);
  assert.deepEqual(boundsAsDays("month", "2026-08"), ["2026-08-01", "2026-08-31"]);
});

test("季度区间跨到年末仍闭合在 12-31", () => {
  assert.deepEqual(boundsAsDays("quarter", "2026-Q1"), ["2026-01-01", "2026-03-31"]);
  assert.deepEqual(boundsAsDays("quarter", "2026-Q4"), ["2026-10-01", "2026-12-31"]);
  assert.equal(currentBucket("quarter", new Date(2026, 0, 1)), "2026-Q1");
  assert.equal(currentBucket("quarter", new Date(2026, 11, 31)), "2026-Q4");
  assert.equal(currentBucket("year", new Date(2026, 11, 31)), "2026");
});

test("ISO 周跨年：2026 年第 1 周起于 2025-12-29，长度恒为 7 天", () => {
  const [from, to] = boundsAsDays("week", "2026-W01");
  assert.equal(from, "2025-12-29");
  assert.equal(to, "2026-01-04");
  // 跨年那几天的 ISO 周号归属次年，这是周边界与自然年边界唯一会打架的地方
  assert.equal(isoWeek(new Date(2025, 11, 29)), 1);
  assert.equal(isoWeek(new Date(2026, 0, 4)), 1);
  const { from: start, to: end } = rangeBounds("week", "2026-W32");
  assert.equal(Math.round((end.getTime() - start.getTime()) / 86_400_000), 6);
});

test("单日自定义区间是闭区间，且起止颠倒会被归一", () => {
  const oneDay = rangeBucket(new Date(2026, 7, 1), new Date(2026, 7, 1));
  assert.equal(oneDay, "2026-08-01..2026-08-01");
  const parsed = parseRangeBucket(oneDay);
  assert.equal(isoDay(parsed.from), "2026-08-01");
  assert.equal(isoDay(parsed.to), "2026-08-01");
  assert.equal(transactionMatchesRange(expense("2026-08-01"), "custom", oneDay), true);
  assert.equal(transactionMatchesRange(expense("2026-07-31"), "custom", oneDay), false);
  assert.equal(transactionMatchesRange(expense("2026-08-02"), "custom", oneDay), false);
  assert.equal(rangeBucket(new Date(2026, 7, 31), new Date(2026, 7, 1)), "2026-08-01..2026-08-31");
});

test("流水归属按自然日闭区间判定，端点在内、邻月在外", () => {
  const august = "2026-08";
  assert.equal(transactionMatchesRange(expense("2026-08-01T00:05:00"), "month", august), true);
  assert.equal(transactionMatchesRange(expense("2026-08-31T23:55:00"), "month", august), true);
  assert.equal(transactionMatchesRange(expense("2026-07-31T23:55:00"), "month", august), false);
  assert.equal(transactionMatchesRange(expense("2026-09-01T00:05:00"), "month", august), false);
  // 全部时间不做任何裁剪，空 bucket 同样放行，避免筛选态未就绪时页面空白
  assert.equal(transactionMatchesRange(expense("1999-01-01"), "all", ""), true);
  assert.equal(transactionMatchesRange(expense("1999-01-01"), "month", ""), true);
  assert.equal(bucketOf("", "month"), "");
  assert.equal(bucketOf("不是日期", "month"), "");
});

test("桶列表按倒序去重，all/custom 不产生可选桶", () => {
  const rows = [
    expense("2026-08-04"),
    expense("2026-08-20"),
    expense("2026-07-02"),
    expense("2025-12-31"),
  ];
  assert.deepEqual(
    deriveBuckets(rows, "month").map((option) => option.value),
    ["2026-08", "2026-07", "2025-12"],
  );
  assert.deepEqual(deriveBuckets(rows, "year").map((option) => option.value), ["2026", "2025"]);
  assert.deepEqual(deriveBuckets(rows, "all"), []);
  assert.deepEqual(deriveBuckets(rows, "custom"), []);
});

test("报销判定覆盖全部状态：notApplicable 之外都是垫付，只有已报销脱离欠账", () => {
  assert.equal(isReimbursable(expense("2026-08-01", "notApplicable")), false);
  for (const status of ["draft", "submitted", "rejected", "reimbursed"]) {
    assert.equal(isReimbursable(expense("2026-08-01", status)), true, status);
  }
  assert.equal(isPendingReimbursement(expense("2026-08-01", "reimbursed")), false);
  // 收入行永远不是垫付，哪怕带着报销状态字段
  assert.equal(isReimbursable({ ...income("2026-08-01", "工资"), reimbursementStatus: "draft" }), false);
});

test("报销状态机的合法迁移只改变「待回款」归属，已驳回不是终态", () => {
  const transitions = [
    { from: "draft", to: "reimbursed", pendingBefore: true, pendingAfter: false },
    { from: "submitted", to: "rejected", pendingBefore: true, pendingAfter: true },
    { from: "rejected", to: "draft", pendingBefore: true, pendingAfter: true },
    { from: "reimbursed", to: "draft", pendingBefore: false, pendingAfter: true },
  ];
  for (const step of transitions) {
    const before = expense("2026-08-01", step.from);
    const after = { ...before, reimbursementStatus: step.to };
    assert.equal(isPendingReimbursement(before), step.pendingBefore, `${step.from} 迁出前`);
    assert.equal(isPendingReimbursement(after), step.pendingAfter, `${step.from}→${step.to}`);
  }
  // 状态清单必须与判定函数认得的状态一一对应，新增状态漏配文案会在此断裂
  assert.deepEqual(
    REIMBURSEMENT_STATUS_META.map((meta) => meta.value),
    ["draft", "submitted", "reimbursed", "rejected"],
  );
  for (const meta of REIMBURSEMENT_STATUS_META) {
    assert.equal(isReimbursable(expense("2026-08-01", meta.value)), true, meta.value);
    assert.ok(meta.label.length > 0, meta.value);
  }
});

test("回款收入以资金来源认亲，来源写错就不可核销", () => {
  assert.equal(isReimbursementIncome(income("2026-08-05", REIMBURSEMENT_INCOME_SOURCE)), true);
  assert.equal(isReimbursementIncome(income("2026-08-05", "工资")), false);
  assert.equal(isReimbursementIncome(income("2026-08-05", null)), false);
  assert.equal(isReimbursementIncome({ ...expense("2026-08-05"), sourceName: REIMBURSEMENT_INCOME_SOURCE }), false);
});

test("跨年周桶用 ISO 周年份编码，编解码必须往返一致", () => {
  // 2025-12-29 是周一，属于 ISO 2026 年第 1 周。混用自然年会编成 2025-W01，
  // 再解回 2024-12-30..2025-01-05——整整错开一年。
  assert.equal(currentBucket("week", new Date(2025, 11, 29)), "2026-W01");
  assert.equal(bucketOf("2025-12-29T12:00:00", "week"), "2026-W01");
  const bounds = rangeBounds("week", "2026-W01");
  assert.equal(isoDay(bounds.from), "2025-12-29");
  assert.equal(isoDay(bounds.to), "2026-01-04");
  // 往返：该周内任意一天编码后解回，都必须仍然覆盖那一天
  for (const day of ["2025-12-29", "2025-12-31", "2026-01-04"]) {
    const round = rangeBounds("week", bucketOf(`${day}T12:00:00`, "week"));
    assert.ok(isoDay(round.from) <= day && day <= isoDay(round.to), `${day} 落在自己的周桶外`);
  }
});


/** 账户最小形态：只有余额聚合会读到的字段。 */
function account(name, currentBalance, extra = {}) {
  return {
    id: name, name, currency: "CNY", classification: "asset",
    ownership: "personal", openingBalance: 0, currentBalance, ...extra,
  };
}

test("软删除账户不参与任何余额聚合，看板与设置页必须给出同一个数", () => {
  // 事故形态：三个聚合函数各自 filter 一遍且都不看 deletedAt，被删账户的余额
  // 继续计入净资产；而设置页的 draft 已经排除了它，删除卡片还写着「净资产 −50,000」。
  // 用户按提示删了账户、被告知净资产会降，看板却纹丝不动。
  const live = account("微信支付", 10000);
  const removed = account("旧储蓄卡", 50000, { deletedAt: "2026-08-01T00:00:00+08:00" });
  const card = account("信用卡", 2000, { classification: "liability" });
  const removedCard = account("旧信用卡", 8000, {
    classification: "liability", deletedAt: "2026-08-01T00:00:00+08:00",
  });
  const accounts = [live, removed, card, removedCard];

  assert.equal(totalAssets(accounts), 10000);
  assert.equal(totalLiabilities(accounts), 2000);
  assert.equal(accountBalance(accounts), 8000);

  // 归属过滤与软删除过滤必须叠加，不能其中一个把另一个盖掉
  assert.equal(accountBalance(accounts, "personal"), 8000);
  assert.equal(accountBalance([...accounts, account("公司户", 999, { ownership: "company" })], "personal"), 8000);
});

test("桑基连线不经字符串编码回解：名字里含 __ 也必须逐字还原", () => {
  // 事故形态：link key 曾是 `${source}__${target}`，回解时 split("__") 只取前两段。
  // 账户名叫「现金__备用」时解出的 source/target 都不在 nodes 里，ECharts 静默丢弃该边，
  // 这笔钱在「全局资金流」里完全看不见——名字是用户写的自由文本，任何分隔符都可能出现在里面。
  const accounts = [account("现金__备用", 1000), account("工资卡", 2000)];
  const rows = [
    { id: "e1", kind: "expense", occurredAt: "2026-08-01T10:00:00", amount: 100,
      accountName: "现金__备用", fromAccountName: "现金__备用", category: { id: "c1", name: "餐饮" } },
    { id: "e2", kind: "expense", occurredAt: "2026-08-02T10:00:00", amount: 50,
      accountName: "现金__备用", fromAccountName: "现金__备用", category: { id: "c1", name: "餐饮" } },
    { id: "i1", kind: "income", occurredAt: "2026-08-03T10:00:00", amount: 900,
      sourceName: "客户__A", toAccountName: "工资卡" },
    { id: "t1", kind: "transfer", occurredAt: "2026-08-04T10:00:00", amount: 300,
      fromAccountName: "工资卡", toAccountName: "现金__备用" },
  ];

  const { nodes, links } = buildSankey(rows, accounts);
  const names = new Set(nodes.map((node) => node.name));
  for (const link of links) {
    assert.ok(names.has(link.source), `连线起点「${link.source}」不在节点里，ECharts 会静默丢边`);
    assert.ok(names.has(link.target), `连线终点「${link.target}」不在节点里，ECharts 会静默丢边`);
  }
  const edge = (source, target) => links.find((l) => l.source === source && l.target === target);
  assert.equal(edge("现金__备用", "餐饮")?.value, 150, "同名边必须继续累加");
  assert.equal(edge("客户__A", "工资卡")?.value, 900);
  assert.equal(edge("工资卡", "现金__备用")?.value, 300);
  assert.equal(links.length, 3);
});

test("桑基仍拒绝自环与回路：换掉连线容器不能把无环约束一起换掉", () => {
  const accounts = [account("A", 100), account("B", 100)];
  const transfer = (id, from, to, amount) => ({
    id, kind: "transfer", occurredAt: `2026-08-0${id.slice(-1)}T10:00:00`, amount,
    fromAccountName: from, toAccountName: to,
  });
  const { links } = buildSankey(
    [transfer("t1", "A", "B", 100), transfer("t2", "B", "A", 50), transfer("t3", "A", "A", 30)],
    accounts,
  );
  // ECharts Sankey 只接受有向无环图：回边与自环必须在展示模型里消失，而不是把页面炸掉
  assert.deepEqual(links, [{ source: "A", target: "B", value: 100 }]);
});

test("时间区间下拉显示哪个桶，页面就必须拿哪个桶过滤", () => {
  // 事故形态：picker 只在本地算了个「有效桶」用于显示，从不写回 store；
  // 页面拿 store 里那个已失效的旧 bucket 过滤——界面写着一个月份、算的是另一个月份，
  // 整块看板一片 ¥0 且无任何解释，还随 persist 跨会话驻留。
  const rows = [expense("2026-07-15T10:00:00"), expense("2026-06-02T10:00:00")];
  const buckets = deriveBuckets(rows, "month");
  assert.deepEqual(buckets.map((option) => option.value), ["2026-07", "2026-06"]);

  const shown = reconcileBucket("month", "2026-08", buckets);
  assert.equal(shown, "2026-07", "失效的桶必须归一到首个可选桶");
  assert.equal(filterTransactions(rows, [], "combined", "month", shown).length, 1);
  assert.equal(filterTransactions(rows, [], "combined", "month", "2026-08").length, 0, "前提失效：旧桶本该一条都筛不出");

  // 仍然可选的桶不许被动
  assert.equal(reconcileBucket("month", "2026-06", buckets), "2026-06");
  // 没有可选桶时无从归一，退回「不裁剪」，与 Autocomplete 的「（无流水）」占位同源
  assert.equal(reconcileBucket("month", "2026-08", []), "");
  // all / custom 的键不由桶列表管辖：归一到桶只会把用户选定的日历区间抹掉
  assert.equal(reconcileBucket("custom", "2026-08-01..2026-08-31", []), "2026-08-01..2026-08-31");
  assert.equal(reconcileBucket("custom", "2026-08-01..2026-08-31", buckets), "2026-08-01..2026-08-31");
  assert.equal(reconcileBucket("all", "", buckets), "");
  // 周维度同理：跨年周桶键也走同一条归一
  const weekBuckets = deriveBuckets(rows, "week");
  assert.equal(reconcileBucket("week", "2026-W01", weekBuckets), weekBuckets[0].value);
});

// ── 以下为源码结构断言 ────────────────────────────────────────────────
// 这几处接线只存在于 .tsx 里，而 node --test 无法 import JSX（Unknown file extension ".tsx"）。
// 与其不锁，不如按真实源码文本锁死：改坏页面接线，这里同样会红。

const pageSource = (name) =>
  readFileSync(new URL(`./src/fin/pages/${name}`, import.meta.url), "utf8");

/** 抠出每个 useApi(...) 调用末尾的依赖数组文本；按括号配平扫描，不靠正则猜调用边界。 */
function useApiDependencyArrays(source) {
  const arrays = [];
  for (let index = source.indexOf("useApi("); index !== -1; index = source.indexOf("useApi(", index + 1)) {
    let depth = 0;
    let end = index;
    for (; end < source.length; end += 1) {
      if (source[end] === "(") depth += 1;
      else if (source[end] === ")" && --depth === 0) break;
    }
    const call = source.slice(index, end + 1);
    const open = call.lastIndexOf("[");
    const close = call.lastIndexOf("]");
    arrays.push(open !== -1 && close > open ? call.slice(open, close + 1) : "");
  }
  return arrays;
}

const FIN_PAGES = ["OverviewPage.tsx", "LedgerPage.tsx", "FlowPage.tsx", "SettingsPage.tsx"];

test("源码结构：顶栏刷新信号必须落进四个财务页的每一处取数依赖", () => {
  // 事故形态：Layout 的按钮只把 refreshKey 加一，而财务侧零消费——四个页面的 useApi 依赖恒定，
  // 用户点了刷新，金额、报销待回款、预算纹丝不动，按钮看起来却生效了。
  // 财务三页还挂在 FinPageFrame 的二级 Outlet 下，那层不透传 context，
  // 因此信号只能走 Layout 导出的 useRefreshSignal（普通 React context），不能用 useOutletContext。
  for (const page of FIN_PAGES) {
    const source = pageSource(page);
    // 用 includes 而非 assert.match：断言失败时不要把整份源码倒进报告
    assert.ok(source.includes("useRefreshSignal"), `${page} 没有接入顶栏刷新信号`);
    assert.ok(source.includes("const refreshKey = useRefreshSignal();"), `${page} 没有取出刷新信号`);
    const arrays = useApiDependencyArrays(source);
    assert.ok(arrays.length > 0, `${page} 没有解析到任何 useApi 调用，扫描器已与源码脱节`);
    for (const deps of arrays) {
      assert.ok(deps.includes("refreshKey"), `${page} 有一处 useApi 依赖 ${deps || "(空)"} 收不到刷新信号`);
    }
  }
});

test("源码结构：刷新信号的生产侧必须真的随点击变化，不能是钉死的常量", () => {
  // 消费侧的断言（四页依赖里都带 refreshKey）挡不住生产侧退化：
  // 把 Layout 的 Provider value 钉成 0，四页依赖照旧「带着 refreshKey」，
  // 消费侧断言全绿，而整个刷新按钮彻底失效。生产侧必须单独锁。
  const layout = readFileSync(new URL("./src/components/Layout.tsx", import.meta.url), "utf8");

  // 点击处必须把状态往前推，而不是赋一个常量
  assert.match(layout, /setRefreshKey\(\s*\(?\s*\w+\s*\)?\s*=>\s*\w+\s*\+\s*1\s*\)/,
    "刷新按钮必须递增 refreshKey，而不是赋常量");

  // Provider 必须把那个 state 原样下发，不能是字面量或别的东西
  assert.match(layout, /<RefreshSignalContext\.Provider\s+value=\{refreshKey\}>/,
    "Provider 必须下发 refreshKey 本身");

  // 二级 Outlet 下的财务页取不到 outlet context，所以 Provider 必须包住 <Outlet
  const providerAt = layout.indexOf("<RefreshSignalContext.Provider");
  const outletAt = layout.indexOf("<Outlet", providerAt);
  const closeAt = layout.indexOf("</RefreshSignalContext.Provider>");
  assert.ok(providerAt >= 0 && outletAt > providerAt && closeAt > outletAt,
    "Provider 必须包住 <Outlet/>，否则财务页取不到信号");
});

test("源码结构：所有财务历史视图取整本账，不设 limit", () => {
  for (const relative of [
    "pages/OverviewPage.tsx",
    "pages/LedgerPage.tsx",
    "pages/FlowPage.tsx",
    "components/ProjectPLDrawer.tsx",
    "components/AdjustmentHistoryDrawer.tsx",
    "components/FinSearchPalette.tsx",
    "pages/settings/categories.tsx",
  ]) {
    const source = readFileSync(new URL(`./src/fin/${relative}`, import.meta.url), "utf8");
    assert.doesNotMatch(source, /listTransactions\s*\(\s*\{[^}]*\blimit\s*:/s, `${relative} 会截断早期流水`);
  }
});

test("源码结构：TimeRangePicker 必须把归一后的区间写回 store", () => {
  const source = readFileSync(new URL("./src/fin/components/TimeRangePicker.tsx", import.meta.url), "utf8");
  assert.ok(source.includes("reconcileBucket"), "选择器没有使用 store 的区间归一规则");
  assert.ok(
    source.includes("setBucket(effectiveBucket)"),
    "归一值只用于显示、没有写回 store，显示与过滤会再次分叉",
  );
});

test("源码结构：MVP 不得暴露多币种或周期账目入口", () => {
  const settingsHub = readFileSync(new URL("./src/settings/SettingsHub.tsx", import.meta.url), "utf8");
  const settingsPage = pageSource("SettingsPage.tsx");
  const settingsConstants = readFileSync(new URL("./src/fin/pages/settings/constants.ts", import.meta.url), "utf8");
  const transactionSheet = readFileSync(new URL("./src/fin/components/TransactionEditSheet.tsx", import.meta.url), "utf8");
  const overview = pageSource("OverviewPage.tsx");

  assert.ok(!settingsHub.includes('id: "finance-currency"'), "设置中心又暴露了多币种入口");
  assert.ok(!settingsHub.includes('id: "finance-recurring"'), "设置中心又暴露了周期账目入口");
  assert.ok(!settingsConstants.includes('{ value: "currency", label:'), "财务设置又暴露了货币面板");
  assert.ok(!settingsConstants.includes('{ value: "recurring", label:'), "财务设置又暴露了周期面板");
  assert.ok(!settingsPage.includes('effectivePanel === "currency"'), "多币种面板仍可渲染");
  assert.ok(!settingsPage.includes('effectivePanel === "recurring"'), "周期账目面板仍可渲染");
  assert.ok(!transactionSheet.includes("另存为周期规则"), "流水编辑器仍能创建周期规则");
  assert.ok(overview.includes('"cashflow-forecast": () => null'), "周期现金流预测仍会渲染");
  assert.ok(overview.includes('"subscriptions": () => null'), "周期订阅卡仍会渲染");
});
