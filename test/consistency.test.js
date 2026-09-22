import assert from "node:assert/strict";
import test from "node:test";
import { seedBatch, startTestApp } from "./helpers.js";

test("同一调拨单内多行同类物资不得重复占用库存", async (t) => {
  const ctx = await startTestApp(t);
  await seedBatch(ctx, { materialType: "饮用水", quantity: 100 });
  const response = await ctx.call("POST", "/transfer-orders", {
    origin: "省级仓库",
    destination: "震中安置点",
    createdBy: "调度员",
    lines: [
      { materialType: "饮用水", quantity: 60 },
      { materialType: "饮用水", quantity: 60 },
    ],
  });
  assert.equal(response.status, 409, "两行合计 120 超出库存 100，必须拒绝");

  const ok = await ctx.call("POST", "/transfer-orders", {
    origin: "省级仓库",
    destination: "震中安置点",
    createdBy: "调度员",
    lines: [
      { materialType: "饮用水", quantity: 60 },
      { materialType: "饮用水", quantity: 40 },
    ],
  });
  assert.equal(ok.status, 201);
  const inventory = await ctx.call("GET", "/reports/inventory");
  assert.equal(inventory.body[0].locations[0].reserved, 100);
});

test("一次装车同一明细行出现多次时按合并数量处理", async (t) => {
  const ctx = await startTestApp(t);
  await seedBatch(ctx, { materialType: "饮用水", quantity: 100 });
  const order = await ctx.call("POST", "/transfer-orders", {
    origin: "省级仓库",
    destination: "震中安置点",
    createdBy: "调度员",
    lines: [{ materialType: "饮用水", quantity: 50 }],
  });
  const shipment = await ctx.call("POST", `/transfer-orders/${order.body.id}/shipments`, {
    carrier: "司机老王",
    lines: [
      { lineId: "L1", quantity: 20 },
      { lineId: "L1", quantity: 30 },
    ],
  });
  assert.equal(shipment.status, 201);
  const total = shipment.body.lines.reduce((sum, line) => sum + line.quantity, 0);
  assert.equal(total, 50);

  // 合并后仍不得超过未发数量
  const order2 = await ctx.call("POST", "/transfer-orders", {
    origin: "省级仓库",
    destination: "震中安置点",
    createdBy: "调度员",
    lines: [{ materialType: "饮用水", quantity: 40 }],
  });
  const tooMuch = await ctx.call("POST", `/transfer-orders/${order2.body.id}/shipments`, {
    carrier: "司机老王",
    lines: [
      { lineId: "L1", quantity: 25 },
      { lineId: "L1", quantity: 25 },
    ],
  });
  assert.equal(tooMuch.status, 409);
});

test("一次调整中同一明细行重复出现被拒绝", async (t) => {
  const ctx = await startTestApp(t);
  await seedBatch(ctx, { materialType: "饮用水", quantity: 100 });
  const order = await ctx.call("POST", "/transfer-orders", {
    origin: "省级仓库",
    destination: "震中安置点",
    createdBy: "调度员",
    lines: [{ materialType: "饮用水", quantity: 50 }],
  });
  const response = await ctx.call("PATCH", `/transfer-orders/${order.body.id}`, {
    lines: [
      { lineId: "L1", quantity: 40 },
      { lineId: "L1", quantity: 30 },
    ],
  });
  assert.equal(response.status, 400);
});

test("并发请求被串行化：库存不会被超额分配", async (t) => {
  const ctx = await startTestApp(t);
  await seedBatch(ctx, { materialType: "饮用水", quantity: 100 });

  // 同时发出 6 个各要 30 的调拨单，库存只够 3 个
  const results = await Promise.all(
    Array.from({ length: 6 }, () =>
      ctx.call("POST", "/transfer-orders", {
        origin: "省级仓库",
        destination: "震中安置点",
        createdBy: "调度员",
        lines: [{ materialType: "饮用水", quantity: 30 }],
      }),
    ),
  );
  const created = results.filter((r) => r.status === 201);
  const rejected = results.filter((r) => r.status === 409);
  assert.equal(created.length, 3);
  assert.equal(rejected.length, 3);

  const inventory = await ctx.call("GET", "/reports/inventory");
  assert.equal(inventory.body[0].locations[0].reserved, 90);
  assert.equal(inventory.body[0].locations[0].available, 10);
});

test("并发装车与调整不会破坏账目", async (t) => {
  const ctx = await startTestApp(t);
  await seedBatch(ctx, { materialType: "饮用水", quantity: 200 });
  const order = await ctx.call("POST", "/transfer-orders", {
    origin: "省级仓库",
    destination: "震中安置点",
    createdBy: "调度员",
    lines: [{ materialType: "饮用水", quantity: 100 }],
  });
  // 并发：两个装车（30 + 40）与一次调整到 50 —— 任何串行顺序下都恰有一个被拒
  const results = await Promise.all([
    ctx.call("POST", `/transfer-orders/${order.body.id}/shipments`, {
      carrier: "司机甲",
      lines: [{ lineId: "L1", quantity: 30 }],
    }),
    ctx.call("POST", `/transfer-orders/${order.body.id}/shipments`, {
      carrier: "司机乙",
      lines: [{ lineId: "L1", quantity: 40 }],
    }),
    ctx.call("PATCH", `/transfer-orders/${order.body.id}`, {
      lines: [{ lineId: "L1", quantity: 50 }],
    }),
  ]);
  const succeeded = results.filter((r) => [200, 201].includes(r.status));
  const rejected = results.filter((r) => r.status === 409);
  assert.equal(succeeded.length, 2);
  assert.equal(rejected.length, 1);

  // 无论实际串行顺序如何，账目必须守恒
  const view = await ctx.call("GET", `/transfer-orders/${order.body.id}`);
  const line = view.body.lines[0];
  assert.ok(line.shippedQuantity <= line.quantity, "已发不得超过计划");
  const inventory = await ctx.call("GET", "/reports/inventory");
  const holding = inventory.body[0].locations[0];
  assert.equal(holding.onHand, 200 - line.shippedQuantity);
  assert.equal(holding.reserved, line.quantity - line.shippedQuantity);
});
