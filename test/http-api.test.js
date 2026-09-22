import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createApp } from "../src/http.js";
import { ReliefService } from "../src/service.js";

function startServer() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "relief-http-"));
  const service = new ReliefService(dir);
  const app = createApp(() => service);
  return new Promise((resolve) => {
    app.listen(0, () => {
      const base = `http://127.0.0.1:${app.address().port}`;
      resolve({
        base,
        dir,
        stop: () =>
          new Promise((res) => {
            service.close();
            app.close(res);
          }),
      });
    });
  });
}

async function jsonFetch(base, method, route, body) {
  const response = await fetch(`${base}${route}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  const parsed = text ? JSON.parse(text) : null;
  return { status: response.status, body: parsed };
}

test("端到端：登记、建单、装车、中继、签收、短缺异常、查询汇总", async () => {
  const server = await startServer();
  try {
    const register = await jsonFetch(server.base, "POST", "/batches", {
      batchNo: "B-MED-1",
      category: "medicine",
      name: "抗生素",
      quantity: 40,
      expiryDate: "2099-06-30",
      location: "省库冷库 2 排",
      owner: "赵药师",
    });
    assert.equal(register.status, 201);

    const create = await jsonFetch(server.base, "POST", "/transfers", {
      transferNo: "TR-001",
      destination: "HW",
      destinationName: "汉旺安置点",
      createdBy: "赵药师",
      lines: [{ batchNo: "B-MED-1", quantity: 30 }],
    });
    assert.equal(create.status, 201);
    assert.equal(create.body.status, "created");

    const load = await jsonFetch(server.base, "POST", "/transfers/TR-001/shipments", {
      actor: "赵药师",
      node: "省库",
      toNode: "绵阳中转",
      vehicle: "川A-9",
      lines: [{ batchNo: "B-MED-1", quantity: 30 }],
    });
    assert.equal(load.status, 201);
    const shipmentNo = load.body.shipment.shipmentNo;
    const departureCert = load.body.departureCert.certNo;

    const relay = await jsonFetch(
      server.base,
      "POST",
      `/transfers/TR-001/shipments/${shipmentNo}/handoffs`,
      {
        type: "relay",
        fromNode: "绵阳中转",
        toNode: "汉旺安置点",
        actor: "李司机",
        prevCertNo: departureCert,
      },
    );
    assert.equal(relay.status, 201);

    // 旧凭证签收 → 409
    const badSign = await jsonFetch(
      server.base,
      "POST",
      `/transfers/TR-001/shipments/${shipmentNo}/sign`,
      {
        actor: "张接收",
        node: "汉旺安置点",
        certNo: departureCert,
        quantities: { "B-MED-1": 30 },
      },
    );
    assert.equal(badSign.status, 409);
    assert.equal(badSign.body.code, "CONFLICT");

    const sign = await jsonFetch(
      server.base,
      "POST",
      `/transfers/TR-001/shipments/${shipmentNo}/sign`,
      {
        actor: "张接收",
        node: "汉旺安置点",
        certNo: relay.body.certNo,
        quantities: { "B-MED-1": 27 },
        exceptions: [{ batchNo: "B-MED-1", reason: "挤压破损 3 盒" }],
      },
    );
    assert.equal(sign.status, 200);
    assert.equal(sign.body.shipment.status, "signed");

    const exceptions = await jsonFetch(server.base, "GET", "/exceptions?unresolvedOnly=true");
    assert.equal(exceptions.body.length, 1);
    assert.equal(exceptions.body[0].quantity, 3);

    const summary = await jsonFetch(server.base, "GET", "/destinations/HW/summary");
    assert.equal(summary.body[0].received, 27);
    assert.equal(summary.body[0].writtenOff, 3);
    assert.equal(summary.body[0].outstanding, 0);

    const journey = await jsonFetch(server.base, "GET", "/transfers/TR-001/journey");
    const kinds = journey.body.timeline.map((e) => e.kind);
    assert.deepEqual(kinds, [
      "loaded",
      "handoff:departure",
      "handoff:relay",
      "handoff:arrival",
      "signed",
    ]);

    const batch = await jsonFetch(server.base, "GET", "/batches/B-MED-1");
    assert.equal(batch.body.onHand, 10);
    assert.equal(batch.body.reserved, 0);
  } finally {
    await server.stop();
    rmSync(server.dir, { recursive: true, force: true });
  }
});

test("端到端：过期分配拒绝、参数错误返回 400、不存在返回 404", async () => {
  const server = await startServer();
  try {
    await jsonFetch(server.base, "POST", "/batches", {
      batchNo: "OLD",
      category: "medicine",
      name: "过期药",
      quantity: 5,
      expiryDate: "2000-01-01",
      location: "省库",
      owner: "赵药师",
    });
    const res = await jsonFetch(server.base, "POST", "/transfers", {
      transferNo: "TR-X",
      destination: "HW",
      createdBy: "赵药师",
      lines: [{ batchNo: "OLD", quantity: 1 }],
    });
    assert.equal(res.status, 400);

    const badJson = await fetch(`${server.base}/batches`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not-json",
    });
    assert.equal(badJson.status, 400);

    const missing = await jsonFetch(server.base, "GET", "/batches/NOPE");
    assert.equal(missing.status, 404);

    const unknownRoute = await jsonFetch(server.base, "GET", "/nope");
    assert.equal(unknownRoute.status, 404);
  } finally {
    await server.stop();
    rmSync(server.dir, { recursive: true, force: true });
  }
});

test("端到端：离线批次冲突 409 后重发正确版本成功", async () => {
  const server = await startServer();
  try {
    await jsonFetch(server.base, "POST", "/batches", {
      batchNo: "B1",
      category: "tent",
      name: "帐篷",
      quantity: 10,
      expiryDate: "2099-01-01",
      location: "省库",
      owner: "王仓管",
    });
    await jsonFetch(server.base, "POST", "/transfers", {
      transferNo: "TR-1",
      destination: "HW",
      createdBy: "王仓管",
      lines: [{ batchNo: "B1", quantity: 10 }],
    });
    const load = await jsonFetch(server.base, "POST", "/transfers/TR-1/shipments", {
      actor: "王仓管",
      node: "省库",
      toNode: "永安",
      lines: [{ batchNo: "B1", quantity: 10 }],
    });
    const shipmentNo = load.body.shipment.shipmentNo;
    const departureCert = load.body.departureCert.certNo;

    const conflicting = await jsonFetch(
      server.base,
      "POST",
      `/transfers/TR-1/shipments/${shipmentNo}/offline-handoffs`,
      {
        deviceId: "dev-1",
        records: [
          { seq: 1, clientCertNo: "F1", type: "relay", fromNode: "错误起点", toNode: "X", actor: "李司机", prevCertNo: departureCert },
        ],
      },
    );
    assert.equal(conflicting.status, 409);

    const ok = await jsonFetch(
      server.base,
      "POST",
      `/transfers/TR-1/shipments/${shipmentNo}/offline-handoffs`,
      {
        deviceId: "dev-1",
        records: [
          { seq: 1, clientCertNo: "F1", type: "relay", fromNode: "永安", toNode: "汉旺", actor: "李司机", prevCertNo: departureCert },
          {
            seq: 2,
            clientCertNo: "F2",
            type: "arrival",
            fromNode: "汉旺",
            toNode: "汉旺",
            actor: "张接收",
            prevCertNo: "F1",
            quantities: { B1: 10 },
          },
        ],
      },
    );
    assert.equal(ok.status, 201);
    assert.equal(ok.body.shipment.status, "signed");
  } finally {
    await server.stop();
    rmSync(server.dir, { recursive: true, force: true });
  }
});
