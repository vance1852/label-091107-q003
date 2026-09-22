import assert from "node:assert/strict";
import test from "node:test";
import { seedBatch, startTestApp } from "./helpers.js";

async function seedShipment(ctx) {
  await seedBatch(ctx, { materialType: "饮用水", quantity: 200 });
  const order = await ctx.call("POST", "/transfer-orders", {
    origin: "省级仓库",
    destination: "震中安置点",
    createdBy: "调度员",
    lines: [{ materialType: "饮用水", quantity: 100 }],
  });
  const shipment = await ctx.call("POST", `/transfer-orders/${order.body.id}/shipments`, {
    carrier: "司机老王",
    lines: [{ lineId: "L1", quantity: 100 }],
  });
  return { order: order.body, shipment: shipment.body };
}

const offlineRecord = (seq, overrides = {}) => ({
  seq,
  type: "handover",
  voucher: `OFF-V${seq}`,
  previousVoucher: null, // 由各用例显式填写
  toKeeper: `节点${seq}负责人`,
  node: `中途节点${seq}`,
  at: "2026-09-22T10:00:00.000Z",
  ...overrides,
});

test("离线交接：可衔接的记录被接受，责任链按序号延伸", async (t) => {
  const ctx = await startTestApp(t);
  const { shipment } = await seedShipment(ctx);
  const head = shipment.custody[0].voucher;

  const result = await ctx.call("POST", `/shipments/${shipment.id}/offline-sync`, {
    records: [
      offlineRecord(2, { previousVoucher: head }),
      offlineRecord(3, { previousVoucher: "OFF-V2" }),
    ],
  });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.applied.map((r) => r.seq), [2, 3]);
  assert.equal(result.body.head, "OFF-V3");

  const view = await ctx.call("GET", `/shipments/${shipment.id}`);
  assert.equal(view.body.custody.length, 3);
  assert.equal(view.body.custody[2].toKeeper, "节点3负责人");
  assert.equal(view.body.custody[2].previousVoucher, "OFF-V2");

  // 后续在线交接必须持离线链顶端凭证
  const next = await ctx.call("POST", `/shipments/${shipment.id}/handover`, {
    voucher: "OFF-V3",
    toKeeper: "终点前站负责人",
    node: "终点前站",
  });
  assert.equal(next.status, 200);
  assert.equal(next.body.custody.at(-1).seq, 4);
});

test("离线交接：重复提交幂等，冲突版本被拒绝且不影响原责任链", async (t) => {
  const ctx = await startTestApp(t);
  const { shipment } = await seedShipment(ctx);
  const head = shipment.custody[0].voucher;

  await ctx.call("POST", `/shipments/${shipment.id}/offline-sync`, {
    records: [offlineRecord(2, { previousVoucher: head })],
  });

  // 网络重试：同样的记录再次提交 → 全部识别为重复，状态不变
  const retry = await ctx.call("POST", `/shipments/${shipment.id}/offline-sync`, {
    records: [offlineRecord(2, { previousVoucher: head })],
  });
  assert.equal(retry.body.applied.length, 0);
  assert.deepEqual(retry.body.duplicates.map((r) => r.seq), [2]);
  let view = await ctx.call("GET", `/shipments/${shipment.id}`);
  assert.equal(view.body.custody.length, 2);

  // 冲突版本：同一序号但内容不同 → 拒绝并记录异常，原链不变
  const conflict = await ctx.call("POST", `/shipments/${shipment.id}/offline-sync`, {
    records: [
      offlineRecord(2, { previousVoucher: head, toKeeper: "冒名顶替者", voucher: "OFF-V2-ALT" }),
      offlineRecord(9, { previousVoucher: "OFF-V8" }), // 断链：跳号
    ],
  });
  assert.deepEqual(
    conflict.body.rejected.map((r) => [r.seq, r.reason]),
    [
      [2, "conflict"],
      [9, "disconnected"],
    ],
  );
  view = await ctx.call("GET", `/shipments/${shipment.id}`);
  assert.equal(view.body.custody.length, 2, "原责任链未被污染");
  assert.equal(view.body.custody[1].toKeeper, "节点2负责人");

  const exceptions = await ctx.call("GET", "/reports/exceptions");
  const conflicts = exceptions.body.filter((e) => e.type === "offline_conflict");
  assert.equal(conflicts.length, 1);
  assert.match(conflicts[0].message, /序号 2/);

  // 冲突之后，沿原责任链延伸的记录仍可衔接
  const resume = await ctx.call("POST", `/shipments/${shipment.id}/offline-sync`, {
    records: [offlineRecord(3, { previousVoucher: "OFF-V2" })],
  });
  assert.deepEqual(resume.body.applied.map((r) => r.seq), [3]);
  assert.equal(resume.body.head, "OFF-V3");
});

test("离线交接：一次提交中先衔接后断链，只接受可衔接前缀之后的有效部分", async (t) => {
  const ctx = await startTestApp(t);
  const { shipment } = await seedShipment(ctx);
  const head = shipment.custody[0].voucher;

  // seq 4 依赖被拒的 seq 3（断链），seq 2 可衔接 → 接受 2，拒绝 3/4 中与链不符的
  const result = await ctx.call("POST", `/shipments/${shipment.id}/offline-sync`, {
    records: [
      offlineRecord(3, { previousVoucher: "WRONG" }),
      offlineRecord(2, { previousVoucher: head }),
      offlineRecord(4, { previousVoucher: "OFF-V3" }),
    ],
  });
  assert.deepEqual(result.body.applied.map((r) => r.seq), [2]);
  assert.deepEqual(
    result.body.rejected.map((r) => [r.seq, r.reason]),
    [
      [3, "disconnected"],
      [4, "disconnected"],
    ],
  );
});

test("离线交接：凭证号全局唯一，复用他人凭证被拒绝", async (t) => {
  const ctx = await startTestApp(t);
  const { shipment } = await seedShipment(ctx);
  const head = shipment.custody[0].voucher;

  const result = await ctx.call("POST", `/shipments/${shipment.id}/offline-sync`, {
    records: [offlineRecord(2, { previousVoucher: head, voucher: head })],
  });
  assert.deepEqual(result.body.rejected, [{ seq: 2, voucher: head, reason: "voucher_reused" }]);
});

test("离线交接：离线签收可完成到站入库", async (t) => {
  const ctx = await startTestApp(t);
  const { shipment } = await seedShipment(ctx);
  const head = shipment.custody[0].voucher;

  const result = await ctx.call("POST", `/shipments/${shipment.id}/offline-sync`, {
    records: [
      offlineRecord(2, {
        type: "receive",
        previousVoucher: head,
        toKeeper: "安置点负责人",
        node: "震中安置点",
      }),
    ],
  });
  assert.equal(result.body.status, "delivered");

  const inventory = await ctx.call("GET", "/reports/inventory");
  const water = inventory.body.find((b) => b.materialType === "饮用水");
  const arrived = water.locations.find((l) => l.location === "震中安置点");
  assert.equal(arrived.onHand, 100);
  assert.equal(arrived.keeper, "安置点负责人");

  // 已终结的发运单不再接受同步
  const again = await ctx.call("POST", `/shipments/${shipment.id}/offline-sync`, {
    records: [offlineRecord(3, { previousVoucher: "OFF-V2" })],
  });
  assert.equal(again.status, 409);
});

test("离线交接：退回与退回接收也可离线完成", async (t) => {
  const ctx = await startTestApp(t);
  const { shipment } = await seedShipment(ctx);
  const head = shipment.custody[0].voucher;

  const result = await ctx.call("POST", `/shipments/${shipment.id}/offline-sync`, {
    records: [
      offlineRecord(2, {
        type: "return",
        previousVoucher: head,
        toKeeper: "司机老王",
        node: "省级仓库",
        note: "桥梁垮塌无法通行",
      }),
      offlineRecord(3, {
        type: "return_receive",
        previousVoucher: "OFF-V2",
        toKeeper: "仓管员甲",
        node: "省级仓库",
        restock: true,
      }),
    ],
  });
  assert.equal(result.body.status, "returned");
  const inventory = await ctx.call("GET", "/reports/inventory");
  const water = inventory.body.find((b) => b.materialType === "饮用水");
  assert.equal(water.locations[0].onHand, 200, "退回物资已重新入库");
  const exceptions = await ctx.call("GET", "/reports/exceptions");
  assert.equal(exceptions.body.filter((e) => e.type === "shipment_returned").length, 1);
});
