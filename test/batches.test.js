import assert from "node:assert/strict";
import test from "node:test";
import { seedBatch, startTestApp } from "./helpers.js";

test("登记批次：保留保质期、位置与责任人", async (t) => {
  const ctx = await startTestApp(t);
  const batch = await seedBatch(ctx, {
    materialType: "药品",
    quantity: 500,
    expiryDate: "2026-12-31T00:00:00.000Z",
    location: "省级仓库",
    keeper: "仓管员乙",
  });
  assert.match(batch.id, /^B-\d{6}$/);
  assert.equal(batch.expiryDate, "2026-12-31T00:00:00.000Z");

  const detail = await ctx.call("GET", `/batches/${batch.id}`);
  assert.equal(detail.body.locations[0].location, "省级仓库");
  assert.equal(detail.body.locations[0].keeper, "仓管员乙");
  assert.equal(detail.body.locations[0].onHand, 500);
  assert.equal(detail.body.expired, false);
});

test("登记批次：缺字段与非法数量被拒绝", async (t) => {
  const ctx = await startTestApp(t);
  const missing = await ctx.call("POST", "/batches", { materialType: "帐篷" });
  assert.equal(missing.status, 400);
  const badQty = await ctx.call("POST", "/batches", {
    materialType: "帐篷",
    quantity: 3.5,
    location: "省级仓库",
    keeper: "仓管员甲",
  });
  assert.equal(badQty.status, 400);
  const badDate = await ctx.call("POST", "/batches", {
    materialType: "帐篷",
    quantity: 10,
    location: "省级仓库",
    keeper: "仓管员甲",
    expiryDate: "not-a-date",
  });
  assert.equal(badDate.status, 400);
});

test("库存不足时不能分配", async (t) => {
  const ctx = await startTestApp(t);
  await seedBatch(ctx, { materialType: "饮用水", quantity: 50 });
  const response = await ctx.call("POST", "/transfer-orders", {
    origin: "省级仓库",
    destination: "震中安置点",
    createdBy: "调度员",
    lines: [{ materialType: "饮用水", quantity: 80 }],
  });
  assert.equal(response.status, 409);
  assert.match(response.body.error, /库存不足/);
});

test("已过期的批次不能分配", async (t) => {
  const ctx = await startTestApp(t);
  await seedBatch(ctx, {
    materialType: "药品",
    quantity: 200,
    expiryDate: "2026-09-01T00:00:00.000Z", // 已过期（当前 2026-09-22）
  });
  const response = await ctx.call("POST", "/transfer-orders", {
    origin: "省级仓库",
    destination: "震中安置点",
    createdBy: "调度员",
    lines: [{ materialType: "药品", quantity: 10 }],
  });
  assert.equal(response.status, 409);
  assert.match(response.body.error, /库存不足/);

  const specified = await ctx.call("POST", "/transfer-orders", {
    origin: "省级仓库",
    destination: "震中安置点",
    createdBy: "调度员",
    lines: [{ materialType: "药品", quantity: 10, batchId: "B-000001" }],
  });
  assert.equal(specified.status, 409);
  assert.match(specified.body.error, /已过保质期/);
});

test("分配按 FEFO（先到期先出），临期批次优先", async (t) => {
  const ctx = await startTestApp(t);
  const later = await seedBatch(ctx, {
    materialType: "药品",
    quantity: 100,
    expiryDate: "2027-06-01T00:00:00.000Z",
  });
  const sooner = await seedBatch(ctx, {
    materialType: "药品",
    quantity: 100,
    expiryDate: "2026-10-01T00:00:00.000Z",
  });
  const response = await ctx.call("POST", "/transfer-orders", {
    origin: "省级仓库",
    destination: "震中安置点",
    createdBy: "调度员",
    lines: [{ materialType: "药品", quantity: 60 }],
  });
  assert.equal(response.status, 201);
  const [line] = response.body.lines;
  assert.deepEqual(
    line.allocations.map((a) => a.batchId),
    [sooner.id],
  );

  // 再订 60：先用完临期批次剩余 40，再用远期批次 20
  const second = await ctx.call("POST", "/transfer-orders", {
    origin: "省级仓库",
    destination: "震中安置点",
    createdBy: "调度员",
    lines: [{ materialType: "药品", quantity: 60 }],
  });
  assert.deepEqual(
    second.body.lines[0].allocations.map((a) => [a.batchId, a.quantity]),
    [
      [sooner.id, 40],
      [later.id, 20],
    ],
  );
});

test("时间推进后批次变为过期并进入异常清单", async (t) => {
  const ctx = await startTestApp(t);
  const batch = await seedBatch(ctx, {
    materialType: "药品",
    quantity: 30,
    expiryDate: "2026-09-25T00:00:00.000Z",
  });
  // 三天内到期 → 临期
  let exceptions = await ctx.call("GET", "/reports/exceptions?withinDays=7");
  assert.equal(exceptions.body.filter((e) => e.type === "near_expiry").length, 1);
  assert.equal(exceptions.body[0].keepers[0].keeper, "仓管员甲");

  // 推进到过期之后
  ctx.setClock(new Date("2026-09-26T00:00:00.000Z"));
  exceptions = await ctx.call("GET", "/reports/exceptions");
  const expired = exceptions.body.find((e) => e.type === "expired_stock");
  assert.equal(expired.batchId, batch.id);

  const list = await ctx.call("GET", "/batches");
  assert.equal(list.body.length, 0, "默认不列出已过期批次");
  const all = await ctx.call("GET", "/batches?includeExpired=true");
  assert.equal(all.body.length, 1);
});
