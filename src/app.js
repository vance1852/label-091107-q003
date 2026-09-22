import { createServer } from "node:http";
import { created, createRouter } from "./http.js";
import { createService } from "./service.js";

export async function createApp(options = {}) {
  const service = await createService({
    dataDir: options.dataDir ?? process.env.DATA_DIR ?? "data",
    now: options.now,
  });

  const route = createRouter([
    ["GET", /^\/health$/, () => ({ service: "relief-supply", status: "ok" })],

    // 批次库存
    ["POST", /^\/batches$/, async ({ body, service }) => created(await service.registerBatch(body))],
    ["GET", /^\/batches$/, ({ query, service }) =>
      service.listBatches({
        location: query.get("location") ?? undefined,
        materialType: query.get("materialType") ?? undefined,
        includeExpired: query.get("includeExpired") === "true",
      })],
    ["GET", /^\/batches\/(?<id>[^/]+)$/, ({ params, service }) => service.getBatch(params.id)],
    ["GET", /^\/batches\/(?<id>[^/]+)\/journey$/, ({ params, service }) => ({
      batchId: params.id,
      events: service.batchJourney(params.id),
    })],

    // 调拨单：建单、查询、调整未发数量、取消
    ["POST", /^\/transfer-orders$/, async ({ body, service }) => created(await service.createOrder(body))],
    ["GET", /^\/transfer-orders$/, ({ query, service }) =>
      service.listOrders({
        status: query.get("status") ?? undefined,
        destination: query.get("destination") ?? undefined,
      })],
    ["GET", /^\/transfer-orders\/(?<id>[^/]+)$/, ({ params, service }) => service.getOrder(params.id)],
    ["PATCH", /^\/transfer-orders\/(?<id>[^/]+)$/, async ({ params, body, service }) =>
      service.adjustOrder(params.id, body)],
    ["POST", /^\/transfer-orders\/(?<id>[^/]+)\/cancel$/, async ({ params, service }) =>
      service.cancelOrder(params.id)],
    ["GET", /^\/transfer-orders\/(?<id>[^/]+)\/journey$/, ({ params, service }) =>
      service.orderJourney(params.id)],

    // 发运：分批装车、途中交接、到站签收、异常退回、离线同步
    ["POST", /^\/transfer-orders\/(?<id>[^/]+)\/shipments$/, async ({ params, body, service }) =>
      created(await service.loadShipment(params.id, body))],
    ["GET", /^\/shipments$/, ({ query, service }) =>
      service.listShipments({
        orderId: query.get("orderId") ?? undefined,
        status: query.get("status") ?? undefined,
      })],
    ["GET", /^\/shipments\/(?<id>[^/]+)$/, ({ params, service }) => service.getShipment(params.id)],
    ["POST", /^\/shipments\/(?<id>[^/]+)\/handover$/, async ({ params, body, service }) =>
      service.handover(params.id, body)],
    ["POST", /^\/shipments\/(?<id>[^/]+)\/receive$/, async ({ params, body, service }) =>
      service.receive(params.id, body)],
    ["POST", /^\/shipments\/(?<id>[^/]+)\/return$/, async ({ params, body, service }) =>
      service.returnShipment(params.id, body)],
    ["POST", /^\/shipments\/(?<id>[^/]+)\/return-receive$/, async ({ params, body, service }) =>
      service.receiveReturn(params.id, body)],
    ["POST", /^\/shipments\/(?<id>[^/]+)\/offline-sync$/, async ({ params, body, service }) =>
      service.offlineSync(params.id, body)],

    // 报表：批次库存、目的地汇总、异常清单
    ["GET", /^\/reports\/inventory$/, ({ service }) => service.inventoryReport()],
    ["GET", /^\/reports\/destinations$/, ({ service }) => service.destinationReport()],
    ["GET", /^\/reports\/exceptions$/, ({ query, service }) =>
      service.exceptionsReport({
        withinDays: query.get("withinDays") ? Number(query.get("withinDays")) : 7,
      })],
  ]);

  const app = createServer((request, response) => route(request, response, service));
  app.service = service;
  return app;
}
