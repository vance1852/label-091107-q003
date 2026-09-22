import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ConflictError, ReliefService, ValidationError } from "../src/service.js";

function setup(quantity = 20) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "relief-offline-"));
  const service = new ReliefService(dir);
  service.registerBatch({
    batchNo: "B1",
    category: "tent",
    name: "棉帐篷",
    quantity: 100,
    expiryDate: "2099-12-31",
    location: "省级库",
    owner: "王仓管",
  });
  service.createTransfer({
    transferNo: "T1",
    destination: "HW",
    destinationName: "汉旺",
    createdBy: "王仓管",
    lines: [{ batchNo: "B1", quantity }],
  });
  const loaded = service.loadShipment("T1", {
    actor: "王仓管",
    node: "省库",
    toNode: "永安中转",
    vehicle: "川B-2",
    lines: [{ batchNo: "B1", quantity }],
  });
  return {
    service,
    dir,
    shipmentNo: loaded.shipment.shipmentNo,
    departureCert: loaded.departureCert.certNo,
  };
}

test("离线整批：多条带序号记录用设备端凭证号衔接，一次提交全部接受", () => {
  const { service, dir, shipmentNo, departureCert } = setup();
  const result = service.syncOfflineHandoffs({
    transferNo: "T1",
    shipmentNo,
    deviceId: "device-7",
    records: [
      {
        seq: 1,
        clientCertNo: "DEV-CERT-1",
        type: "relay",
        fromNode: "永安中转",
        toNode: "洛水点",
        actor: "李司机",
        prevCertNo: departureCert,
        at: "2026-09-20T08:00:00Z",
      },
      {
        seq: 2,
        clientCertNo: "DEV-CERT-2",
        type: "relay",
        fromNode: "洛水点",
        toNode: "汉旺",
        actor: "周押运",
        prevCertNo: "DEV-CERT-1",
        at: "2026-09-20T12:00:00Z",
      },
    ],
  });
  assert.equal(result.accepted.length, 2);
  // 服务器为每张设备凭证分配了正式凭证号，并保留双向可对账
  const [h1, h2] = result.accepted;
  assert.equal(h1.clientCertNo, "DEV-CERT-1");
  assert.equal(h2.prevCertNo, h1.certNo);
  assert.equal(result.shipment.chainTipCertNo, h2.certNo);
  assert.equal(result.shipment.expectedNode, "汉旺");
  rmSync(dir, { recursive: true, force: true });
});

test("离线整批：可衔接记录接受、冲突版本整批拒绝且责任链不受污染", () => {
  const ctx = setup();
  const cert1 = ctx.service
    .recordHandoff({
      transferNo: "T1",
      shipmentNo: ctx.shipmentNo,
      type: "relay",
      fromNode: "永安中转",
      toNode: "洛水点",
      actor: "在线车组",
      prevCertNo: ctx.departureCert,
    })
    .certNo;

  // 现场设备基于旧版本（departureCert）分叉出 seq1，整批拒绝
  assert.throws(
    () =>
      ctx.service.syncOfflineHandoffs({
        transferNo: "T1",
        shipmentNo: ctx.shipmentNo,
        deviceId: "device-7",
        records: [
          {
            seq: 1,
            clientCertNo: "FORK-1",
            type: "relay",
            fromNode: "永安中转",
            toNode: "另一条路点",
            actor: "李司机",
            prevCertNo: ctx.departureCert,
          },
          {
            seq: 2,
            clientCertNo: "FORK-2",
            type: "relay",
            fromNode: "另一条路点",
            toNode: "汉旺",
            actor: "李司机",
            prevCertNo: "FORK-1",
          },
        ],
      }),
    /版本分叉/,
  );

  // 责任链末端未变，原有链路继续可用
  const shipment = ctx.service.viewTransfer("T1").shipments[0];
  assert.equal(shipment.chainTipCertNo, cert1);
  assert.equal(shipment.status, "in_transit");
  assert.equal(Object.keys(ctx.service.state.handoffs).length, 2); // 发车 + 在线中继

  // 设备以正确基础凭证重发整批，被接受
  const ok = ctx.service.syncOfflineHandoffs({
    transferNo: "T1",
    shipmentNo: ctx.shipmentNo,
    deviceId: "device-7",
    records: [
      {
        seq: 1,
        clientCertNo: "DEV-CERT-A",
        type: "relay",
        fromNode: "洛水点",
        toNode: "汉旺",
        actor: "李司机",
        prevCertNo: cert1,
      },
    ],
  });
  assert.equal(ok.accepted[0].prevCertNo, cert1);
  rmSync(ctx.dir, { recursive: true, force: true });
});

test("离线批次原子性：中间一条节点不符，全部不落盘", () => {
  const { service, dir, shipmentNo, departureCert } = setup();
  assert.throws(
    () =>
      service.syncOfflineHandoffs({
        transferNo: "T1",
        shipmentNo,
        records: [
          { seq: 1, clientCertNo: "X1", type: "relay", fromNode: "永安中转", toNode: "洛水点", actor: "李司机", prevCertNo: departureCert },
          { seq: 2, clientCertNo: "X2", type: "relay", fromNode: "错误节点", toNode: "汉旺", actor: "李司机", prevCertNo: "X1" },
        ],
      }),
    /应当由/,
  );
  const shipment = service.viewTransfer("T1").shipments[0];
  assert.equal(shipment.chainTipCertNo, departureCert);
  assert.equal(shipment.expectedNode, "永安中转");
  // 失败批次的设备凭证号可以在重试中再次使用
  assert.doesNotThrow(() =>
    service.syncOfflineHandoffs({
      transferNo: "T1",
      shipmentNo,
      records: [
        { seq: 1, clientCertNo: "X1", type: "relay", fromNode: "永安中转", toNode: "洛水点", actor: "李司机", prevCertNo: departureCert },
      ],
    }),
  );
  rmSync(dir, { recursive: true, force: true });
});

test("离线重传同一批记录按 recordId 幂等去重", () => {
  const { service, dir, shipmentNo, departureCert } = setup();
  const payload = {
    transferNo: "T1",
    shipmentNo,
    deviceId: "device-7",
    records: [
      {
        seq: 1,
        clientCertNo: "DEV-CERT-1",
        type: "relay",
        fromNode: "永安中转",
        toNode: "洛水点",
        actor: "李司机",
        prevCertNo: departureCert,
      },
    ],
  };
  const first = service.syncOfflineHandoffs(payload);
  assert.equal(first.accepted.length, 1);
  // 网络恢复后客户端重试同一批：拒绝重复
  assert.throws(() => service.syncOfflineHandoffs(payload), /已处理/);
  // 换 seq 但复用同一设备凭证号同样拒绝
  assert.throws(
    () =>
      service.syncOfflineHandoffs({
        transferNo: "T1",
        shipmentNo,
        records: [
          {
            seq: 2,
            clientCertNo: "DEV-CERT-1",
            type: "relay",
            fromNode: "洛水点",
            toNode: "汉旺",
            actor: "李司机",
            prevCertNo: first.accepted[0].certNo,
          },
        ],
      }),
    ConflictError,
  );
  const shipment = service.viewTransfer("T1").shipments[0];
  assert.equal(shipment.chainTipCertNo, first.accepted[0].certNo);
  rmSync(dir, { recursive: true, force: true });
});

test("缺少序号或序号重复的离线批次被拒绝", () => {
  const { service, dir, shipmentNo, departureCert } = setup();
  assert.throws(
    () =>
      service.syncOfflineHandoffs({
        transferNo: "T1",
        shipmentNo,
        records: [{ type: "relay", fromNode: "永安中转", toNode: "汉旺", actor: "李司机", prevCertNo: departureCert }],
      }),
    ValidationError,
  );
  assert.throws(
    () =>
      service.syncOfflineHandoffs({
        transferNo: "T1",
        shipmentNo,
        records: [
          { seq: 1, clientCertNo: "Y1", type: "relay", fromNode: "永安中转", toNode: "洛水点", actor: "李司机", prevCertNo: departureCert },
          { seq: 1, clientCertNo: "Y2", type: "relay", fromNode: "洛水点", toNode: "汉旺", actor: "李司机", prevCertNo: "Y1" },
        ],
      }),
    /序号 1 重复/,
  );
  rmSync(dir, { recursive: true, force: true });
});

test("离线到站记录同时完成签收并核对数量、登记短缺异常", () => {
  const { service, dir, shipmentNo, departureCert } = setup(30);
  const result = service.syncOfflineHandoffs({
    transferNo: "T1",
    shipmentNo,
    deviceId: "device-9",
    records: [
      { seq: 1, clientCertNo: "D9-1", type: "relay", fromNode: "永安中转", toNode: "洛水点", actor: "李司机", prevCertNo: departureCert },
      {
        seq: 2,
        clientCertNo: "D9-2",
        type: "arrival",
        fromNode: "洛水点",
        toNode: "汉旺",
        actor: "张接收",
        prevCertNo: "D9-1",
        quantities: { B1: 28 },
        exceptions: [{ batchNo: "B1", reason: "刮破 2 顶" }],
      },
    ],
  });
  assert.equal(result.shipment.status, "signed");
  const t = service.viewTransfer("T1");
  assert.equal(t.lines[0].received, 28);
  assert.equal(t.lines[0].writtenOff, 2);
  assert.equal(service.listExceptions()[0].kind, "shortage");
  // 闭合后同批追加记录不可能；新请求也无法继续交接
  assert.throws(
    () =>
      service.syncOfflineHandoffs({
        transferNo: "T1",
        shipmentNo,
        records: [
          { seq: 1, type: "relay", fromNode: "汉旺", toNode: "别处", actor: "张接收", prevCertNo: "D9-2" },
        ],
      }),
    ConflictError,
  );
  rmSync(dir, { recursive: true, force: true });
});

test("离线退回闭环：发起退回与到站确认可同批到达", () => {
  const { service, dir, shipmentNo, departureCert } = setup(10);
  const result = service.syncOfflineHandoffs({
    transferNo: "T1",
    shipmentNo,
    deviceId: "device-3",
    records: [
      { seq: 1, clientCertNo: "R1", type: "return", fromNode: "永安中转", toNode: "省库", actor: "李司机", note: "道路中断", prevCertNo: departureCert },
      {
        seq: 2,
        clientCertNo: "R2",
        type: "return_received",
        fromNode: "永安中转",
        toNode: "省库",
        actor: "王仓管",
        prevCertNo: "R1",
        quantities: { B1: 10 },
      },
    ],
  });
  assert.equal(result.shipment.status, "returned");
  assert.equal(service.viewBatch("B1").onHand, 100);
  assert.equal(service.viewTransfer("T1").status, "returned");
  rmSync(dir, { recursive: true, force: true });
});

test("离线退回中数量非法时整批不落盘", () => {
  const { service, dir, shipmentNo, departureCert } = setup(10);
  assert.throws(
    () =>
      service.syncOfflineHandoffs({
        transferNo: "T1",
        shipmentNo,
        records: [
          { seq: 1, clientCertNo: "Q1", type: "return", fromNode: "永安中转", toNode: "省库", actor: "李司机", note: "退回", prevCertNo: departureCert },
          {
            seq: 2,
            clientCertNo: "Q2",
            type: "return_received",
            fromNode: "永安中转",
            toNode: "省库",
            actor: "王仓管",
            prevCertNo: "Q1",
            quantities: { B1: 11 }, // 超过装车 10
          },
        ],
      }),
    /超过装车数量/,
  );
  const shipment = service.viewTransfer("T1").shipments[0];
  assert.equal(shipment.status, "in_transit");
  assert.equal(service.listExceptions().length, 0);
  rmSync(dir, { recursive: true, force: true });
});
