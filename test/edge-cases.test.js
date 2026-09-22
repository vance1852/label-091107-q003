import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ConflictError, ReliefService } from "../src/service.js";

function fresh() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "relife-edge-"));
  const service = new ReliefService(dir);
  service.registerBatch({ batchNo: "B-W", category: "water", name: "饮用水", quantity: 100, expiryDate: "2099-01-01", location: "省库A", owner: "王仓管" });
  service.registerBatch({ batchNo: "B-M", category: "medicine", name: "消炎药", quantity: 50, expiryDate: "2099-06-30", location: "省库B", owner: "赵药师" });
  service.registerBatch({ batchNo: "B-T", category: "tent", name: "帐篷", quantity: 30, expiryDate: "2099-01-01", location: "省库C", owner: "王仓管" });
  return { service, dir };
}

test("多批次同车装运，签收按批次核对，短缺各自登记", () => {
  const { service, dir } = fresh();
  service.createTransfer({
    transferNo: "T1",
    destination: "HW",
    destinationName: "汉旺",
    createdBy: "王仓管",
    lines: [
      { batchNo: "B-W", quantity: 20 },
      { batchNo: "B-M", quantity: 10 },
    ],
  });
  const loaded = service.loadShipment("T1", {
    actor: "王仓管",
    node: "省库",
    toNode: "汉旺",
    lines: [
      { batchNo: "B-W", quantity: 20 },
      { batchNo: "B-M", quantity: 10 },
    ],
  });
  const cert = loaded.departureCert.certNo;
  const signed = service.signShipment("T1", loaded.shipment.shipmentNo, {
    actor: "张接收",
    node: "汉旺",
    certNo: cert,
    quantities: { "B-W": 20, "B-M": 8 },
  });
  assert.equal(signed.exceptions.length, 1);
  assert.equal(signed.exceptions[0].batchNo, "B-M");
  assert.equal(service.viewBatch("B-W").onHand, 80);
  assert.equal(service.viewBatch("B-M").onHand, 40);
  rmSync(dir, { recursive: true, force: true });
});

test("取消未执行的调拨单释放全部预留；在途车批未闭环时禁止取消", () => {
  const { service, dir } = fresh();
  service.createTransfer({
    transferNo: "T1",
    destination: "HW",
    createdBy: "王仓管",
    lines: [{ batchNo: "B-W", quantity: 30 }],
  });
  const cancelled = service.cancelTransfer("T1", { actor: "王仓管" });
  assert.equal(cancelled.status, "cancelled");
  assert.equal(service.viewBatch("B-W").reserved, 0);
  assert.equal(service.viewBatch("B-W").available, 100);

  // 第二张单：装了车但未签收，不允许取消
  service.createTransfer({
    transferNo: "T2",
    destination: "HW",
    createdBy: "王仓管",
    lines: [{ batchNo: "B-T", quantity: 10 }],
  });
  service.loadShipment("T2", {
    actor: "王仓管",
    node: "省库",
    toNode: "汉旺",
    lines: [{ batchNo: "B-T", quantity: 10 }],
  });
  assert.throws(() => service.cancelTransfer("T2", { actor: "王仓管" }), ConflictError);
  rmSync(dir, { recursive: true, force: true });
});

test("部分发运后取消只释放未发数量的预留", () => {
  const { service, dir } = fresh();
  service.createTransfer({
    transferNo: "T1",
    destination: "HW",
    createdBy: "王仓管",
    lines: [{ batchNo: "B-W", quantity: 40 }],
  });
  const loaded = service.loadShipment("T1", {
    actor: "王仓管",
    node: "省库",
    toNode: "汉旺",
    lines: [{ batchNo: "B-W", quantity: 20 }],
  });
  service.signShipment("T1", loaded.shipment.shipmentNo, {
    actor: "张接收",
    node: "汉旺",
    certNo: service.viewTransfer("T1").shipments[0].chainTipCertNo,
    quantities: { "B-W": 20 },
  });
  const cancelled = service.cancelTransfer("T1", { actor: "王仓管" });
  assert.equal(cancelled.status, "cancelled");
  assert.equal(service.viewBatch("B-W").reserved, 0);
  assert.equal(service.viewBatch("B-W").onHand, 80);
  rmSync(dir, { recursive: true, force: true });
});

test("建单后批次过期：调整与装车都被拒绝", () => {
  const { service, dir } = fresh();
  service.createTransfer({
    transferNo: "T1",
    destination: "HW",
    createdBy: "赵药师",
    lines: [{ batchNo: "B-M", quantity: 10 }],
  });
  // 模拟保质期走到（测试不注入时钟，直接把批次日期改到过去）
  service.state.batches["B-M"].expiryDate = "2000-01-01";
  assert.throws(
    () =>
      service.loadShipment("T1", {
        actor: "赵药师",
        node: "省库",
        toNode: "汉旺",
        lines: [{ batchNo: "B-M", quantity: 10 }],
      }),
    /已过保质期/,
  );
  assert.throws(
    () => service.adjustTransfer("T1", { lines: [{ batchNo: "B-M", quantity: 20 }] }),
    /已过保质期/,
  );
  rmSync(dir, { recursive: true, force: true });
});

test("目的地汇总按批次聚合申请、在途、签收、核销与未发", () => {
  const { service, dir } = fresh();
  service.createTransfer({
    transferNo: "T1",
    destination: "HW",
    createdBy: "王仓管",
    lines: [{ batchNo: "B-W", quantity: 30 }],
  });
  const loaded = service.loadShipment("T1", {
    actor: "王仓管",
    node: "省库",
    toNode: "HW",
    lines: [{ batchNo: "B-W", quantity: 30 }],
  });
  service.signShipment("T1", loaded.shipment.shipmentNo, {
    actor: "张接收",
    node: "HW",
    certNo: loaded.departureCert.certNo,
    quantities: { "B-W": 25 },
  });
  service.createTransfer({
    transferNo: "T2",
    destination: "HW",
    createdBy: "王仓管",
    lines: [{ batchNo: "B-W", quantity: 10 }],
  });
  const summary = service.destinationSummary("HW");
  const row = summary.find((r) => r.batchNo === "B-W");
  assert.equal(row.requested, 40);
  assert.equal(row.shipped, 30);
  assert.equal(row.received, 25);
  assert.equal(row.writtenOff, 5);
  assert.equal(row.inTransit, 0);
  assert.equal(row.outstanding, 10);
  assert.deepEqual(row.transfers.sort(), ["T1", "T2"]);
  rmSync(dir, { recursive: true, force: true });
});

test("异常可手工登记并闭环，未决清单过滤生效", () => {
  const { service, dir } = fresh();
  const ex = service.recordException({
    batchNo: "B-M",
    kind: "damage",
    quantity: 2,
    reason: "库内发现包装破损",
    actor: "赵药师",
    node: "省库B",
  });
  assert.equal(service.listExceptions({ unresolvedOnly: true }).length, 1);
  const resolved = service.resolveException(ex.exceptionNo, { actor: "赵药师", resolution: "已隔离销毁" });
  assert.equal(resolved.resolved, true);
  assert.equal(service.listExceptions({ unresolvedOnly: true }).length, 0);
  rmSync(dir, { recursive: true, force: true });
});
