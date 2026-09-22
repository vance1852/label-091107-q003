import { badRequest, conflict, notFound } from "./errors.js";
import {
  optionalBoolean,
  optionalIsoTimestamp,
  optionalString,
  requireArray,
  requireIsoTimestamp,
  requireNonNegativeInt,
  requireObject,
  requirePositiveInt,
  requireString,
} from "./validate.js";

export const OFFLINE_TYPES = ["handover", "receive", "return", "return_receive"];

const ID_PREFIX = {
  batch: "B",
  order: "T",
  shipment: "S",
  voucher: "V",
  exception: "X",
};

export function createInitialState() {
  return {
    batches: new Map(), // batchId -> 批次（含各位置 holdings）
    orders: new Map(), // orderId -> 调拨单
    shipments: new Map(), // shipmentId -> 发运单（含 custody 责任链）
    vouchers: new Map(), // voucher -> { shipmentId, seq } 凭证全局唯一
    exceptions: [], // 已记录的异常（退回、冲突、报废）
    counters: { batch: 0, order: 0, shipment: 0, voucher: 0, exception: 0 },
  };
}

function nextId(state, kind) {
  state.counters[kind] += 1;
  return `${ID_PREFIX[kind]}-${String(state.counters[kind]).padStart(6, "0")}`;
}

function bumpCounter(state, kind, id) {
  const match = new RegExp(`^${ID_PREFIX[kind]}-(\\d+)$`).exec(id);
  if (match) state.counters[kind] = Math.max(state.counters[kind], Number(match[1]));
}

export function isExpired(batch, nowMs) {
  return batch.expiryDate !== null && Date.parse(batch.expiryDate) <= nowMs;
}

function getHolding(batch, location) {
  return batch.holdings[location] ?? null;
}

function creditHolding(batch, location, keeper, quantity) {
  const holding = (batch.holdings[location] ??= { onHand: 0, reserved: 0, keeper });
  holding.onHand += quantity;
  if (keeper) holding.keeper = keeper;
}

// ---------------------------------------------------------------------------
// 事件重放：所有状态变更的唯一入口，启动恢复与运行时共用同一套逻辑。
// ---------------------------------------------------------------------------

export function applyEvent(state, event) {
  switch (event.type) {
    case "batch_registered": {
      const batch = structuredClone(event.batch);
      state.batches.set(batch.id, batch);
      bumpCounter(state, "batch", batch.id);
      break;
    }
    case "order_created": {
      const order = structuredClone(event.order);
      state.orders.set(order.id, order);
      bumpCounter(state, "order", order.id);
      for (const line of order.lines) {
        for (const alloc of line.allocations) {
          getHolding(state.batches.get(alloc.batchId), order.origin).reserved += alloc.quantity;
        }
      }
      break;
    }
    case "order_adjusted": {
      const order = state.orders.get(event.orderId);
      for (const change of event.changes) {
        const line = order.lines.find((item) => item.id === change.lineId);
        line.quantity = change.quantity;
        for (const { batchId, quantity } of change.released) {
          releaseFromAllocations(line, batchId, quantity);
          getHolding(state.batches.get(batchId), order.origin).reserved -= quantity;
        }
        for (const { batchId, quantity } of change.added) {
          mergeAllocation(line, batchId, quantity);
          getHolding(state.batches.get(batchId), order.origin).reserved += quantity;
        }
        line.allocations = line.allocations.filter((alloc) => alloc.quantity > 0);
      }
      break;
    }
    case "order_cancelled": {
      const order = state.orders.get(event.orderId);
      order.status = "closed";
      order.closedAt = event.at;
      for (const { lineId, batchId, quantity } of event.released) {
        const line = order.lines.find((item) => item.id === lineId);
        releaseFromAllocations(line, batchId, quantity);
        getHolding(state.batches.get(batchId), order.origin).reserved -= quantity;
        line.allocations = line.allocations.filter((alloc) => alloc.quantity > 0);
      }
      break;
    }
    case "shipment_loaded": {
      const shipment = structuredClone(event.shipment);
      state.shipments.set(shipment.id, shipment);
      bumpCounter(state, "shipment", shipment.id);
      const order = state.orders.get(shipment.orderId);
      for (const line of shipment.lines) {
        const orderLine = order.lines.find((item) => item.id === line.lineId);
        orderLine.shippedQuantity += line.quantity;
        consumeAllocation(orderLine, line.batchId, line.quantity);
        const batch = state.batches.get(line.batchId);
        const holding = getHolding(batch, shipment.origin);
        holding.onHand -= line.quantity;
        holding.reserved -= line.quantity;
      }
      for (const line of order.lines) {
        line.allocations = line.allocations.filter((alloc) => alloc.quantity > 0);
      }
      order.status = deriveOrderStatus(order);
      registerCustodyVouchers(state, shipment);
      break;
    }
    case "custody_appended": {
      const shipment = state.shipments.get(event.shipmentId);
      for (const entry of event.entries) {
        shipment.custody.push(entry);
        applyCustodyEffect(state, shipment, entry);
      }
      shipment.status = event.status;
      registerCustodyVouchers(state, shipment);
      break;
    }
    case "exception_recorded": {
      state.exceptions.push(structuredClone(event.exception));
      bumpCounter(state, "exception", event.exception.id);
      break;
    }
    default:
      throw new Error(`未知事件类型：${event.type}`);
  }
}

function registerCustodyVouchers(state, shipment) {
  for (const entry of shipment.custody) {
    if (!state.vouchers.has(entry.voucher)) {
      state.vouchers.set(entry.voucher, { shipmentId: shipment.id, seq: entry.seq });
      bumpCounter(state, "voucher", entry.voucher);
    }
  }
}

function mergeAllocation(line, batchId, quantity) {
  const existing = line.allocations.find((alloc) => alloc.batchId === batchId);
  if (existing) existing.quantity += quantity;
  else line.allocations.push({ batchId, quantity, shipped: 0 });
}

function releaseFromAllocations(line, batchId, quantity) {
  let remaining = quantity;
  for (let index = line.allocations.length - 1; index >= 0 && remaining > 0; index -= 1) {
    const alloc = line.allocations[index];
    if (alloc.batchId !== batchId) continue;
    const take = Math.min(alloc.quantity - alloc.shipped, remaining);
    alloc.quantity -= take;
    remaining -= take;
  }
}

function consumeAllocation(line, batchId, quantity) {
  let remaining = quantity;
  for (const alloc of line.allocations) {
    if (alloc.batchId !== batchId || remaining === 0) continue;
    const take = Math.min(alloc.quantity - alloc.shipped, remaining);
    alloc.shipped += take;
    remaining -= take;
  }
}

function deriveOrderStatus(order) {
  if (order.status === "closed") return "closed";
  const fulfilled = order.lines.every((line) => line.shippedQuantity === line.quantity);
  if (fulfilled) return "fulfilled";
  return order.lines.some((line) => line.shippedQuantity > 0) ? "shipping" : "open";
}

function deriveShipmentStatus(shipment) {
  const last = shipment.custody[shipment.custody.length - 1];
  if (last.type === "receive") return "delivered";
  if (last.type === "return") return "returning";
  if (last.type === "return_receive") return "returned";
  return "in_transit";
}

function applyCustodyEffect(state, shipment, entry) {
  if (entry.type === "receive") {
    for (const line of shipment.lines) {
      creditHolding(state.batches.get(line.batchId), entry.node, entry.toKeeper, line.quantity);
    }
  } else if (entry.type === "return_receive" && entry.restock) {
    for (const line of shipment.lines) {
      creditHolding(state.batches.get(line.batchId), entry.node, entry.toKeeper, line.quantity);
    }
  }
}

// ---------------------------------------------------------------------------
// 查询辅助
// ---------------------------------------------------------------------------

export function getBatchOrThrow(state, batchId) {
  const batch = state.batches.get(batchId);
  if (!batch) throw notFound(`批次 ${batchId} 不存在`);
  return batch;
}

export function getOrderOrThrow(state, orderId) {
  const order = state.orders.get(orderId);
  if (!order) throw notFound(`调拨单 ${orderId} 不存在`);
  return order;
}

export function getShipmentOrThrow(state, shipmentId) {
  const shipment = state.shipments.get(shipmentId);
  if (!shipment) throw notFound(`发运单 ${shipmentId} 不存在`);
  return shipment;
}

function availableOf(batch, location) {
  const holding = getHolding(batch, location);
  return holding ? holding.onHand - holding.reserved : 0;
}

/**
 * 按 FEFO（先到期先出）分配批次：已过期批次不参与分配，
 * 无保质期的物资（如帐篷）排在最后。库存不足时抛 409。
 * pendingReserve 记录同一请求内已承诺但尚未落账的数量，防止重复分配。
 */
function allocate(state, { materialType, location, quantity, nowMs, preferredBatchId = null, pendingReserve = null }) {
  const candidates = [];
  for (const batch of state.batches.values()) {
    if (batch.materialType !== materialType) continue;
    if (preferredBatchId !== null && batch.id !== preferredBatchId) continue;
    if (isExpired(batch, nowMs)) continue;
    const pending = pendingReserve?.get(`${batch.id}|${location}`) ?? 0;
    const available = availableOf(batch, location) - pending;
    if (available > 0) candidates.push({ batch, available });
  }
  candidates.sort((a, b) => {
    const expiryA = a.batch.expiryDate ?? "9999-12-31T23:59:59.999Z";
    const expiryB = b.batch.expiryDate ?? "9999-12-31T23:59:59.999Z";
    if (expiryA !== expiryB) return expiryA < expiryB ? -1 : 1;
    return a.batch.id < b.batch.id ? -1 : 1;
  });

  const allocations = [];
  let remaining = quantity;
  for (const { batch, available } of candidates) {
    if (remaining === 0) break;
    const take = Math.min(available, remaining);
    allocations.push({ batchId: batch.id, quantity: take });
    remaining -= take;
  }
  if (remaining > 0) {
    if (preferredBatchId !== null) {
      const batch = state.batches.get(preferredBatchId);
      if (!batch) throw notFound(`批次 ${preferredBatchId} 不存在`);
      if (isExpired(batch, nowMs)) {
        throw conflict(`批次 ${preferredBatchId} 已过保质期，不能分配`);
      }
    }
    throw conflict(
      `物资「${materialType}」在 ${location} 的可用库存不足：缺口 ${remaining} 个最小单位`,
    );
  }
  return allocations;
}

function notePending(pendingReserve, location, allocations) {
  for (const { batchId, quantity } of allocations) {
    const key = `${batchId}|${location}`;
    pendingReserve.set(key, (pendingReserve.get(key) ?? 0) + quantity);
  }
}

// ---------------------------------------------------------------------------
// 业务操作：校验当前状态并返回待持久化的事件，不直接改状态。
// ---------------------------------------------------------------------------

export function registerBatch(state, input, at) {
  const body = requireObject(input, "请求体");
  const materialType = requireString(body, "materialType");
  const quantity = requirePositiveInt(body, "quantity");
  const location = requireString(body, "location");
  const keeper = requireString(body, "keeper");
  const expiryDate = optionalIsoTimestamp(body, "expiryDate");

  const batch = {
    id: nextId(state, "batch"),
    materialType,
    expiryDate,
    location,
    keeper,
    createdAt: at,
    holdings: { [location]: { onHand: quantity, reserved: 0, keeper } },
  };
  return [{ type: "batch_registered", at, batch }];
}

export function createOrder(state, input, at, nowMs) {
  const body = requireObject(input, "请求体");
  const origin = requireString(body, "origin");
  const destination = requireString(body, "destination");
  const createdBy = requireString(body, "createdBy");
  const lineInputs = requireArray(body, "lines");
  if (origin === destination) throw badRequest("起点与目的地不能相同");

  const pendingReserve = new Map();
  const lines = lineInputs.map((lineInput, index) => {
    const line = requireObject(lineInput, `lines[${index}]`);
    const materialType = requireString(line, "materialType");
    const quantity = requirePositiveInt(line, "quantity");
    const preferredBatchId = optionalString(line, "batchId");
    const allocations = allocate(state, {
      materialType,
      location: origin,
      quantity,
      nowMs,
      preferredBatchId,
      pendingReserve,
    });
    notePending(pendingReserve, origin, allocations);
    return {
      id: `L${index + 1}`,
      materialType,
      quantity,
      shippedQuantity: 0,
      allocations: allocations.map((alloc) => ({ ...alloc, shipped: 0 })),
    };
  });

  const order = {
    id: nextId(state, "order"),
    origin,
    destination,
    createdBy,
    createdAt: at,
    closedAt: null,
    status: "open",
    lines,
  };
  return [{ type: "order_created", at, order }];
}

export function adjustOrder(state, orderId, input, at, nowMs) {
  const order = getOrderOrThrow(state, orderId);
  if (order.status !== "open" && order.status !== "shipping") {
    throw conflict(`调拨单 ${orderId} 已${order.status === "fulfilled" ? "全部发运" : "关闭"}，不能再调整`);
  }
  const body = requireObject(input, "请求体");
  const changeInputs = requireArray(body, "lines");

  const seen = new Set();
  const pendingReserve = new Map();
  const changes = changeInputs.map((changeInput, index) => {
    const change = requireObject(changeInput, `lines[${index}]`);
    const lineId = requireString(change, "lineId");
    if (seen.has(lineId)) throw badRequest(`明细 ${lineId} 在一次调整中重复出现`);
    seen.add(lineId);
    const quantity = requireNonNegativeInt(change, "quantity");
    const line = order.lines.find((item) => item.id === lineId);
    if (!line) throw notFound(`调拨单 ${orderId} 没有明细行 ${lineId}`);
    // 部分发运之后只允许调整未发数量：新数量不得小于已发数量。
    if (quantity < line.shippedQuantity) {
      throw conflict(
        `明细 ${lineId} 已发运 ${line.shippedQuantity}，新数量 ${quantity} 小于已发数量，不允许调整`,
      );
    }
    const delta = quantity - line.quantity;
    const released = [];
    const added = [];
    if (delta < 0) {
      released.push(...planRelease(line, -delta));
    } else if (delta > 0) {
      added.push(
        ...allocate(state, {
          materialType: line.materialType,
          location: order.origin,
          quantity: delta,
          nowMs,
          pendingReserve,
        }),
      );
      notePending(pendingReserve, order.origin, added);
    }
    return { lineId, quantity, released, added };
  });

  return [{ type: "order_adjusted", at, orderId, changes }];
}

function planRelease(line, amount) {
  const released = [];
  let remaining = amount;
  const unshippedTotal = line.allocations.reduce(
    (sum, alloc) => sum + (alloc.quantity - alloc.shipped),
    0,
  );
  if (unshippedTotal < amount) {
    throw conflict(`明细 ${line.id} 的未发数量不足，无法释放 ${amount}`);
  }
  for (let index = line.allocations.length - 1; index >= 0 && remaining > 0; index -= 1) {
    const alloc = line.allocations[index];
    const unshipped = alloc.quantity - alloc.shipped;
    if (unshipped <= 0) continue;
    const take = Math.min(unshipped, remaining);
    released.push({ batchId: alloc.batchId, quantity: take });
    remaining -= take;
  }
  return released;
}

export function cancelOrder(state, orderId, at) {
  const order = getOrderOrThrow(state, orderId);
  if (order.status !== "open" && order.status !== "shipping") {
    throw conflict(`调拨单 ${orderId} 已${order.status === "fulfilled" ? "全部发运" : "关闭"}，不能取消`);
  }
  const released = [];
  for (const line of order.lines) {
    for (const alloc of line.allocations) {
      const unshipped = alloc.quantity - alloc.shipped;
      if (unshipped > 0) {
        released.push({ lineId: line.id, batchId: alloc.batchId, quantity: unshipped });
      }
    }
  }
  return [{ type: "order_cancelled", at, orderId, released }];
}

export function loadShipment(state, orderId, input, at) {
  const order = getOrderOrThrow(state, orderId);
  if (order.status !== "open" && order.status !== "shipping") {
    throw conflict(`调拨单 ${orderId} 当前状态为 ${order.status}，不能装车发运`);
  }
  const body = requireObject(input, "请求体");
  const carrier = requireString(body, "carrier");
  const note = optionalString(body, "note");
  const lineInputs = requireArray(body, "lines");

  // 同一明细行在一次装车中出现多次时先合并，再统一校验未发数量
  const requested = new Map();
  for (const [index, lineInput] of lineInputs.entries()) {
    const item = requireObject(lineInput, `lines[${index}]`);
    const lineId = requireString(item, "lineId");
    const quantity = requirePositiveInt(item, "quantity");
    requested.set(lineId, (requested.get(lineId) ?? 0) + quantity);
  }

  const lines = [];
  for (const [lineId, quantity] of requested) {
    const orderLine = order.lines.find((line) => line.id === lineId);
    if (!orderLine) throw notFound(`调拨单 ${orderId} 没有明细行 ${lineId}`);
    const unshipped = orderLine.allocations.reduce(
      (sum, alloc) => sum + (alloc.quantity - alloc.shipped),
      0,
    );
    if (quantity > unshipped) {
      throw conflict(`明细 ${lineId} 未发数量 ${unshipped}，本次装车 ${quantity} 超出可发范围`);
    }
    // 按分配顺序（FEFO）消耗到具体批次
    let remaining = quantity;
    for (const alloc of orderLine.allocations) {
      if (remaining === 0) break;
      const take = Math.min(alloc.quantity - alloc.shipped, remaining);
      if (take > 0) {
        lines.push({
          lineId,
          materialType: orderLine.materialType,
          batchId: alloc.batchId,
          quantity: take,
        });
        remaining -= take;
      }
    }
  }

  const loader = optionalString(body, "loadedBy") ?? order.createdBy;
  const firstEntry = {
    seq: 1,
    type: "load",
    voucher: nextId(state, "voucher"),
    previousVoucher: null,
    fromKeeper: loader,
    toKeeper: carrier,
    node: order.origin,
    at,
    note,
    restock: null,
  };
  const shipment = {
    id: nextId(state, "shipment"),
    orderId: order.id,
    origin: order.origin,
    destination: order.destination,
    carrier,
    status: "in_transit",
    createdAt: at,
    lines,
    custody: [firstEntry],
  };
  return [{ type: "shipment_loaded", at, shipment }];
}

function requireCurrentVoucher(shipment, voucher) {
  const head = shipment.custody[shipment.custody.length - 1];
  if (voucher !== head.voucher) {
    throw conflict(
      `凭证不匹配：当前责任链顶端凭证为 ${head.voucher}，下一节点必须持该凭证接货`,
    );
  }
  return head;
}

function appendCustody(state, shipmentId, input, at, expectedStatus, type) {
  const shipment = getShipmentOrThrow(state, shipmentId);
  if (shipment.status !== expectedStatus) {
    throw conflict(`发运单 ${shipmentId} 当前状态为 ${shipment.status}，不能执行 ${type}`);
  }
  const body = requireObject(input, "请求体");
  const voucher = requireString(body, "voucher");
  const head = requireCurrentVoucher(shipment, voucher);
  const note = optionalString(body, "note");

  const entry = {
    seq: head.seq + 1,
    type,
    voucher: nextId(state, "voucher"),
    previousVoucher: head.voucher,
    fromKeeper: head.toKeeper,
    toKeeper: null,
    node: null,
    at,
    note,
    restock: null,
  };

  if (type === "handover") {
    entry.toKeeper = requireString(body, "toKeeper");
    entry.node = requireString(body, "node");
  } else if (type === "receive") {
    entry.toKeeper = requireString(body, "toKeeper");
    entry.node = requireString(body, "node");
    if (entry.node !== shipment.destination) {
      throw conflict(`签收节点 ${entry.node} 不是目的地 ${shipment.destination}，不能到站签收`);
    }
  } else if (type === "return") {
    entry.node = head.node;
    entry.toKeeper = head.toKeeper; // 退回途中责任仍在承运人
    entry.note = requireString(body, "reason");
  } else if (type === "return_receive") {
    entry.toKeeper = requireString(body, "toKeeper");
    entry.node = requireString(body, "node");
    if (entry.node !== shipment.origin) {
      throw conflict(`退回接收节点 ${entry.node} 不是起点 ${shipment.origin}`);
    }
    entry.restock = optionalBoolean(body, "restock", true);
  }

  const events = [
    {
      type: "custody_appended",
      at,
      shipmentId,
      entries: [entry],
      status: deriveShipmentStatus({ custody: [...shipment.custody, entry] }),
    },
  ];
  if (type === "return") {
    events.push(recordException(state, at, {
      type: "shipment_returned",
      refType: "shipment",
      refId: shipmentId,
      message: `发运单 ${shipmentId} 异常退回：${entry.note}`,
      detail: { reason: entry.note, lines: shipment.lines },
    }));
  }
  if (type === "return_receive" && !entry.restock) {
    events.push(recordException(state, at, {
      type: "written_off",
      refType: "shipment",
      refId: shipmentId,
      message: `发运单 ${shipmentId} 退回物资报废，未重新入库`,
      detail: { lines: shipment.lines },
    }));
  }
  return events;
}

function recordException(state, at, exception) {
  return {
    type: "exception_recorded",
    at,
    exception: { id: nextId(state, "exception"), at, ...exception },
  };
}

export const handover = (state, shipmentId, input, at) =>
  appendCustody(state, shipmentId, input, at, "in_transit", "handover");
export const receive = (state, shipmentId, input, at) =>
  appendCustody(state, shipmentId, input, at, "in_transit", "receive");
export const returnShipment = (state, shipmentId, input, at) =>
  appendCustody(state, shipmentId, input, at, "in_transit", "return");
export const receiveReturn = (state, shipmentId, input, at) =>
  appendCustody(state, shipmentId, input, at, "returning", "return_receive");

// ---------------------------------------------------------------------------
// 离线交接同步：一次提交多条带序号的记录，接受可衔接的、跳过重复的、
// 拒绝冲突与断链的，责任链始终沿已确认的链条继续。
// ---------------------------------------------------------------------------

function sameCustodyEntry(record, entry) {
  return (
    record.type === entry.type &&
    record.voucher === entry.voucher &&
    record.previousVoucher === entry.previousVoucher &&
    record.toKeeper === entry.toKeeper &&
    record.node === entry.node
  );
}

function validateOfflineRecord(raw, index) {
  const record = requireObject(raw, `records[${index}]`);
  const seq = record.seq;
  if (!Number.isInteger(seq) || seq < 1) {
    throw badRequest(`records[${index}].seq 必须是正整数序号`);
  }
  const type = requireString(record, "type");
  if (!OFFLINE_TYPES.includes(type)) {
    throw badRequest(`records[${index}].type 必须是 ${OFFLINE_TYPES.join("/")} 之一`);
  }
  const entry = {
    seq,
    type,
    voucher: requireString(record, "voucher"),
    previousVoucher: record.previousVoucher == null ? null : requireString(record, "previousVoucher"),
    fromKeeper: optionalString(record, "fromKeeper"),
    toKeeper: requireString(record, "toKeeper"),
    node: requireString(record, "node"),
    at: requireIsoTimestamp(record, "at"),
    note: optionalString(record, "note"),
    restock: type === "return_receive" ? optionalBoolean(record, "restock", true) : null,
  };
  if (type === "return" && !entry.note) {
    throw badRequest(`records[${index}] 为退回记录，必须填写 note 说明原因`);
  }
  return entry;
}

export function offlineSync(state, shipmentId, input, at) {
  const shipment = getShipmentOrThrow(state, shipmentId);
  if (shipment.status === "delivered" || shipment.status === "returned") {
    throw conflict(`发运单 ${shipmentId} 已终结（${shipment.status}），不能再同步离线交接`);
  }
  const body = requireObject(input, "请求体");
  const recordInputs = requireArray(body, "records");
  const records = recordInputs
    .map((raw, index) => validateOfflineRecord(raw, index))
    .sort((a, b) => a.seq - b.seq);

  // 在内存副本上试跑整条链，只有确认可衔接的记录才会进入事件。
  const custody = shipment.custody.map((entry) => ({ ...entry }));
  const applied = [];
  const duplicates = [];
  const rejected = [];
  const exceptionEvents = [];

  for (const record of records) {
    const head = custody[custody.length - 1];
    if (record.seq <= head.seq) {
      const existing = custody[record.seq - 1];
      if (existing && sameCustodyEntry(record, existing)) {
        duplicates.push({ seq: record.seq, voucher: record.voucher });
      } else {
        rejected.push({ seq: record.seq, voucher: record.voucher, reason: "conflict" });
        exceptionEvents.push(recordException(state, at, {
          type: "offline_conflict",
          refType: "shipment",
          refId: shipmentId,
          message: `发运单 ${shipmentId} 序号 ${record.seq} 出现冲突版本，已拒绝并保留原责任链`,
          detail: { record, existing: existing ?? null },
        }));
      }
      continue;
    }
    if (record.seq !== head.seq + 1 || record.previousVoucher !== head.voucher) {
      rejected.push({ seq: record.seq, voucher: record.voucher, reason: "disconnected" });
      continue;
    }
    if (state.vouchers.has(record.voucher) || custody.some((entry) => entry.voucher === record.voucher)) {
      rejected.push({ seq: record.seq, voucher: record.voucher, reason: "voucher_reused" });
      continue;
    }
    const statusAfter = deriveShipmentStatus({ custody: [...custody, record] });
    const currentStatus = deriveShipmentStatus({ custody });
    const allowed =
      (currentStatus === "in_transit" && ["handover", "receive", "return"].includes(record.type)) ||
      (currentStatus === "returning" && record.type === "return_receive");
    if (!allowed) {
      rejected.push({ seq: record.seq, voucher: record.voucher, reason: "not_allowed" });
      continue;
    }
    if (record.type === "receive" && record.node !== shipment.destination) {
      rejected.push({ seq: record.seq, voucher: record.voucher, reason: "wrong_destination" });
      continue;
    }
    if (record.type === "return_receive" && record.node !== shipment.origin) {
      rejected.push({ seq: record.seq, voucher: record.voucher, reason: "wrong_origin" });
      continue;
    }
    custody.push({ ...record, fromKeeper: record.fromKeeper ?? head.toKeeper });
    applied.push({ seq: record.seq, voucher: record.voucher, status: statusAfter });
  }

  const events = [];
  if (applied.length > 0) {
    const appliedEntries = custody.slice(shipment.custody.length);
    events.push({
      type: "custody_appended",
      at,
      shipmentId,
      entries: appliedEntries,
      status: deriveShipmentStatus({ custody }),
    });
    // 离线补录的退回/报废与在线操作一样进入异常清单
    for (const entry of appliedEntries) {
      if (entry.type === "return") {
        exceptionEvents.unshift(recordException(state, at, {
          type: "shipment_returned",
          refType: "shipment",
          refId: shipmentId,
          message: `发运单 ${shipmentId} 异常退回（离线补录）：${entry.note}`,
          detail: { reason: entry.note, lines: shipment.lines },
        }));
      } else if (entry.type === "return_receive" && !entry.restock) {
        exceptionEvents.unshift(recordException(state, at, {
          type: "written_off",
          refType: "shipment",
          refId: shipmentId,
          message: `发运单 ${shipmentId} 退回物资报废，未重新入库（离线补录）`,
          detail: { lines: shipment.lines },
        }));
      }
    }
  }
  events.push(...exceptionEvents);
  return {
    events,
    result: {
      shipmentId,
      applied,
      duplicates,
      rejected,
      head: custody[custody.length - 1].voucher,
      status: deriveShipmentStatus({ custody }),
    },
  };
}

// ---------------------------------------------------------------------------
// 报表：批次库存、目的地汇总、异常清单、整段旅程还原
// ---------------------------------------------------------------------------

export function batchView(state, batch, nowMs) {
  const locations = Object.entries(batch.holdings).map(([location, holding]) => ({
    location,
    keeper: holding.keeper,
    onHand: holding.onHand,
    reserved: holding.reserved,
    available: holding.onHand - holding.reserved,
  }));
  const inTransit = [];
  for (const shipment of state.shipments.values()) {
    if (shipment.status !== "in_transit" && shipment.status !== "returning") continue;
    for (const line of shipment.lines) {
      if (line.batchId === batch.id) {
        inTransit.push({ shipmentId: shipment.id, status: shipment.status, quantity: line.quantity });
      }
    }
  }
  return {
    id: batch.id,
    materialType: batch.materialType,
    expiryDate: batch.expiryDate,
    expired: isExpired(batch, nowMs),
    createdAt: batch.createdAt,
    locations,
    inTransit,
    totalOnHand: locations.reduce((sum, item) => sum + item.onHand, 0),
    totalReserved: locations.reduce((sum, item) => sum + item.reserved, 0),
  };
}

export function destinationReport(state) {
  const summary = new Map();
  const ensure = (destination) => {
    if (!summary.has(destination)) {
      summary.set(destination, {
        destination,
        orders: 0,
        planned: 0,
        shipped: 0,
        received: 0,
        inTransit: 0,
        returning: 0,
        returned: 0,
        pending: 0,
      });
    }
    return summary.get(destination);
  };
  for (const order of state.orders.values()) {
    const row = ensure(order.destination);
    row.orders += 1;
    for (const line of order.lines) {
      row.planned += line.quantity;
      row.shipped += line.shippedQuantity;
    }
  }
  for (const shipment of state.shipments.values()) {
    const row = ensure(shipment.destination);
    const total = shipment.lines.reduce((sum, line) => sum + line.quantity, 0);
    if (shipment.status === "delivered") row.received += total;
    else if (shipment.status === "in_transit") row.inTransit += total;
    else if (shipment.status === "returning") row.returning += total;
    else if (shipment.status === "returned") row.returned += total;
  }
  for (const row of summary.values()) {
    row.pending = row.shipped - row.received - row.returned - row.inTransit - row.returning;
  }
  return [...summary.values()].sort((a, b) => (a.destination < b.destination ? -1 : 1));
}

export function exceptionsReport(state, nowMs, withinDays) {
  const items = [];
  const horizon = nowMs + withinDays * 24 * 60 * 60 * 1000;
  for (const batch of state.batches.values()) {
    const remaining = Object.values(batch.holdings).reduce(
      (sum, holding) => sum + holding.onHand,
      0,
    );
    if (remaining <= 0 || batch.expiryDate === null) continue;
    const expiryMs = Date.parse(batch.expiryDate);
    const keepers = Object.entries(batch.holdings)
      .filter(([, holding]) => holding.onHand > 0)
      .map(([location, holding]) => ({ location, keeper: holding.keeper, onHand: holding.onHand }));
    if (expiryMs <= nowMs) {
      items.push({
        type: "expired_stock",
        batchId: batch.id,
        materialType: batch.materialType,
        expiryDate: batch.expiryDate,
        remaining,
        keepers,
        message: `批次 ${batch.id} 已过保质期，剩余 ${remaining} 个最小单位`,
      });
    } else if (expiryMs <= horizon) {
      items.push({
        type: "near_expiry",
        batchId: batch.id,
        materialType: batch.materialType,
        expiryDate: batch.expiryDate,
        remaining,
        keepers,
        message: `批次 ${batch.id} 将于 ${batch.expiryDate} 到期，剩余 ${remaining} 个最小单位`,
      });
    }
  }
  for (const exception of state.exceptions) {
    items.push(exception);
  }
  return items;
}

export function orderJourney(state, orderId, events) {
  const order = getOrderOrThrow(state, orderId);
  const shipmentIds = new Set(
    [...state.shipments.values()].filter((s) => s.orderId === orderId).map((s) => s.id),
  );
  const timeline = events
    .filter((event) => {
      if (event.orderId === orderId || event.order?.id === orderId) return true;
      if (event.shipment?.orderId === orderId) return true;
      if (event.shipmentId && shipmentIds.has(event.shipmentId)) return true;
      if (event.exception?.refType === "shipment" && shipmentIds.has(event.exception.refId)) return true;
      return false;
    })
    .map((event) => ({ at: event.at, type: event.type, detail: summarizeEvent(event) }));
  const shipments = [...shipmentIds].map((id) => {
    const shipment = state.shipments.get(id);
    return {
      id: shipment.id,
      status: shipment.status,
      carrier: shipment.carrier,
      lines: shipment.lines,
      custody: shipment.custody,
    };
  });
  return { order, shipments, timeline };
}

function summarizeEvent(event) {
  switch (event.type) {
    case "batch_registered":
      return `登记批次 ${event.batch.id}（${event.batch.materialType}）`;
    case "order_created":
      return `创建调拨单 ${event.order.id}：${event.order.origin} → ${event.order.destination}`;
    case "order_adjusted":
      return `调整调拨单 ${event.orderId} 未发数量`;
    case "order_cancelled":
      return `关闭调拨单 ${event.orderId}，释放未发库存`;
    case "shipment_loaded":
      return `发运单 ${event.shipment.id} 装车出发，承运人 ${event.shipment.carrier}`;
    case "custody_appended":
      return `发运单 ${event.shipmentId} 责任链追加 ${event.entries.length} 条（至序号 ${event.entries[event.entries.length - 1].seq}）`;
    case "exception_recorded":
      return event.exception.message;
    default:
      return event.type;
  }
}
