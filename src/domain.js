// 领域模型：状态结构、事件归约、纯函数规则。
// 所有状态变更都以事件形式落盘，重放事件即可还原全部数据。

export const CATEGORIES = new Set(["water", "medicine", "tent", "food", "other"]);

export function initialState() {
  return {
    seq: 0,
    batches: {}, // batchNo -> 批次
    transfers: {}, // transferNo -> 调拨单
    handoffs: {}, // certNo -> 交接凭证记录
    exceptions: [], // 异常清单
    recordIndex: {}, // 离线 recordId -> certNo（幂等去重）
    clientCertIndex: {}, // 设备端凭证号 -> 服务器凭证号
  };
}

export function availableQuantity(batch) {
  return batch.onHand - batch.reserved;
}

export function netShipped(line) {
  return Math.max(0, line.shipped - line.returned);
}

// 保质期：YYYY-MM-DD 按东八区当日 23:59:59 到期；完整 ISO 字符串按时刻比较。
export function expiryInstant(raw) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return Date.parse(`${raw}T23:59:59.999+08:00`);
  }
  const t = Date.parse(raw);
  return Number.isNaN(t) ? NaN : t;
}

export function isExpired(batch, nowMs = Date.now()) {
  return expiryInstant(batch.expiryDate) < nowMs;
}

export function transferStatus(transfer) {
  if (transfer.cancelled) return "cancelled";
  if (transfer.shipments.length === 0) return "created";
  const terminal = transfer.shipments.filter((s) =>
    ["signed", "returned"].includes(s.status),
  );
  if (terminal.length < transfer.shipments.length) return "in_transit";
  const allReturned = transfer.shipments.every((s) => s.status === "returned");
  if (allReturned) return "returned";
  // 全部车批闭环后：存在未发余量或在途损耗，目的地未足额收货 → 部分完成
  const hasGap = transfer.lines.some((l) =>
    l.received < l.quantity ||
    Math.max(0, l.quantity - netShipped(l)) > 0 ||
    l.writtenOff > 0,
  );
  return hasGap ? "partially_completed" : "completed";
}

export function applyEvent(state, event) {
  const { type, payload } = event;
  switch (type) {
    case "BATCH_REGISTERED": {
      state.batches[payload.batchNo] = {
        ...payload,
        onHand: payload.quantity,
        reserved: 0,
      };
      return;
    }
    case "BATCH_UPDATED": {
      const batch = state.batches[payload.batchNo];
      if (payload.location !== undefined) batch.location = payload.location;
      if (payload.owner !== undefined) batch.owner = payload.owner;
      return;
    }
    case "TRANSFER_CREATED": {
      state.transfers[payload.transferNo] = {
        transferNo: payload.transferNo,
        destination: payload.destination,
        destinationName: payload.destinationName,
        note: payload.note ?? "",
        createdBy: payload.createdBy,
        createdAt: payload.at,
        cancelled: false,
        nextShipmentSeq: 1,
        lines: payload.lines.map((l) => ({
          batchNo: l.batchNo,
          quantity: l.quantity,
          shipped: 0,
          received: 0,
          returned: 0,
          writtenOff: 0,
        })),
        shipments: [],
      };
      for (const l of payload.lines) {
        state.batches[l.batchNo].reserved += l.quantity;
      }
      return;
    }
    case "TRANSFER_ADJUSTED": {
      const transfer = state.transfers[payload.transferNo];
      for (const change of payload.changes) {
        const line = transfer.lines.find((l) => l.batchNo === change.batchNo);
        const delta = change.quantity - line.quantity;
        line.quantity = change.quantity;
        state.batches[change.batchNo].reserved += delta;
      }
      return;
    }
    case "TRANSFER_CANCELLED": {
      const transfer = state.transfers[payload.transferNo];
      transfer.cancelled = true;
      transfer.cancelledAt = payload.at;
      for (const line of transfer.lines) {
        state.batches[line.batchNo].reserved -= line.quantity - netShipped(line);
      }
      return;
    }
    case "SHIPMENT_LOADED": {
      const transfer = state.transfers[payload.shipment.transferNo];
      transfer.shipments.push(payload.shipment);
      transfer.nextShipmentSeq += 1;
      for (const l of payload.shipment.lines) {
        const batch = state.batches[l.batchNo];
        batch.reserved -= l.quantity;
        batch.onHand -= l.quantity;
        const line = transfer.lines.find((x) => x.batchNo === l.batchNo);
        line.shipped += l.quantity;
      }
      return;
    }
    case "HANDOFF_RECORDED": {
      const h = payload;
      state.handoffs[h.certNo] = h;
      if (h.clientCertNo) state.clientCertIndex[h.clientCertNo] = h.certNo;
      if (h.recordId) state.recordIndex[h.recordId] = h.certNo;
      const transfer = state.transfers[h.transferNo];
      const shipment = transfer.shipments.find((s) => s.shipmentNo === h.shipmentNo);
      shipment.handoffs.push(h);
      if (h.type === "departure" || h.type === "relay") {
        shipment.chainTipCertNo = h.certNo;
        shipment.expectedNode = h.toNode;
        shipment.status = "in_transit";
      } else if (h.type === "return") {
        shipment.chainTipCertNo = h.certNo;
        shipment.expectedNode = h.toNode;
        shipment.status = "returning";
      } else {
        // arrival / return_received：责任链在此终止，凭证不再指向新节点
        shipment.terminalCertNo = h.certNo;
      }
      return;
    }
    case "SHIPMENT_SIGNED": {
      const transfer = state.transfers[payload.transferNo];
      const shipment = transfer.shipments.find((s) => s.shipmentNo === payload.shipmentNo);
      shipment.status = "signed";
      shipment.signedAt = payload.at;
      shipment.signedBy = payload.actor;
      shipment.signedNode = payload.node;
      shipment.signedQuantities = payload.quantities;
      shipment.writtenOffQuantities = payload.writtenOff ?? {};
      for (const l of shipment.lines) {
        const line = transfer.lines.find((x) => x.batchNo === l.batchNo);
        line.received += payload.quantities[l.batchNo] ?? 0;
        line.writtenOff += payload.writtenOff?.[l.batchNo] ?? 0;
      }
      for (const e of payload.exceptions ?? []) state.exceptions.push(e);
      return;
    }
    case "EXCEPTION_RECORDED": {
      state.exceptions.push(payload.exception);
      return;
    }
    case "EXCEPTION_RESOLVED": {
      const ex = state.exceptions.find((e) => e.exceptionNo === payload.exceptionNo);
      if (ex) {
        ex.resolved = true;
        ex.resolvedAt = payload.at;
        ex.resolution = payload.resolution ?? ex.resolution ?? null;
        ex.resolvedBy = payload.actor;
      }
      return;
    }
    case "RETURN_STARTED": {
      // 凭证记录由同批 HANDOFF_RECORDED 负责，这里只补充异常与原因
      const transfer = state.transfers[payload.transferNo];
      const shipment = transfer.shipments.find((s) => s.shipmentNo === payload.shipmentNo);
      shipment.returnReason = payload.reason;
      state.exceptions.push(payload.exception);
      return;
    }
    case "RETURN_RECEIVED": {
      const transfer = state.transfers[payload.transferNo];
      const shipment = transfer.shipments.find((s) => s.shipmentNo === payload.shipmentNo);
      shipment.status = "returned";
      shipment.returnedAt = payload.at;
      shipment.returnedBy = payload.actor;
      shipment.returnedNode = payload.node;
      shipment.returnedQuantities = payload.quantities;
      for (const [batchNo, qty] of Object.entries(payload.quantities)) {
        const line = transfer.lines.find((x) => x.batchNo === batchNo);
        line.returned += qty;
        if (payload.restock) state.batches[batchNo].onHand += qty;
      }
      // 退回途中未确认的数量按损耗核销，避免继续算作在途
      for (const l of shipment.lines) {
        const lost = l.quantity - (payload.quantities[l.batchNo] ?? 0);
        if (lost > 0) {
          const line = transfer.lines.find((x) => x.batchNo === l.batchNo);
          line.writtenOff += lost;
        }
      }
      for (const e of payload.exceptions ?? []) state.exceptions.push(e);
      for (const ex of state.exceptions) {
        if (
          ex.transferNo === payload.transferNo &&
          ex.shipmentNo === payload.shipmentNo &&
          ex.kind === "return"
        ) {
          ex.resolved = true;
          ex.resolvedAt = payload.at;
        }
      }
      return;
    }
    default:
      throw new Error(`未知事件类型: ${type}`);
  }
}
