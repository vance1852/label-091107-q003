import assert from "node:assert/strict";
import test from "node:test";
import { seedBatch, startTestApp } from "./helpers.js";

async function seedOrder(ctx, { water = 100, tents = 20 } = {}) {
  await seedBatch(ctx, { materialType: "饮用水", quantity: 500, keeper: "仓管员甲" });
  await seedBatch(ctx, {
    materialType: "帐篷",
    quantity: 100,
    expiryDate: null,
    keeper: "仓管员甲",
  });
  const lines = [];
  if (water > 0) lines.push({ materialType: "饮用水", quantity: water });
  if (tents > 0) lines.push({ materialType: "帐篷", quantity: tents });
  const response = await ctx.call("POST", "/transfer-orders", {
    origin: "省级仓库",
    destination: "震中安置点",
    createdBy: "调度员小李",
    lines,
  });
  assert.equal(response.status, 201);
  return response.body;
}

test("完整流转：建单→分批装车→途中交接→到站签收→目的地入库", async (t) => {
  const ctx = await startTestApp(t);
  const order = await seedOrder(ctx);
  assert.equal(order.status, "open");
  assert.match(order.id, /^T-\d{6}$/);

  // 第一批装车：饮用水 60
  const shipment1 = await ctx.call("POST", `/transfer-orders/${order.id}/shipments`, {
    carrier: "司机老王",
    lines: [{ lineId: "L1", quantity: 60 }],
  });
  assert.equal(shipment1.status, 201);
  assert.equal(shipment1.body.status, "in_transit");
  const voucher1 = shipment1.body.custody[0].voucher;
  assert.match(voucher1, /^V-\d{6}$/);

  let orderView = await ctx.call("GET", `/transfer-orders/${order.id}`);
  assert.equal(orderView.body.status, "shipping");
  assert.equal(orderView.body.lines[0].shippedQuantity, 60);

  // 库存：60 已出库，40 仍预留
  const inventory = await ctx.call("GET", "/reports/inventory");
  const water = inventory.body.find((b) => b.materialType === "饮用水");
  assert.equal(water.locations[0].onHand, 440);
  assert.equal(water.locations[0].reserved, 40);
  assert.equal(water.inTransit[0].quantity, 60);

  // 无凭证不能交接
  const noVoucher = await ctx.call("POST", `/shipments/${shipment1.body.id}/handover`, {
    voucher: "V-999999",
    toKeeper: "中转站负责人",
    node: "中途转运站",
  });
  assert.equal(noVoucher.status, 409);
  assert.match(noVoucher.body.error, /凭证不匹配/);

  // 持凭证交接给中转站
  const handover = await ctx.call("POST", `/shipments/${shipment1.body.id}/handover`, {
    voucher: voucher1,
    toKeeper: "中转站负责人",
    node: "中途转运站",
  });
  assert.equal(handover.status, 200);
  const voucher2 = handover.body.custody.at(-1).voucher;
  assert.equal(handover.body.custody.at(-1).seq, 2);
  assert.equal(handover.body.custody.at(-1).previousVoucher, voucher1);

  // 旧凭证已失效
  const stale = await ctx.call("POST", `/shipments/${shipment1.body.id}/receive`, {
    voucher: voucher1,
    toKeeper: "安置点负责人",
    node: "震中安置点",
  });
  assert.equal(stale.status, 409);

  // 非目的地不能签收
  const wrongNode = await ctx.call("POST", `/shipments/${shipment1.body.id}/receive`, {
    voucher: voucher2,
    toKeeper: "安置点负责人",
    node: "中途转运站",
  });
  assert.equal(wrongNode.status, 409);
  assert.match(wrongNode.body.error, /不是目的地/);

  // 持最新凭证到目的地签收
  const received = await ctx.call("POST", `/shipments/${shipment1.body.id}/receive`, {
    voucher: voucher2,
    toKeeper: "安置点负责人",
    node: "震中安置点",
  });
  assert.equal(received.status, 200);
  assert.equal(received.body.status, "delivered");

  // 目的地库存增加，责任人变为签收人
  const after = await ctx.call("GET", "/reports/inventory");
  const waterAfter = after.body.find((b) => b.materialType === "饮用水");
  const atDestination = waterAfter.locations.find((l) => l.location === "震中安置点");
  assert.equal(atDestination.onHand, 60);
  assert.equal(atDestination.keeper, "安置点负责人");

  // 第二批装车：剩余饮用水 40 + 全部帐篷 → 订单完成
  const shipment2 = await ctx.call("POST", `/transfer-orders/${order.id}/shipments`, {
    carrier: "司机老赵",
    lines: [
      { lineId: "L1", quantity: 40 },
      { lineId: "L2", quantity: 20 },
    ],
  });
  assert.equal(shipment2.status, 201);
  orderView = await ctx.call("GET", `/transfer-orders/${order.id}`);
  assert.equal(orderView.body.status, "fulfilled");

  // 目的地汇总
  const summary = await ctx.call("GET", "/reports/destinations");
  const row = summary.body.find((r) => r.destination === "震中安置点");
  assert.equal(row.planned, 120);
  assert.equal(row.shipped, 120);
  assert.equal(row.received, 60);
  assert.equal(row.inTransit, 60);

  // 旅程还原
  const journey = await ctx.call("GET", `/transfer-orders/${order.id}/journey`);
  const types = journey.body.timeline.map((e) => e.type);
  assert.deepEqual(types, [
    "order_created",
    "shipment_loaded",
    "custody_appended",
    "custody_appended",
    "shipment_loaded",
  ]);
  assert.equal(journey.body.shipments.length, 2);
  assert.equal(journey.body.shipments[0].custody.length, 3);
});

test("部分发运后只允许调整未发数量", async (t) => {
  const ctx = await startTestApp(t);
  const order = await seedOrder(ctx);
  await ctx.call("POST", `/transfer-orders/${order.id}/shipments`, {
    carrier: "司机老王",
    lines: [{ lineId: "L1", quantity: 40 }],
  });

  // 调到 30 < 已发 40 → 拒绝
  const tooLow = await ctx.call("PATCH", `/transfer-orders/${order.id}`, {
    lines: [{ lineId: "L1", quantity: 30 }],
  });
  assert.equal(tooLow.status, 409);
  assert.match(tooLow.body.error, /已发运 40/);

  // 调到 70：释放 30 预留
  const adjusted = await ctx.call("PATCH", `/transfer-orders/${order.id}`, {
    lines: [{ lineId: "L1", quantity: 70 }],
  });
  assert.equal(adjusted.status, 200);
  assert.equal(adjusted.body.lines[0].quantity, 70);
  let inventory = await ctx.call("GET", "/reports/inventory");
  let water = inventory.body.find((b) => b.materialType === "饮用水");
  assert.equal(water.locations[0].reserved, 30);
  assert.equal(water.locations[0].available, 430); // onHand 460 - reserved 30

  // 上调到 120：库存足够，追加分配
  const increased = await ctx.call("PATCH", `/transfer-orders/${order.id}`, {
    lines: [{ lineId: "L1", quantity: 120 }],
  });
  assert.equal(increased.status, 200);
  inventory = await ctx.call("GET", "/reports/inventory");
  water = inventory.body.find((b) => b.materialType === "饮用水");
  assert.equal(water.locations[0].reserved, 80);

  // 上调到超出库存 → 拒绝
  const tooMuch = await ctx.call("PATCH", `/transfer-orders/${order.id}`, {
    lines: [{ lineId: "L1", quantity: 1000 }],
  });
  assert.equal(tooMuch.status, 409);

  // 发运剩余全部后订单完成，不能再调整
  await ctx.call("POST", `/transfer-orders/${order.id}/shipments`, {
    carrier: "司机老王",
    lines: [
      { lineId: "L1", quantity: 80 },
      { lineId: "L2", quantity: 20 },
    ],
  });
  const locked = await ctx.call("PATCH", `/transfer-orders/${order.id}`, {
    lines: [{ lineId: "L1", quantity: 100 }],
  });
  assert.equal(locked.status, 409);
});

test("取消调拨单释放未发库存，已发部分保留记录", async (t) => {
  const ctx = await startTestApp(t);
  const order = await seedOrder(ctx);
  await ctx.call("POST", `/transfer-orders/${order.id}/shipments`, {
    carrier: "司机老王",
    lines: [{ lineId: "L1", quantity: 25 }],
  });
  const cancelled = await ctx.call("POST", `/transfer-orders/${order.id}/cancel`);
  assert.equal(cancelled.body.status, "closed");
  assert.equal(cancelled.body.lines[0].shippedQuantity, 25);

  const inventory = await ctx.call("GET", "/reports/inventory");
  const water = inventory.body.find((b) => b.materialType === "饮用水");
  assert.equal(water.locations[0].reserved, 0);
  assert.equal(water.locations[0].onHand, 475);

  const again = await ctx.call("POST", `/transfer-orders/${order.id}/cancel`);
  assert.equal(again.status, 409);
});

test("异常退回：途中退回→起点接收→重新入库；报废则记异常", async (t) => {
  const ctx = await startTestApp(t);
  const order = await seedOrder(ctx, { water: 60, tents: 0 });
  const shipment = await ctx.call("POST", `/transfer-orders/${order.id}/shipments`, {
    carrier: "司机老王",
    lines: [{ lineId: "L1", quantity: 60 }],
  });
  const voucher = shipment.body.custody[0].voucher;

  // 道路中断，异常退回
  const returned = await ctx.call("POST", `/shipments/${shipment.body.id}/return`, {
    voucher,
    reason: "前方塌方，道路中断",
  });
  assert.equal(returned.status, 200);
  assert.equal(returned.body.status, "returning");

  // 退回途中不能再按正常签收
  const receive = await ctx.call("POST", `/shipments/${shipment.body.id}/receive`, {
    voucher: returned.body.custody.at(-1).voucher,
    toKeeper: "安置点负责人",
    node: "震中安置点",
  });
  assert.equal(receive.status, 409);

  // 起点仓管员接收退回，重新入库
  const back = await ctx.call("POST", `/shipments/${shipment.body.id}/return-receive`, {
    voucher: returned.body.custody.at(-1).voucher,
    toKeeper: "仓管员甲",
    node: "省级仓库",
    restock: true,
  });
  assert.equal(back.status, 200);
  assert.equal(back.body.status, "returned");

  const inventory = await ctx.call("GET", "/reports/inventory");
  const water = inventory.body.find((b) => b.materialType === "饮用水");
  assert.equal(water.locations[0].onHand, 500, "退回物资已重新入库");

  const exceptions = await ctx.call("GET", "/reports/exceptions");
  const returnedEvents = exceptions.body.filter((e) => e.type === "shipment_returned");
  assert.equal(returnedEvents.length, 1);
  assert.match(returnedEvents[0].message, /道路中断/);

  const summary = await ctx.call("GET", "/reports/destinations");
  assert.equal(summary.body[0].returned, 60);
});

test("退回物资报废：不重新入库并记录报废异常", async (t) => {
  const ctx = await startTestApp(t);
  const order = await seedOrder(ctx, { water: 10, tents: 0 });
  const shipment = await ctx.call("POST", `/transfer-orders/${order.id}/shipments`, {
    carrier: "司机老王",
    lines: [{ lineId: "L1", quantity: 10 }],
  });
  const returned = await ctx.call("POST", `/shipments/${shipment.body.id}/return`, {
    voucher: shipment.body.custody[0].voucher,
    reason: "包装破损污染",
  });
  await ctx.call("POST", `/shipments/${shipment.body.id}/return-receive`, {
    voucher: returned.body.custody.at(-1).voucher,
    toKeeper: "仓管员甲",
    node: "省级仓库",
    restock: false,
  });
  const inventory = await ctx.call("GET", "/reports/inventory");
  const water = inventory.body.find((b) => b.materialType === "饮用水");
  assert.equal(water.locations[0].onHand, 490, "报废物资不得重新入库");
  const exceptions = await ctx.call("GET", "/reports/exceptions");
  assert.equal(exceptions.body.filter((e) => e.type === "written_off").length, 1);
});

test("装车数量不能超过未发数量", async (t) => {
  const ctx = await startTestApp(t);
  const order = await seedOrder(ctx, { water: 50, tents: 0 });
  const tooMuch = await ctx.call("POST", `/transfer-orders/${order.id}/shipments`, {
    carrier: "司机老王",
    lines: [{ lineId: "L1", quantity: 51 }],
  });
  assert.equal(tooMuch.status, 409);
  assert.match(tooMuch.body.error, /超出可发范围/);
});
