import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { applyEvent, initialState } from "../src/domain.js";
import { Journal } from "../src/store.js";
import { ReliefService } from "../src/service.js";

function scenario(dir) {
  const service = new ReliefService(dir);
  service.registerBatch({
    batchNo: "B1",
    category: "water",
    name: "瓶装水",
    quantity: 100,
    expiryDate: "2099-01-01",
    location: "省库",
    owner: "王仓管",
  });
  service.createTransfer({
    transferNo: "T1",
    destination: "HW",
    createdBy: "王仓管",
    lines: [{ batchNo: "B1", quantity: 30 }],
  });
  const loaded = service.loadShipment("T1", {
    actor: "王仓管",
    node: "省库",
    toNode: "永安中转",
    lines: [{ batchNo: "B1", quantity: 20 }],
  });
  return { service, shipmentNo: loaded.shipment.shipmentNo, departureCert: loaded.departureCert.certNo };
}

test("重启后从日志回放，批次、占用、凭证链与异常全部还原", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "relief-restart-"));
  {
    const { service, shipmentNo, departureCert } = scenario(dir);
    service.recordHandoff({
      transferNo: "T1",
      shipmentNo,
      type: "relay",
      fromNode: "永安中转",
      toNode: "汉旺",
      actor: "李司机",
      prevCertNo: departureCert,
    });
    service.close();
  }
  {
    const service = new ReliefService(dir);
    const batch = service.viewBatch("B1");
    assert.equal(batch.onHand, 80);
    assert.equal(batch.available, 70);
    const shipment = service.viewTransfer("T1").shipments[0];
    assert.equal(shipment.status, "in_transit");
    assert.equal(shipment.expectedNode, "汉旺");
    // 凭证链仍可继续：末端凭证未丢
    const tip = shipment.chainTipCertNo;
    const signed = service.signShipment("T1", shipment.shipmentNo, {
      actor: "张接收",
      node: "汉旺",
      certNo: tip,
      quantities: { B1: 19 },
    });
    assert.equal(signed.shipment.status, "signed");
    assert.equal(service.listExceptions().length, 1);
    service.close();
  }
  {
    // 再重启一次，签收结果仍然存在
    const service = new ReliefService(dir);
    assert.equal(service.viewTransfer("T1").status, "partially_completed");
    assert.equal(service.viewBatch("B1").onHand, 80);
    service.close();
  }
  rmSync(dir, { recursive: true, force: true });
});

test("日志末尾的撕裂行在重启时被安全截断，已 fsync 的事件不丢失", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "relief-torn-"));
  const { service } = scenario(dir);
  service.close();
  const before = readFileSync(path.join(dir, "journal.log"), "utf8");
  const validLines = before.trim().split("\n").length;

  Journal.corruptTail(dir);
  const reopened = new ReliefService(dir);
  // 撕裂记录未生效
  assert.equal(reopened.state.seq, validLines);
  assert.equal(reopened.viewBatch("B1").onHand, 80);
  reopened.close();

  const after = readFileSync(path.join(dir, "journal.log"), "utf8");
  assert.equal(after.trim().split("\n").length, validLines);
  rmSync(dir, { recursive: true, force: true });
});

test("离线整批与多事件操作作为单次 fsync 原子落盘", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "relief-atomic-"));
  const { service, shipmentNo, departureCert } = scenario(dir);
  service.syncOfflineHandoffs({
    transferNo: "T1",
    shipmentNo,
    records: [
      { seq: 1, clientCertNo: "Z1", type: "relay", fromNode: "永安中转", toNode: "洛水点", actor: "李司机", prevCertNo: departureCert },
      { seq: 2, clientCertNo: "Z2", type: "relay", fromNode: "洛水点", toNode: "汉旺", actor: "周押运", prevCertNo: "Z1" },
    ],
  });
  service.close();

  const service2 = new ReliefService(dir);
  const shipment = service2.viewTransfer("T1").shipments[0];
  const certs = shipment.status === "in_transit";
  assert.ok(certs);
  assert.equal(shipment.expectedNode, "汉旺");
  // 两张中继凭证都完整
  assert.ok(service2.state.clientCertIndex["Z1"]);
  assert.ok(service2.state.clientCertIndex["Z2"]);
  service2.close();
  rmSync(dir, { recursive: true, force: true });
});

test("快照 + 日志回放得到与纯回放一致的状态", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "relief-snap-"));
  const { service, shipmentNo, departureCert } = scenario(dir);
  for (const [from, to] of [["永安中转", "洛水点"], ["洛水点", "八角点"], ["八角点", "汉旺"]]) {
    const tip = service.viewTransfer("T1").shipments[0].chainTipCertNo;
    service.recordHandoff({
      transferNo: "T1",
      shipmentNo,
      type: "relay",
      fromNode: from,
      toNode: to,
      actor: "李司机",
      prevCertNo: tip,
    });
  }
  service.close();
  // 手工生成一次快照（模拟运行期定期快照）
  Journal.writeSnapshotFile(dir, service.state);
  assert.ok(statSync(path.join(dir, "snapshot.json")).size > 0);

  // 另起一个只含相同日志、无快照的目录，做纯回放对照
  const dir2 = mkdtempSync(path.join(os.tmpdir(), "relief-nosnap-"));
  const journal1 = new Journal(dir, { snapshotEvery: 0 });
  const journal2 = new Journal(dir2, { snapshotEvery: 0 });
  copyFileSync(path.join(dir, "journal.log"), path.join(dir2, "journal.log"));
  const stateA = journal1.open(initialState, applyEvent);
  const stateB = journal2.open(initialState, applyEvent);
  assert.deepEqual(JSON.parse(JSON.stringify(stateA)), JSON.parse(JSON.stringify(stateB)));
  assert.equal(stateA.batches.B1.onHand, 80);
  assert.equal(stateA.transfers.T1.shipments[0].expectedNode, "汉旺");
  journal1.close();
  journal2.close();
  rmSync(dir, { recursive: true, force: true });
  rmSync(dir2, { recursive: true, force: true });
});

test("进程在交接中途退出（仅日志无内存）重启后责任链可继续", () => {
  // 用子进程模拟：写入一批离线记录后立即退出，再起新进程接续
  const dir = mkdtempSync(path.join(os.tmpdir(), "relief-proc-"));
  const script = `
    import { ReliefService } from "${path.resolve("src/service.js")}";
    const s = new ReliefService(${JSON.stringify(dir)});
    if (process.env.MODE === "seed") {
      s.registerBatch({ batchNo:"B1", category:"water", name:"水", quantity:50, expiryDate:"2099-01-01", location:"省库", owner:"王" });
      s.createTransfer({ transferNo:"T1", destination:"HW", createdBy:"王", lines:[{batchNo:"B1", quantity:10}] });
      const l = s.loadShipment("T1", { actor:"王", node:"省库", toNode:"永安", lines:[{batchNo:"B1", quantity:10}] });
      console.log(l.departureCert.certNo);
    } else {
      const cert = process.env.DEPARTURE_CERT;
      s.syncOfflineHandoffs({ transferNo:"T1", shipmentNo:"T1-S01", records:[
        { seq:1, clientCertNo:"P1", type:"relay", fromNode:"永安", toNode:"汉旺", actor:"李", prevCertNo:cert },
      ]});
    }
    s.close();
  `;
  const seed = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", script],
    { encoding: "utf8", env: { ...process.env, MODE: "seed" } },
  );
  assert.equal(seed.status, 0, seed.stderr);
  const departureCert = seed.stdout.trim();
  const sync = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", script],
    { encoding: "utf8", env: { ...process.env, DEPARTURE_CERT: departureCert } },
  );
  assert.equal(sync.status, 0, sync.stderr);

  const service = new ReliefService(dir);
  const shipment = service.viewTransfer("T1").shipments[0];
  assert.equal(shipment.expectedNode, "汉旺");
  const signed = service.signShipment("T1", "T1-S01", {
    actor: "张",
    node: "汉旺",
    certNo: shipment.chainTipCertNo,
    quantities: { B1: 10 },
  });
  assert.equal(signed.shipment.status, "signed");
  service.close();
  rmSync(dir, { recursive: true, force: true });
});
