/**
 * [INPUT]: 依赖 src/lib/dates.ts 的 timezone/source/resolvedTimezone 选择、Intl 墙钟投影与日历原语。
 * [OUTPUT]: 提供 config 优先、system 冻结 IANA、跨区切日、仅候选可识别时的 blank→blank 漂移迁移、
 *   缺字段硬失败，以及墙钟投影对浏览器本地时区（含 DST 缺失小时）免疫的测试。
 * [POS]: web-dashboard 的记录时区变异锁；杀死浏览器回退，也锁定 nullable OS IANA 只作为可选的显式切换候选，
 *   并钉死「墙钟载体走 UTC 槽位」这条契约——它一旦退回本地 Date，DST 缺失小时会让业务分钟整体晚一小时。
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  addDays,
  healthRecordTimeZone,
  isoDate,
  isoMinute,
  rangeForMonth,
  rangeForWeek,
  recordNow,
  recordTimeZoneSelectionChanged,
  shiftMinutes,
} from "./src/lib/dates.ts";

/** 在指定的「浏览器本地时区」下跑一段断言，跑完恢复，避免污染同文件其余用例。 */
function withLocalTimeZone(timeZone, body) {
  const original = process.env.TZ;
  process.env.TZ = timeZone;
  try {
    body();
  } finally {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  }
}

test("health 的显式配置决定前端记录时区", () => {
  assert.equal(healthRecordTimeZone("Asia/Shanghai", "config", "America/Los_Angeles"), "Asia/Shanghai");
  assert.equal(healthRecordTimeZone("America/Los_Angeles", "config", "Asia/Shanghai"), "America/Los_Angeles");
});

test("同一绝对时刻按服务端记录时区切成不同自然日", () => {
  const instant = new Date("2026-07-27T16:30:00Z");
  assert.equal(isoMinute(recordNow("Asia/Shanghai", instant)), "2026-07-28T00:30");
  assert.equal(isoMinute(recordNow("America/Los_Angeles", instant)), "2026-07-27T09:30");
});

test("system 来源使用服务端冻结 IANA，绝不退回浏览器本地 Date", () => {
  const instant = new Date("2026-07-27T16:30:00Z");
  const frozen = healthRecordTimeZone("", "system", "Asia/Shanghai");
  assert.equal(frozen, "Asia/Shanghai");
  assert.equal(isoMinute(recordNow(frozen, instant)), "2026-07-28T00:30");
  assert.throws(
    () => healthRecordTimeZone("", "system", ""),
    /resolvedTimezone/,
  );
});

test("浏览器本地时区的 DST 缺失小时不得偏移记录时区的墙钟分量", () => {
  // America/Santiago 在 2026-09-06 00:00 跳到 01:00，本地 00:00–00:59 这一小时根本不存在。
  // 用本地 Date 承载墙钟分量时，new Date(2026, 8, 6, 0, 30) 会被自动前推到 01:30，
  // isoMinute 读回的业务分钟因此整体晚 60 分钟：当前时刻线画错位置，
  // blankDraft 预填的起止落到未来，被服务端 future_timestamp 拒绝。
  const instant = new Date("2026-09-05T16:30:00Z"); // 上海墙钟 2026-09-06 00:30
  withLocalTimeZone("America/Santiago", () => {
    assert.equal(new Date(2026, 8, 6, 0, 30).getHours(), 1, "前提失效：本地时区已无缺失小时");
    assert.equal(isoMinute(recordNow("Asia/Shanghai", instant)), "2026-09-06T00:30");
    assert.equal(isoDate(recordNow("Asia/Shanghai", instant)), "2026-09-06");
  });
  // 同一份输入在任何浏览器时区下必须给出同一答案——投影只认服务端记录时区。
  for (const localZone of ["UTC", "America/New_York", "Pacific/Kiritimati"]) {
    withLocalTimeZone(localZone, () => {
      assert.equal(isoMinute(recordNow("Asia/Shanghai", instant)), "2026-09-06T00:30", localZone);
      assert.equal(isoMinute(recordNow("America/Los_Angeles", instant)), "2026-09-05T09:30", localZone);
    });
  }
});

test("日界原语与墙钟载体同口径，跨 ±14 小时的本地时区都不许漂移一天", () => {
  // isoDate 读 UTC 槽位，日历原语就必须建在同一个槽位上：只改一半会让 UTC+14 的用户整体错开一天。
  for (const localZone of ["Pacific/Kiritimati", "Pacific/Midway", "Asia/Shanghai"]) {
    withLocalTimeZone(localZone, () => {
      assert.equal(addDays("2026-08-01", 1), "2026-08-02", localZone);
      assert.equal(addDays("2026-03-01", -1), "2026-02-28", localZone);
      assert.equal(addDays("2024-03-01", -1), "2024-02-29", localZone);
      assert.deepEqual(rangeForWeek("2026-08-05", "monday"), ["2026-08-03", "2026-08-09"], localZone);
      assert.deepEqual(rangeForWeek("2026-08-05", "sunday"), ["2026-08-02", "2026-08-08"], localZone);
      assert.deepEqual(rangeForMonth("2026-08-15"), ["2026-08-01", "2026-08-31"], localZone);
      assert.deepEqual(rangeForMonth("2024-02-10"), ["2024-02-01", "2024-02-29"], localZone);
    });
  }
});

test("system 时区漂移仅在候选可识别时允许 blank 到 blank 显式迁移", () => {
  const base = {
    timezone: "",
    timezoneSource: "system",
    resolvedTimezone: "America/Los_Angeles",
    currentSystemTimezone: "America/New_York",
  };
  assert.equal(recordTimeZoneSelectionChanged("", base), true);
  assert.equal(recordTimeZoneSelectionChanged("", {
    ...base,
    currentSystemTimezone: "America/Los_Angeles",
  }), false);
  assert.equal(recordTimeZoneSelectionChanged("", {
    ...base,
    currentSystemTimezone: null,
  }), false);
  assert.equal(recordTimeZoneSelectionChanged("Asia/Shanghai", base), true);
  assert.equal(recordTimeZoneSelectionChanged("Asia/Shanghai", {
    ...base,
    timezone: "Asia/Shanghai",
    timezoneSource: "config",
  }), false);
});


test("墙钟载体的分钟加减必须走 UTC 槽位，浏览器 DST 缺失小时不得把位移抹平", () => {
  // 复核者复现的场景：浏览器 America/Santiago（2026-09-06 当地 24:00 直接跳成 01:00），
  // 记录时区 Asia/Shanghai，瞬间 2026-09-05T20:30Z = 上海墙钟 09-06 04:30。
  // 载体住在 UTC 槽位，若调用方用本地 setMinutes/getMinutes 做减法，
  // 浏览器会先按本机时区渲染载体的 epoch，而那个渲染落点正压在前跳后的那一小时里——
  // 「减 60 分钟」指向的本地时刻根本不存在，JS 自动前跳，净位移为 0，
  // blankDraft 的「一小时前」于是塌成零长度草稿（终点等于起点）。
  const carrier = recordNow("Asia/Shanghai", new Date("2026-09-05T20:30:00Z"));
  assert.equal(isoMinute(carrier), "2026-09-06T04:30");
  assert.equal(isoMinute(shiftMinutes(carrier, -60)), "2026-09-06T03:30");

  // 同一份输入在任何浏览器时区下必须给出同一答案——这正是本模块头部写死的契约。
  for (const minutes of [-60, -1, 0, 1, 90, 1440]) {
    const moved = shiftMinutes(carrier, minutes);
    assert.equal(moved.getTime() - carrier.getTime(), minutes * 60_000, `位移 ${minutes} 分钟不守恒`);
  }

  // 跨日界也只按槽位算，不受本地日历影响
  assert.equal(isoMinute(shiftMinutes(carrier, -5 * 60)), "2026-09-05T23:30");
});
