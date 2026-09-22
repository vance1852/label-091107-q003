import assert from "node:assert/strict";
import { appendFile, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { openApp, seedBatch, startTestApp } from "./helpers.js";

test("进程在交接中途退出后重启，未完成的流转完整恢复", async (t) => {
  const ctx = await startTestApp(t);
  await seedBatch(ctx, { materialType: "饮用水", quantity: 300 });
  const order = await ctx.call("POST", "/transfer-orders", {
    origin: "省级仓库",
    destination: "震中安置点",
    createdBy: "调度员",
    lines: [{ materialType: "饮用水", quantity: 120 }],
  });
  const shipment = await ctx.call("POST", `/transfer-orders/${order.body.id}/shipments`, {
    carrier: "司机老王",
    lines: [{ lineId: "L1", quantity: 70 }],
  });
  const voucher1 = shipment.body.custody[0].voucher;
  const handover = await ctx.call("POST", `/shipments/${shipment.body.id}/handover`, {
    voucher: voucher1,
    toKeeper: "中转站负责人",
    node: "中途转运站",
  });
  const headVoucher = handover.body.custody.at(-1).voucher;
  const dataDir = ctx.dataDir;
  await ctx.close(); // 模拟进程退出

  // 重启：重放事件日志恢复状态
  const restored = await openApp(dataDir);
  t.after(() => restored.close());
  const orderView = await restored.call("GET", `/transfer-orders/${order.body.id}`);
  assert.equal(orderView.body.status, "shipping");
  assert.equal(orderView.body.lines[0].shippedQuantity, 70);

  const shipmentView = await restored.call("GET", `/shipments/${shipment.body.id}`);
  assert.equal(shipmentView.body.status, "in_transit");
  assert.equal(shipmentView.body.custody.length, 2);
  assert.equal(shipmentView.body.custody.at(-1).voucher, headVoucher);

  // 责任链可继续：持恢复出的顶端凭证完成签收
  const received = await restored.call("POST", `/shipments/${shipment.body.id}/receive`, {
    voucher: headVoucher,
    toKeeper: "安置点负责人",
    node: "震中安置点",
  });
  assert.equal(received.status, 200);
  assert.strictEqual(received.body.status, "delivered");

  // 库存账目在重启前后一致
  const inventory = await restored.call("GET", "/reports/inventory");
  const water = inventory.body.find((b) => b.materialType === "饮用水");
  assert.equal(water.locations.find((l) => l.location === "省级仓库").onHand, 230);
  assert.equal(water.locations.find((l) => l.location === "省级仓库").reserved, 50);
  assert.equal(water.locations.find((l) => l.location === "震中安置点").onHand, 70);

  // 重启后新单号/批次号不与历史冲突
  const batch = await seedBatch(restored, { materialType: "帐篷", quantity: 10 });
  assert.notEqual(batch.id, "B-000001");
  const order2 = await restored.call("POST", "/transfer-orders", {
    origin: "省级仓库",
    destination: "另一安置点",
    createdBy: "调度员",
    lines: [{ materialType: "帐篷", quantity: 5 }],
  });
  assert.equal(order2.status, 201);
  await restored.close();

  // 第二次重启：重开之后写入的事件也必须完整保留
  const again = await openApp(dataDir);
  t.after(() => again.close());
  const order2View = await again.call("GET", `/transfer-orders/${order2.body.id}`);
  assert.equal(order2View.body.id, order2.body.id);
  const batchView = await again.call("GET", `/batches/${batch.id}`);
  assert.equal(batchView.body.totalOnHand, 10);
  const shipmentView2 = await again.call("GET", `/shipments/${shipment.body.id}`);
  assert.equal(shipmentView2.body.status, "delivered");
  assert.equal(shipmentView2.body.custody.length, 3);
});

test("日志末尾的半截记录被安全截断，已提交的流转不丢失", async (t) => {
  const ctx = await startTestApp(t);
  await seedBatch(ctx, { materialType: "药品", quantity: 80 });
  const order = await ctx.call("POST", "/transfer-orders", {
    origin: "省级仓库",
    destination: "震中安置点",
    createdBy: "调度员",
    lines: [{ materialType: "药品", quantity: 30 }],
  });
  const dataDir = ctx.dataDir;
  await ctx.close();

  // 模拟崩溃时写了一半的日志行
  const journalPath = path.join(dataDir, "journal.jsonl");
  const before = await readFile(journalPath, "utf8");
  await appendFile(journalPath, '{"type":"custody_appended","at":"2026-09-22T11:00');

  const restored = await openApp(dataDir);
  t.after(() => restored.close());
  const orderView = await restored.call("GET", `/transfer-orders/${order.body.id}`);
  assert.equal(orderView.body.status, "open");

  // 截断后日志仍可继续追加
  const shipment = await restored.call("POST", `/transfer-orders/${order.body.id}/shipments`, {
    carrier: "司机老王",
    lines: [{ lineId: "L1", quantity: 30 }],
  });
  assert.equal(shipment.status, 201);

  const after = await readFile(journalPath, "utf8");
  const lines = after.trim().split("\n");
  assert.equal(lines.length, before.trim().split("\n").length + 1);
  for (const line of lines) JSON.parse(line); // 每行都是完整 JSON
});

test("离线同步结果在重启后依然有效", async (t) => {
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
    lines: [{ lineId: "L1", quantity: 50 }],
  });
  const head = shipment.body.custody[0].voucher;
  await ctx.call("POST", `/shipments/${shipment.body.id}/offline-sync`, {
    records: [
      {
        seq: 2,
        type: "handover",
        voucher: "OFF-V2",
        previousVoucher: head,
        toKeeper: "中转站负责人",
        node: "中途转运站",
        at: "2026-09-22T10:00:00.000Z",
      },
    ],
  });
  const dataDir = ctx.dataDir;
  await ctx.close();

  const restored = await openApp(dataDir);
  t.after(() => restored.close());
  const view = await restored.call("GET", `/shipments/${shipment.body.id}`);
  assert.equal(view.body.custody.length, 2);
  assert.equal(view.body.custody[1].voucher, "OFF-V2");

  // 重启后重复提交同一条离线记录 → 识别为重复而非冲突
  const retry = await restored.call("POST", `/shipments/${shipment.body.id}/offline-sync`, {
    records: [
      {
        seq: 2,
        type: "handover",
        voucher: "OFF-V2",
        previousVoucher: head,
        toKeeper: "中转站负责人",
        node: "中途转运站",
        at: "2026-09-22T10:00:00.000Z",
      },
    ],
  });
  assert.equal(retry.body.duplicates.length, 1);
  assert.equal(retry.body.rejected.length, 0);
});
