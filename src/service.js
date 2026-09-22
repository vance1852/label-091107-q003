import path from "node:path";
import {
  adjustOrder,
  applyEvent,
  batchView,
  cancelOrder,
  createOrder,
  createInitialState,
  destinationReport,
  exceptionsReport,
  getBatchOrThrow,
  getOrderOrThrow,
  getShipmentOrThrow,
  handover,
  loadShipment,
  offlineSync,
  orderJourney,
  receive,
  receiveReturn,
  registerBatch,
  returnShipment,
} from "./domain.js";
import { Journal } from "./journal.js";

/**
 * 服务层：所有写操作先落事件日志（fsync）再应用到内存状态，
 * 通过串行队列保证多请求并发时状态与日志严格一致。
 */
export async function createService({ dataDir, now = () => new Date() }) {
  const journal = new Journal(path.join(dataDir, "journal.jsonl"));
  const persisted = await journal.open();
  const state = createInitialState();
  const events = [];
  for (const event of persisted) {
    applyEvent(state, event);
    events.push(event);
  }

  let queue = Promise.resolve();
  async function transact(produceEvents) {
    const run = queue.then(async () => {
      const produced = produceEvents(state);
      const list = Array.isArray(produced) ? produced : produced.events;
      if (list.length > 0) {
        await journal.appendAll(list);
        for (const event of list) {
          applyEvent(state, event);
          events.push(event);
        }
      }
      return produced;
    });
    queue = run.catch(() => {});
    return run;
  }

  const nowMs = () => now().getTime();
  const at = () => now().toISOString();

  return {
    // --- 写操作 ---
    registerBatch: (input) =>
      transact((s) => registerBatch(s, input, at())).then(([event]) => event.batch),
    createOrder: (input) =>
      transact((s) => createOrder(s, input, at(), nowMs())).then(([event]) => event.order),
    adjustOrder: (orderId, input) =>
      transact((s) => adjustOrder(s, orderId, input, at(), nowMs())).then(
        () => getOrderOrThrow(state, orderId),
      ),
    cancelOrder: (orderId) =>
      transact((s) => cancelOrder(s, orderId, at())).then(() => getOrderOrThrow(state, orderId)),
    loadShipment: (orderId, input) =>
      transact((s) => loadShipment(s, orderId, input, at())).then(([event]) => event.shipment),
    handover: (shipmentId, input) =>
      transact((s) => handover(s, shipmentId, input, at())).then(() =>
        getShipmentOrThrow(state, shipmentId),
      ),
    receive: (shipmentId, input) =>
      transact((s) => receive(s, shipmentId, input, at())).then(() =>
        getShipmentOrThrow(state, shipmentId),
      ),
    returnShipment: (shipmentId, input) =>
      transact((s) => returnShipment(s, shipmentId, input, at())).then(() =>
        getShipmentOrThrow(state, shipmentId),
      ),
    receiveReturn: (shipmentId, input) =>
      transact((s) => receiveReturn(s, shipmentId, input, at())).then(() =>
        getShipmentOrThrow(state, shipmentId),
      ),
    offlineSync: (shipmentId, input) =>
      transact((s) => offlineSync(s, shipmentId, input, at())).then((outcome) => outcome.result),

    // --- 读操作 ---
    listBatches: ({ location, materialType, includeExpired } = {}) => {
      const rows = [];
      for (const batch of state.batches.values()) {
        if (location && !(location in batch.holdings)) continue;
        if (materialType && batch.materialType !== materialType) continue;
        const view = batchView(state, batch, nowMs());
        if (!includeExpired && view.expired) continue;
        rows.push(view);
      }
      return rows;
    },
    getBatch: (batchId) => batchView(state, getBatchOrThrow(state, batchId), nowMs()),
    listOrders: ({ status, destination } = {}) =>
      [...state.orders.values()].filter(
        (order) =>
          (!status || order.status === status) && (!destination || order.destination === destination),
      ),
    getOrder: (orderId) => getOrderOrThrow(state, orderId),
    listShipments: ({ orderId, status } = {}) =>
      [...state.shipments.values()].filter(
        (shipment) =>
          (!orderId || shipment.orderId === orderId) && (!status || shipment.status === status),
      ),
    getShipment: (shipmentId) => getShipmentOrThrow(state, shipmentId),
    inventoryReport: () =>
      [...state.batches.values()].map((batch) => batchView(state, batch, nowMs())),
    destinationReport: () => destinationReport(state),
    exceptionsReport: ({ withinDays = 7 } = {}) => exceptionsReport(state, nowMs(), withinDays),
    orderJourney: (orderId) => orderJourney(state, orderId, events),
    batchJourney: (batchId) => {
      getBatchOrThrow(state, batchId);
      return events.filter((event) => JSON.stringify(event).includes(batchId));
    },

    close: () => journal.close(),
  };
}
