import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ConflictError, ReliefService, ValidationError } from "../src/service.js";

function setup() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "relief-chain-"));
  const service = new ReliefService(dir);
  service.registerBatch({
    batchNo: "B1",
    category: "medicine",
    name: "急救药品箱",
    quantity: 50,
    expiryDate: "2099-12-31",
    location: "省级库冷库",
    owner: "赵药师",
  });
  service.createTransfer({
    transferNo: "T1",
    destination: "HW",
    destinationName: "汉旺前进点",
    createdBy: "赵药师",
    lines: [{ batchNo: "B1", quantity: 20 }],
  });
  const loaded = service.loadShipment("T1", {
    actor: "赵药师",
    node: "省库",
    toNode: "绵阳中转站",
    vehicle: "川A-110",
    lines: [{ batchNo: "B1", quantity: 20 }],
  });
  return {
    service,
    dir,
    shipmentNo: loaded.shipment.shipmentNo,
    departureCert: loaded.departureCert.certNo,
  };
}

test("下一节点必须持前一节点凭证才能接货；旧凭证/伪造凭证被拒", () => {
  const { service, dir, shipmentNo } = setup();
  // 没有凭证
  assert.throws(
    () =>
      service.recordHandoff({
        transferNo: "T1",
        shipmentNo,
        type: "relay",
        fromNode: "绵阳中转站",
        toNode: "汉旺前进点",
        actor: "李司机",
      }),
    ValidationError,
  );
  // 伪造凭证
  assert.throws(
    () =>
      service.recordHandoff({
        transferNo: "T1",
        shipmentNo,
        type: "relay",
        fromNode: "绵阳中转站",
        toNode: "汉旺前进点",
        actor: "李司机",
        prevCertNo: "CERT-FAKE",
      }),
    ConflictError,
  );
  // 交出方不是凭证指向的责任节点
  const departureCert = service.state.transfers.T1.shipments[0].handoffs[0].certNo;
  assert.throws(
    () =>
      service.recordHandoff({
        transferNo: "T1",
        shipmentNo,
        type: "relay",
        fromNode: "别的站点",
        toNode: "汉旺前进点",
        actor: "李司机",
        prevCertNo: departureCert,
      }),
    /应当由/,
  );
  rmSync(dir, { recursive: true, force: true });
});

test("凭证责任链可多段衔接，签收后状态闭环", () => {
  const ctx = setup();
  const { service, dir, shipmentNo } = ctx;
  const cert0 = ctx.departureCert;
  const h1 = service.recordHandoff({
    transferNo: "T1",
    shipmentNo,
    type: "relay",
    fromNode: "绵阳中转站",
    toNode: "洛水转运点",
    actor: "李司机",
    prevCertNo: cert0,
  });
  const h2 = service.recordHandoff({
    transferNo: "T1",
    shipmentNo,
    type: "relay",
    fromNode: "洛水转运点",
    toNode: "汉旺前进点",
    actor: "周押运",
    prevCertNo: h1.certNo,
  });
  // 拿已过期的 h1 凭证不能签收
  assert.throws(
    () =>
      service.signShipment("T1", shipmentNo, {
        actor: "张接收",
        node: "汉旺前进点",
        certNo: h1.certNo,
        quantities: { B1: 20 },
      }),
    ConflictError,
  );
  const signed = service.signShipment("T1", shipmentNo, {
    actor: "张接收",
    node: "汉旺前进点",
    certNo: h2.certNo,
    quantities: { B1: 20 },
  });
  assert.equal(signed.shipment.status, "signed");
  assert.equal(signed.arrivalCert.prevCertNo, h2.certNo);
  assert.equal(service.viewTransfer("T1").status, "completed");
  // 签收后不能再交接
  assert.throws(
    () =>
      service.recordHandoff({
        transferNo: "T1",
        shipmentNo,
        type: "relay",
        fromNode: "汉旺前进点",
        toNode: "X",
        actor: "张接收",
        prevCertNo: signed.arrivalCert.certNo,
      }),
    ConflictError,
  );
  rmSync(dir, { recursive: true, force: true });
});

test("签收短缺自动登记异常并核销未退回数量", () => {
  const { service, dir, shipmentNo, departureCert } = setup();
  const h1 = service.recordHandoff({
    transferNo: "T1",
    shipmentNo,
    type: "relay",
    fromNode: "绵阳中转站",
    toNode: "汉旺前进点",
    actor: "李司机",
    prevCertNo: departureCert,
  });
  const result = service.signShipment("T1", shipmentNo, {
    actor: "张接收",
    node: "汉旺前进点",
    certNo: h1.certNo,
    quantities: { B1: 17 },
    exceptions: [{ batchNo: "B1", reason: "道路颠簸破损 3 件" }],
  });
  assert.equal(result.exceptions[0].kind, "shortage");
  assert.equal(result.exceptions[0].quantity, 3);
  const t = service.viewTransfer("T1");
  assert.equal(t.status, "partially_completed");
  const line = t.lines[0];
  assert.equal(line.received, 17);
  assert.equal(line.writtenOff, 3);
  rmSync(dir, { recursive: true, force: true });
});

test("异常退回：发起、途中、到站确认并重新入库", () => {
  const { service, dir, shipmentNo, departureCert } = setup();
  // 到了绵阳发现道路中断，整批退回省库
  const ret = service.startReturn("T1", shipmentNo, {
    actor: "李司机",
    fromNode: "绵阳中转站",
    toNode: "省库",
    reason: "前方塌方道路中断",
    certNo: departureCert,
  });
  assert.equal(ret.shipment.status, "returning");
  assert.equal(service.listExceptions({ unresolvedOnly: true }).length, 1);
  // 在途正向凭证已失效，必须用退回链凭证
  assert.throws(
    () =>
      service.receiveReturn("T1", shipmentNo, {
        actor: "王仓管",
        node: "省库",
        certNo: departureCert,
        quantities: { B1: 20 },
      }),
    ConflictError,
  );
  const received = service.receiveReturn("T1", shipmentNo, {
    actor: "王仓管",
    node: "省库",
    certNo: ret.returnCert.certNo,
    quantities: { B1: 20 },
    restock: true,
  });
  assert.equal(received.shipment.status, "returned");
  const batch = service.viewBatch("B1");
  assert.equal(batch.onHand, 50);
  assert.equal(batch.reserved, 0);
  assert.equal(service.listExceptions({ unresolvedOnly: true }).length, 0);
  rmSync(dir, { recursive: true, force: true });
});

test("退回时已过期的物资不允许重新入库", () => {
  const { service, dir, shipmentNo, departureCert } = setup();
  const ret = service.startReturn("T1", shipmentNo, {
    actor: "李司机",
    fromNode: "绵阳中转站",
    toNode: "省库",
    reason: "质量存疑",
    certNo: departureCert,
  });
  // 把批次保质期改成过去（位置/责任人允许更新，这里直接构造过期事实）
  service.state.batches.B1.expiryDate = "2000-01-01";
  assert.throws(
    () =>
      service.receiveReturn("T1", shipmentNo, {
        actor: "王仓管",
        node: "省库",
        certNo: ret.returnCert.certNo,
        quantities: { B1: 20 },
        restock: true,
      }),
    /已过期/,
  );
  const done = service.receiveReturn("T1", shipmentNo, {
    actor: "王仓管",
    node: "省库",
    certNo: ret.returnCert.certNo,
    quantities: { B1: 20 },
    restock: false,
  });
  assert.equal(done.shipment.status, "returned");
  assert.equal(service.viewBatch("B1").onHand, 30); // 20 件不回库
  rmSync(dir, { recursive: true, force: true });
});

test("退回途中短缺登记异常", () => {
  const { service, dir, shipmentNo, departureCert } = setup();
  const ret = service.startReturn("T1", shipmentNo, {
    actor: "李司机",
    fromNode: "绵阳中转站",
    toNode: "省库",
    reason: "道路中断",
    certNo: departureCert,
  });
  const received = service.receiveReturn("T1", shipmentNo, {
    actor: "王仓管",
    node: "省库",
    certNo: ret.returnCert.certNo,
    quantities: { B1: 18 },
  });
  assert.equal(received.exceptions[0].kind, "return_shortage");
  assert.equal(received.exceptions[0].quantity, 2);
  assert.equal(service.viewBatch("B1").onHand, 48);
  rmSync(dir, { recursive: true, force: true });
});

test("旅程视图按时间还原装车、每段凭证、签收与退回", () => {
  const { service, dir, shipmentNo, departureCert } = setup();
  const h1 = service.recordHandoff({
    transferNo: "T1",
    shipmentNo,
    type: "relay",
    fromNode: "绵阳中转站",
    toNode: "汉旺前进点",
    actor: "李司机",
    prevCertNo: departureCert,
  });
  service.signShipment("T1", shipmentNo, {
    actor: "张接收",
    node: "汉旺前进点",
    certNo: h1.certNo,
    quantities: { B1: 20 },
  });
  const journey = service.journey("T1");
  const kinds = journey.timeline.map((e) => e.kind);
  assert.deepEqual(kinds, ["loaded", "handoff:departure", "handoff:relay", "handoff:arrival", "signed"]);
  // 凭证链可回溯到起点
  const arrival = journey.timeline.find((e) => e.kind === "handoff:arrival");
  assert.equal(arrival.prevCertNo, h1.certNo);
  rmSync(dir, { recursive: true, force: true });
});
