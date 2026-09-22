import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ConflictError, ReliefService, ValidationError } from "../src/service.js";

function freshService() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "relief-"));
  const service = new ReliefService(dir);
  service.tmpDir = dir;
  return service;
}

test.afterEach(() => {
  // 服务实例随测试结束自然关闭，目录惰性清理
});

function seedWater(service, overrides = {}) {
  return service.registerBatch({
    batchNo: "B-WATER-1",
    category: "water",
    name: "瓶装饮用水",
    quantity: 100,
    expiryDate: "2099-12-31",
    location: "省级库 A-01",
    owner: "王仓管",
    ...overrides,
  });
}

test("批次登记保留保质期、位置、责任人与可用量", () => {
  const service = freshService();
  const batch = seedWater(service);
  assert.equal(batch.onHand, 100);
  assert.equal(batch.reserved, 0);
  assert.equal(batch.available, 100);
  assert.equal(batch.expired, false);
  assert.equal(batch.location, "省级库 A-01");
  assert.equal(batch.owner, "王仓管");
  rmSync(service.tmpDir, { recursive: true, force: true });
});

test("过期批次不能登记用于新调拨，临期判断按保质期时刻", () => {
  const service = freshService();
  seedWater(service, { batchNo: "B-OLD", expiryDate: "2000-01-01" });
  const batch = service.viewBatch("B-OLD");
  assert.equal(batch.expired, true);
  assert.throws(
    () =>
      service.createTransfer({
        transferNo: "T1",
        destination: "D1",
        createdBy: "王仓管",
        lines: [{ batchNo: "B-OLD", quantity: 1 }],
      }),
    /已过保质期/,
  );
  rmSync(service.tmpDir, { recursive: true, force: true });
});

test("库存不足时不能分配，建单后库存转为占用", () => {
  const service = freshService();
  seedWater(service);
  assert.throws(
    () =>
      service.createTransfer({
        transferNo: "T1",
        destination: "D1",
        createdBy: "王仓管",
        lines: [{ batchNo: "B-WATER-1", quantity: 101 }],
      }),
    ConflictError,
  );
  service.createTransfer({
    transferNo: "T1",
    destination: "D1",
    createdBy: "王仓管",
    lines: [{ batchNo: "B-WATER-1", quantity: 40 }],
  });
  const batch = service.viewBatch("B-WATER-1");
  assert.equal(batch.reserved, 40);
  assert.equal(batch.available, 60);
  // 再来一张单只能用剩余可分配量
  assert.throws(
    () =>
      service.createTransfer({
        transferNo: "T2",
        destination: "D2",
        createdBy: "王仓管",
        lines: [{ batchNo: "B-WATER-1", quantity: 61 }],
      }),
    /数量不足/,
  );
  rmSync(service.tmpDir, { recursive: true, force: true });
});

test("部分发运之后只能调增/调减未发数量，不能低于已净发出", () => {
  const service = freshService();
  seedWater(service);
  service.createTransfer({
    transferNo: "T1",
    destination: "D1",
    createdBy: "王仓管",
    lines: [{ batchNo: "B-WATER-1", quantity: 40 }],
  });
  const loaded = service.loadShipment("T1", {
    actor: "王仓管",
    node: "省库",
    toNode: "D1",
    lines: [{ batchNo: "B-WATER-1", quantity: 25 }],
  });
  // 已发 25，试图调到 20：拒绝
  assert.throws(
    () => service.adjustTransfer("T1", { lines: [{ batchNo: "B-WATER-1", quantity: 20 }] }),
    /已净发运/,
  );
  // 调到 60：可以（25 已发 + 35 未发，库存剩 60 可占用）
  const updated = service.adjustTransfer("T1", {
    lines: [{ batchNo: "B-WATER-1", quantity: 60 }],
  });
  const line = updated.lines.find((l) => l.batchNo === "B-WATER-1");
  assert.equal(line.quantity, 60);
  assert.equal(line.outstanding, 35);
  assert.equal(service.viewBatch("B-WATER-1").reserved, 35);
  // 装车不能超过未发数量
  assert.throws(
    () =>
      service.loadShipment("T1", {
        actor: "王仓管",
        node: "省库",
        toNode: "D1",
        lines: [{ batchNo: "B-WATER-1", quantity: 36 }],
      }),
    /超过未发数量/,
  );
  assert.ok(loaded.shipment.shipmentNo);
  rmSync(service.tmpDir, { recursive: true, force: true });
});

test("分批装车：不能重复发出超过未发额度的数量，车批序号递增", () => {
  const service = freshService();
  seedWater(service);
  service.createTransfer({
    transferNo: "T1",
    destination: "D1",
    createdBy: "王仓管",
    lines: [{ batchNo: "B-WATER-1", quantity: 100 }],
  });
  service.loadShipment("T1", {
    actor: "王仓管",
    node: "省库",
    toNode: "D1",
    lines: [{ batchNo: "B-WATER-1", quantity: 60 }],
  });
  // 第二车只能装未发的 40 件；多发 1 件即被拒
  assert.throws(
    () =>
      service.loadShipment("T1", {
        actor: "王仓管",
        node: "省库",
        toNode: "D1",
        lines: [{ batchNo: "B-WATER-1", quantity: 41 }],
      }),
    /超过未发数量/,
  );
  const second = service.loadShipment("T1", {
    actor: "王仓管",
    node: "省库",
    toNode: "D1",
    lines: [{ batchNo: "B-WATER-1", quantity: 40 }],
  });
  assert.equal(second.shipment.shipmentNo, "T1-S02");
  // 全部发完后实物与占用都清零
  const batch = service.viewBatch("B-WATER-1");
  assert.equal(batch.onHand, 0);
  assert.equal(batch.reserved, 0);
  rmSync(service.tmpDir, { recursive: true, force: true });
});

test("批次号、调拨单号唯一性与基础字段校验", () => {
  const service = freshService();
  seedWater(service);
  assert.throws(() => seedWater(service), ConflictError);
  assert.throws(
    () =>
      service.registerBatch({
        batchNo: "BX",
        category: "medicine",
        name: "急救包",
        quantity: 0,
        expiryDate: "2099-01-01",
        location: "省库",
        owner: "赵药师",
      }),
    ValidationError,
  );
  rmSync(service.tmpDir, { recursive: true, force: true });
});
