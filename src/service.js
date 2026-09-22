import crypto from "node:crypto";
import {
  CATEGORIES,
  applyEvent,
  availableQuantity,
  expiryInstant,
  initialState,
  isExpired,
  netShipped,
  transferStatus,
} from "./domain.js";
import { Journal } from "./store.js";

export class ValidationError extends Error {
  constructor(message, details) {
    super(message);
    this.name = "ValidationError";
    this.statusCode = 400;
    this.code = "VALIDATION_ERROR";
    this.details = details;
  }
}

export class ConflictError extends Error {
  constructor(message, details) {
    super(message);
    this.name = "ConflictError";
    this.statusCode = 409;
    this.code = "CONFLICT";
    this.details = details;
  }
}

export class NotFoundError extends Error {
  constructor(message) {
    super(message);
    this.name = "NotFoundError";
    this.statusCode = 404;
    this.code = "NOT_FOUND";
  }
}

function nowIso() {
  return new Date().toISOString();
}

function certNo() {
  return `CERT-${crypto.randomBytes(6).toString("hex").toUpperCase()}`;
}

function assertActor(actor) {
  if (!actor || typeof actor !== "string") {
    throw new ValidationError("缺少责任人 actor");
  }
}

function positiveInt(value, label) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new ValidationError(`${label} 必须为正整数`);
  }
  return value;
}

export class ReliefService {
  constructor(dataDir = process.env.DATA_DIR ?? "./data") {
    this.journal = new Journal(dataDir);
    this.state = this.journal.open(initialState, applyEvent);
  }

  #commit(type, payload) {
    return this.journal.commit(this.state, type, payload, applyEvent);
  }

  #commitMany(entries) {
    return this.journal.commitMany(this.state, entries, applyEvent);
  }

  #getBatch(batchNo) {
    const batch = this.state.batches[batchNo];
    if (!batch) throw new NotFoundError(`批次 ${batchNo} 不存在`);
    return batch;
  }

  #getTransfer(transferNo) {
    const transfer = this.state.transfers[transferNo];
    if (!transfer) throw new NotFoundError(`调拨单 ${transferNo} 不存在`);
    return transfer;
  }

  #getShipment(transfer, shipmentNo) {
    const shipment = transfer.shipments.find((s) => s.shipmentNo === shipmentNo);
    if (!shipment) {
      throw new NotFoundError(`车批 ${shipmentNo} 不属于调拨单 ${transfer.transferNo}`);
    }
    return shipment;
  }

  // ---------- 批次 ----------

  registerBatch(input = {}) {
    const {
      batchNo,
      category,
      name,
      quantity,
      expiryDate,
      location,
      owner,
      unit = "件",
    } = input;
    if (!batchNo || typeof batchNo !== "string") {
      throw new ValidationError("缺少批次号 batchNo");
    }
    if (this.state.batches[batchNo]) {
      throw new ConflictError(`批次号 ${batchNo} 已存在`);
    }
    if (!CATEGORIES.has(category)) {
      throw new ValidationError(`物资类别必须是 ${[...CATEGORIES].join("、")} 之一`);
    }
    if (!name) throw new ValidationError("缺少物资名称 name");
    positiveInt(quantity, "数量 quantity");
    if (!expiryDate || Number.isNaN(expiryInstant(expiryDate))) {
      throw new ValidationError("保质期 expiryDate 格式不正确（YYYY-MM-DD 或 ISO 8601）");
    }
    if (!location) throw new ValidationError("缺少存放位置 location");
    assertActor(owner);
    this.#commit("BATCH_REGISTERED", {
      batchNo,
      category,
      name,
      quantity,
      unit,
      expiryDate,
      location,
      owner,
      registeredAt: nowIso(),
    });
    return this.viewBatch(batchNo);
  }

  updateBatch(batchNo, patch = {}) {
    this.#getBatch(batchNo);
    const payload = { batchNo };
    if (patch.location !== undefined) {
      if (!patch.location) throw new ValidationError("位置不能为空");
      payload.location = patch.location;
    }
    if (patch.owner !== undefined) {
      assertActor(patch.owner);
      payload.owner = patch.owner;
    }
    if (payload.location === undefined && payload.owner === undefined) {
      throw new ValidationError("没有可更新的字段（仅支持 location、owner）");
    }
    this.#commit("BATCH_UPDATED", payload);
    return this.viewBatch(batchNo);
  }

  viewBatch(batchNo) {
    const b = this.#getBatch(batchNo);
    return {
      ...b,
      available: availableQuantity(b),
      expired: isExpired(b),
    };
  }

  listBatches({ includeExpired = true } = {}) {
    return Object.values(this.state.batches)
      .filter((b) => includeExpired || !isExpired(b))
      .map((b) => this.viewBatch(b.batchNo))
      .sort((a, b2) => a.expiryDate.localeCompare(b2.expiryDate));
  }

  // ---------- 调拨单 ----------

  createTransfer(input = {}) {
    const { transferNo, destination, destinationName, note, createdBy, lines } = input;
    if (!transferNo) throw new ValidationError("缺少调拨单号 transferNo");
    if (this.state.transfers[transferNo]) {
      throw new ConflictError(`调拨单号 ${transferNo} 已存在`);
    }
    if (!destination) throw new ValidationError("缺少目的地编码 destination");
    assertActor(createdBy);
    if (!Array.isArray(lines) || lines.length === 0) {
      throw new ValidationError("至少包含一条物资明细 lines");
    }
    const seen = new Set();
    const cleanLines = [];
    for (const line of lines) {
      const { batchNo, quantity } = line ?? {};
      if (!batchNo) throw new ValidationError("明细缺少批次号 batchNo");
      if (seen.has(batchNo)) {
        throw new ValidationError(`批次 ${batchNo} 在同一调拨单中重复出现`);
      }
      seen.add(batchNo);
      const batch = this.#getBatch(batchNo);
      positiveInt(quantity, `批次 ${batchNo} 的申请数量`);
      if (isExpired(batch)) {
        throw new ValidationError(`批次 ${batchNo} 已过保质期，不能分配`);
      }
      if (quantity > availableQuantity(batch)) {
        throw new ConflictError(
          `批次 ${batchNo} 可分配数量不足（可用 ${availableQuantity(batch)}，申请 ${quantity}）`,
        );
      }
      cleanLines.push({ batchNo, quantity });
    }
    this.#commit("TRANSFER_CREATED", {
      transferNo,
      destination,
      destinationName: destinationName ?? destination,
      note: note ?? "",
      createdBy,
      at: nowIso(),
      lines: cleanLines,
    });
    return this.viewTransfer(transferNo);
  }

  // 部分发运后只允许调整“尚未发运”的数量（未发 = 申请量 - 已净发出）。
  adjustTransfer(transferNo, patch = {}) {
    const transfer = this.#getTransfer(transferNo);
    if (transfer.cancelled) throw new ConflictError("调拨单已取消");
    if (!Array.isArray(patch.lines)) {
      throw new ValidationError("需要在 lines 中给出调整后的明细");
    }
    const byBatch = new Map(patch.lines.map((l) => [l.batchNo, l.quantity]));
    const changes = [];
    for (const line of transfer.lines) {
      if (!byBatch.has(line.batchNo)) continue;
      const quantity = byBatch.get(line.batchNo);
      positiveInt(quantity, `批次 ${line.batchNo} 的调整数量`);
      const alreadyShipped = netShipped(line);
      if (quantity < alreadyShipped) {
        throw new ConflictError(
          `批次 ${line.batchNo} 已净发运 ${alreadyShipped}，不能把数量调到该值以下`,
        );
      }
      if (quantity === line.quantity) continue;
      const batch = this.state.batches[line.batchNo];
      if (isExpired(batch)) {
        throw new ValidationError(`批次 ${line.batchNo} 已过保质期，不能继续分配`);
      }
      const outstanding = line.quantity - netShipped(line); // 本明细当前仍占用的数量
      const free = availableQuantity(batch) + outstanding;
      if (quantity > free) {
        throw new ConflictError(
          `批次 ${line.batchNo} 可分配数量不足（最多可调到 ${free}，请求 ${quantity}）`,
        );
      }
      changes.push({ batchNo: line.batchNo, quantity });
    }
    if (changes.length === 0) throw new ValidationError("没有发生变化的明细");
    this.#commit("TRANSFER_ADJUSTED", { transferNo, changes, at: nowIso() });
    return this.viewTransfer(transferNo);
  }

  cancelTransfer(transferNo, { actor } = {}) {
    assertActor(actor);
    const transfer = this.#getTransfer(transferNo);
    if (transfer.cancelled) return this.viewTransfer(transferNo);
    const outstanding = transfer.lines.some((l) => l.quantity - netShipped(l) > 0);
    if (!outstanding) {
      throw new ConflictError("全部数量已发运，无可取消的未发数量");
    }
    const moving = transfer.shipments.some((s) =>
      ["loaded", "in_transit", "returning"].includes(s.status),
    );
    if (moving) {
      throw new ConflictError("尚有车批在途，不能取消调拨单；请先完成签收或退回");
    }
    this.#commit("TRANSFER_CANCELLED", { transferNo, actor, at: nowIso() });
    return this.viewTransfer(transferNo);
  }

  // ---------- 分批装车 ----------

  loadShipment(transferNo, input = {}) {
    const transfer = this.#getTransfer(transferNo);
    if (transfer.cancelled) throw new ConflictError("调拨单已取消，不能装车");
    const { actor, node, lines, vehicle, note } = input;
    assertActor(actor);
    if (!node) throw new ValidationError("缺少装车节点 node");
    if (!Array.isArray(lines) || lines.length === 0) {
      throw new ValidationError("至少包含一条装车明细 lines");
    }

    const seen = new Set();
    const loadedLines = [];
    for (const l of lines) {
      const { batchNo, quantity } = l ?? {};
      const line = transfer.lines.find((x) => x.batchNo === batchNo);
      if (!line) {
        throw new ValidationError(`批次 ${batchNo} 不在调拨单 ${transferNo} 中`);
      }
      if (seen.has(batchNo)) {
        throw new ValidationError(`批次 ${batchNo} 在本车批中重复`);
      }
      seen.add(batchNo);
      positiveInt(quantity, `批次 ${batchNo} 的装车数量`);
      const batch = this.#getBatch(batchNo);
      if (isExpired(batch)) {
        throw new ValidationError(`批次 ${batchNo} 已过保质期，不能装车`);
      }
      const remaining = line.quantity - netShipped(line);
      if (quantity > remaining) {
        throw new ConflictError(
          `批次 ${batchNo} 本次装车 ${quantity} 超过未发数量 ${remaining}`,
        );
      }
      // 本单未发数量本身已计入 reserved，检查实物库存时要加回
      const physicalFree = availableQuantity(batch) + remaining;
      if (quantity > physicalFree) {
        throw new ConflictError(`批次 ${batchNo} 库存不足（实物可用 ${physicalFree}）`);
      }
      loadedLines.push({ batchNo, quantity });
    }

    const shipmentNo = `${transferNo}-S${String(transfer.nextShipmentSeq).padStart(2, "0")}`;
    const departureCert = certNo();
    const at = nowIso();
    const shipment = {
      shipmentNo,
      transferNo,
      vehicle: vehicle ?? "",
      loadNode: node,
      loadedBy: actor,
      loadedAt: at,
      note: note ?? "",
      lines: loadedLines,
      status: "in_transit",
      handoffs: [],
      chainTipCertNo: departureCert,
      expectedNode: undefined,
    };
    const departureHandoff = {
      certNo: departureCert,
      prevCertNo: null,
      transferNo,
      shipmentNo,
      type: "departure",
      fromNode: node,
      toNode: input.toNode ?? null,
      actor,
      counterparty: input.toNode ? String(input.toNode) : null,
      at,
      seq: null,
      recordId: null,
      note: note ?? "",
    };
    this.#commitMany([
      { type: "SHIPMENT_LOADED", payload: { shipment } },
      { type: "HANDOFF_RECORDED", payload: departureHandoff },
    ]);
    return {
      shipment: this.viewShipment(transfer, shipmentNo),
      departureCert: departureHandoff,
    };
  }

  // ---------- 途中交接 ----------

  #validateHandoff(input, {
    allowDeparture = false,
    allowTerminal = false,
    effectiveTip,
    effectiveExpectedNode,
    effectiveStatus,
    effectiveAliases,
  } = {}) {
    const {
      transferNo,
      shipmentNo,
      type,
      fromNode,
      toNode,
      actor,
      counterparty,
      prevCertNo,
      clientCertNo = null,
      at,
      seq = null,
      recordId = null,
      note = "",
    } = input;
    assertActor(actor);
    const transfer = this.#getTransfer(transferNo);
    if (transfer.cancelled) throw new ConflictError("调拨单已取消");
    const shipment = this.#getShipment(transfer, shipmentNo);
    // 离线整批校验时，链末端与期望节点要按“本批已模拟接受的记录”向前推进
    const tip = effectiveTip ?? shipment.chainTipCertNo;
    const expectedNode = effectiveExpectedNode ?? shipment.expectedNode;
    const currentStatus = effectiveStatus ?? shipment.status;
    const aliases = effectiveAliases ?? new Map();
    const resolveCert = (ref) =>
      ref == null ? null : this.state.clientCertIndex[ref] ?? aliases.get(ref) ?? ref;
    const resolvedPrev = resolveCert(prevCertNo);
    if (clientCertNo) {
      if (this.state.clientCertIndex[clientCertNo] || aliases.has(clientCertNo)) {
        throw new ConflictError(`设备端凭证号 ${clientCertNo} 已使用（重复提交）`, {
          code: "DUPLICATE_CLIENT_CERT",
        });
      }
    }
    if (recordId && this.state.recordIndex[recordId]) {
      throw new ConflictError(`离线记录 ${recordId} 已处理（凭证 ${this.state.recordIndex[recordId]}）`, {
        code: "DUPLICATE_RECORD",
      });
    }
    const allowedTypes = ["relay"];
    if (allowDeparture) allowedTypes.push("departure");
    if (allowTerminal) allowedTypes.push("arrival", "return", "return_received");
    else allowedTypes.push("return");
    if (!allowedTypes.includes(type)) {
      throw new ValidationError(`此处不允许交接类型 ${type}（允许：${allowedTypes.join("、")}）`);
    }
    if (!fromNode) throw new ValidationError("缺少交出方 fromNode");
    if (!toNode) throw new ValidationError("缺少接收方 toNode");
    if (type === "relay" || type === "departure") {
      // 在途交接：必须持有责任链末端（上一节点产生）的凭证
      if (!prevCertNo) throw new ValidationError("缺少前一节点凭证 prevCertNo");
      if (tip !== resolvedPrev) {
        throw new ConflictError(
          `凭证 ${prevCertNo} 不是当前责任链末端凭证（应为 ${tip ?? "无"}）`,
          { code: "STALE_CERT", expected: tip },
        );
      }
      if (currentStatus !== "in_transit") {
        throw new ConflictError(`车批当前状态为 ${currentStatus}，不能进行途中交接`);
      }
      if (expectedNode && expectedNode !== fromNode) {
        throw new ConflictError(
          `应当由 ${expectedNode} 交出，而不是 ${fromNode}`,
          { code: "NODE_MISMATCH" },
        );
      }
    } else if (type === "return") {
      if (currentStatus !== "in_transit") {
        throw new ConflictError(`车批当前状态为 ${currentStatus}，不能发起退回`);
      }
      if (tip !== resolvedPrev) {
        throw new ConflictError(
          `退回必须出示末端凭证 ${tip}`,
          { code: "STALE_CERT", expected: tip },
        );
      }
      if (expectedNode && expectedNode !== fromNode) {
        throw new ConflictError(
          `应当由 ${expectedNode} 发起退回，而不是 ${fromNode}`,
          { code: "NODE_MISMATCH" },
        );
      }
    } else if (type === "arrival") {
      if (currentStatus !== "in_transit") {
        throw new ConflictError(`车批当前状态为 ${currentStatus}，不能到站交接`);
      }
      if (tip !== resolvedPrev) {
        throw new ConflictError(
          `到站必须出示末端凭证 ${tip}，收到的是 ${prevCertNo ?? "空"}`,
          { code: "STALE_CERT", expected: tip },
        );
      }
      // 到站交接：当前持有方（fromNode）把货交给接收目的地（toNode）
      if (expectedNode && expectedNode !== fromNode) {
        throw new ConflictError(
          `货物当前应由 ${expectedNode} 交出，而不是 ${fromNode}`,
          { code: "NODE_MISMATCH" },
        );
      }
    } else if (type === "return_received") {
      if (currentStatus !== "returning") {
        throw new ConflictError(`车批当前状态为 ${currentStatus}，不在退回途中`);
      }
      if (tip !== resolvedPrev) {
        throw new ConflictError(
          `退回到站必须出示退回链末端凭证 ${tip}`,
          { code: "STALE_CERT", expected: tip },
        );
      }
      if (expectedNode && expectedNode !== toNode) {
        throw new ConflictError(
          `退回到站节点应为 ${expectedNode}，而不是 ${toNode}`,
          { code: "NODE_MISMATCH" },
        );
      }
    }
    let atMs = at ? Date.parse(at) : Date.now();
    if (Number.isNaN(atMs)) throw new ValidationError("时间 at 格式不正确");
    atMs = new Date(atMs).toISOString();
    return {
      transfer,
      shipment,
      handoff: {
        certNo: certNo(),
        // 链上只保留服务器凭证号；设备端原始编号另存以便对账
        prevCertNo: resolvedPrev,
        clientCertNo,
        transferNo,
        shipmentNo,
        type,
        fromNode,
        toNode,
        actor,
        counterparty: counterparty ?? String(toNode),
        at: atMs,
        seq,
        recordId,
        note,
      },
    };
  }

  // 在线单次交接仅用于在途中继；到站请走签收，退回请走专用退回接口。
  recordHandoff(input) {
    if (input.type && input.type !== "relay") {
      throw new ValidationError("在线交接只支持 relay；到站请签收，退回请调用退回接口");
    }
    const { handoff } = this.#validateHandoff({ ...input, type: "relay" });
    this.#commit("HANDOFF_RECORDED", handoff);
    return this.state.handoffs[handoff.certNo];
  }

  // 离线补传：多条带有序号的交接记录一次性送达。
  // - 按 seq 排序后逐条衔接，后一条须引用前一条新产生的凭证，首条引用当前链末端；
  // - arrival / return_received 记录会一并产生签收 / 退回确认（含数量核对与异常登记）；
  // - 任一条冲突（版本分叉 / 节点不符 / 重复 / 数量非法）则整批拒绝，不写入任何事件。
  syncOfflineHandoffs(input = {}) {
    const { transferNo, shipmentNo, records, deviceId } = input;
    if (!Array.isArray(records) || records.length === 0) {
      throw new ValidationError("缺少离线交接记录 records");
    }
    const seqs = new Set();
    for (const r of records) {
      if (!Number.isInteger(r.seq) || r.seq < 1) {
        throw new ValidationError("每条离线记录都必须带从 1 开始的序号 seq");
      }
      if (seqs.has(r.seq)) throw new ConflictError(`批次内序号 ${r.seq} 重复`);
      seqs.add(r.seq);
    }
    const ordered = [...records].sort((a, b) => a.seq - b.seq);

    const transfer = this.#getTransfer(transferNo);
    const shipment = this.#getShipment(transfer, shipmentNo);
    const recordIds = new Set();

    // 先做全量校验（不落盘），保证整批原子
    const entries = [];
    // 本批内 设备端凭证号 -> 服务器凭证号
    const aliases = new Map();
    const resolveRef = (ref) =>
      ref == null ? null : this.state.clientCertIndex[ref] ?? aliases.get(ref) ?? ref;
    let tipCert = shipment.chainTipCertNo;
    let expectedNode = shipment.expectedNode;
    let currentStatus = shipment.status;
    let chainClosed = false;
    for (const r of ordered) {
      if (
        (r.transferNo !== undefined && r.transferNo !== transferNo) ||
        (r.shipmentNo !== undefined && r.shipmentNo !== shipmentNo)
      ) {
        throw new ValidationError(`记录序号 ${r.seq} 的车批与批次不符`);
      }
      if (chainClosed) {
        throw new ConflictError(`序号 ${r.seq} 之前责任链已闭合，不能再接记录`);
      }
      const recordId = r.recordId ?? `${deviceId ?? "offline"}:${shipmentNo}:${r.seq}`;
      if (recordIds.has(recordId)) {
        throw new ConflictError(`批次内记录 ${recordId} 重复`);
      }
      // 整批重试（网络重发）：所有记录都已处理 → 幂等冲突，先于凭证链判定
      if (this.state.recordIndex[recordId]) {
        throw new ConflictError(
          `离线记录 ${recordId} 已处理（凭证 ${this.state.recordIndex[recordId]}），请勿重复提交`,
          { code: "DUPLICATE_RECORD" },
        );
      }
      recordIds.add(recordId);
      if (resolveRef(r.prevCertNo) !== tipCert) {
        throw new ConflictError(
          `序号 ${r.seq} 引用的凭证 ${r.prevCertNo ?? "空"} 与责任链末端 ${tipCert ?? "空"} 冲突（版本分叉）`,
          { code: "VERSION_CONFLICT", seq: r.seq, expected: tipCert },
        );
      }
      const { handoff: checked } = this.#validateHandoff({
        transferNo,
        shipmentNo,
        ...r,
        recordId,
      }, {
        allowTerminal: true,
        effectiveTip: tipCert,
        effectiveExpectedNode: expectedNode,
        effectiveStatus: currentStatus,
        effectiveAliases: aliases,
      });
      if (r.clientCertNo) aliases.set(r.clientCertNo, checked.certNo);

      if (r.type === "relay") {
        entries.push({ type: "HANDOFF_RECORDED", payload: { ...checked } });
        tipCert = checked.certNo;
        expectedNode = r.toNode;
      } else if (r.type === "return") {
        const built = this.#buildReturnStartEvents(transfer, shipment, {
          actor: checked.actor,
          fromNode: r.fromNode,
          toNode: r.toNode,
          reason: r.note ?? r.reason,
          at: checked.at,
          quantities: r.quantities,
          prevCertNo: tipCert,
          clientCertNo: checked.clientCertNo,
          seq: r.seq,
          recordId,
        });
        entries.push(...built);
        tipCert = built[0].payload.certNo;
        if (r.clientCertNo) aliases.set(r.clientCertNo, built[0].payload.certNo);
        expectedNode = r.toNode;
        currentStatus = "returning";
      } else if (r.type === "arrival") {
        const built = this.#buildSignEvents(transfer, shipment, {
          actor: checked.actor,
          node: r.toNode,
          at: checked.at,
          quantities: r.quantities,
          exceptions: r.exceptions,
          prevCertNo: tipCert,
          clientCertNo: checked.clientCertNo,
          seq: r.seq,
          recordId,
          note: r.note ?? "离线到站签收",
          fromNode: r.fromNode,
        });
        entries.push(...built);
        if (r.clientCertNo) aliases.set(r.clientCertNo, built[0].payload.certNo);
        chainClosed = true;
      } else if (r.type === "return_received") {
        const built = this.#buildReturnReceiveEvents(transfer, shipment, {
          actor: checked.actor,
          node: r.toNode,
          at: checked.at,
          quantities: r.quantities,
          restock: r.restock ?? true,
          exceptions: r.exceptions,
          prevCertNo: tipCert,
          clientCertNo: checked.clientCertNo,
          seq: r.seq,
          recordId,
          fromNode: r.fromNode,
        });
        entries.push(...built);
        if (r.clientCertNo) aliases.set(r.clientCertNo, built[0].payload.certNo);
        chainClosed = true;
      }
    }
    this.#commitMany(entries);
    return {
      accepted: entries.filter((e) => e.type === "HANDOFF_RECORDED").map((e) => e.payload),
      shipment: this.viewShipment(transfer, shipmentNo),
    };
  }

  // ---------- 到站签收 ----------

  #buildSignEvents(transfer, shipment, fields) {
    const {
      actor,
      node,
      at,
      quantities: rawQuantities,
      exceptions: exInput,
      prevCertNo,
      clientCertNo = null,
      seq = null,
      recordId = null,
      note = "到站签收",
      fromNode,
    } = fields;
    const q = rawQuantities ?? {};
    const received = {};
    let totalReceived = 0;
    for (const l of shipment.lines) {
      const got = q[l.batchNo] ?? 0;
      if (!Number.isInteger(got) || got < 0) {
        throw new ValidationError(`批次 ${l.batchNo} 的签收数量必须是非负整数`);
      }
      if (got > l.quantity) {
        throw new ConflictError(
          `批次 ${l.batchNo} 签收 ${got} 超过装车数量 ${l.quantity}`,
        );
      }
      received[l.batchNo] = got;
      totalReceived += got;
    }
    if (totalReceived === 0) {
      throw new ValidationError("签收数量全为 0：如有异常请使用异常退回流程");
    }
    const writtenOff = {};
    const exceptions = [];
    for (const l of shipment.lines) {
      const diff = l.quantity - received[l.batchNo];
      if (diff > 0) {
        writtenOff[l.batchNo] = diff;
        const reason =
          exInput?.find((e) => e.batchNo === l.batchNo)?.reason ?? "运输损耗/短缺，未退回";
        exceptions.push({
          exceptionNo: `EX-${crypto.randomBytes(6).toString("hex").toUpperCase()}`,
          transferNo: transfer.transferNo,
          shipmentNo: shipment.shipmentNo,
          batchNo: l.batchNo,
          kind: "shortage",
          quantity: diff,
          reason,
          at,
          reportedBy: actor,
          node,
          resolved: false,
        });
      }
    }
    const arrival = {
      certNo: certNo(),
      prevCertNo,
      clientCertNo,
      transferNo: transfer.transferNo,
      shipmentNo: shipment.shipmentNo,
      type: "arrival",
      fromNode: fromNode ?? shipment.expectedNode ?? shipment.loadNode,
      toNode: node,
      actor,
      counterparty: String(node),
      at,
      seq,
      recordId,
      note,
    };
    return [
      { type: "HANDOFF_RECORDED", payload: arrival },
      {
        type: "SHIPMENT_SIGNED",
        payload: {
          transferNo: transfer.transferNo,
          shipmentNo: shipment.shipmentNo,
          actor,
          node,
          at,
          quantities: received,
          writtenOff,
          exceptions,
        },
      },
    ];
  }

  signShipment(transferNo, shipmentNo, input = {}) {
    const transfer = this.#getTransfer(transferNo);
    const shipment = this.#getShipment(transfer, shipmentNo);
    const { actor, node, certNo: presentedCert, quantities, exceptions: exInput } = input;
    assertActor(actor);
    if (!node) throw new ValidationError("缺少签收节点 node");
    if (shipment.status !== "in_transit") {
      throw new ConflictError(`车批当前状态为 ${shipment.status}，不能签收`);
    }
    if (shipment.chainTipCertNo !== presentedCert) {
      throw new ConflictError(
        `签收必须出示末端凭证 ${shipment.chainTipCertNo}，收到的是 ${presentedCert ?? "空"}`,
        { code: "STALE_CERT", expected: shipment.chainTipCertNo },
      );
    }
    if (shipment.expectedNode && shipment.expectedNode !== node) {
      throw new ConflictError(`签收节点应为 ${shipment.expectedNode}，而不是 ${node}`);
    }
    const at = nowIso();
    const entries = this.#buildSignEvents(transfer, shipment, {
      actor,
      node,
      at,
      quantities,
      exceptions: exInput,
      prevCertNo: shipment.chainTipCertNo,
    });
    this.#commitMany(entries);
    return {
      shipment: this.viewShipment(transfer, shipmentNo),
      arrivalCert: entries[0].payload,
      exceptions: entries[1].payload.exceptions,
    };
  }

  // ---------- 异常退回 ----------

  #buildReturnStartEvents(transfer, shipment, fields) {
    const { actor, fromNode, toNode, reason, at, quantities: rawQuantities, prevCertNo, clientCertNo = null, seq = null, recordId = null } = fields;
    if (!fromNode) throw new ValidationError("缺少退回发起节点 fromNode");
    if (!toNode) throw new ValidationError("缺少退回接收节点 toNode");
    if (!reason) throw new ValidationError("必须填写退回原因 reason");
    const q = rawQuantities ?? {};
    const returnLines = [];
    for (const l of shipment.lines) {
      const qty = q[l.batchNo] ?? l.quantity;
      if (!Number.isInteger(qty) || qty <= 0) continue;
      if (qty > l.quantity) {
        throw new ConflictError(
          `批次 ${l.batchNo} 退回 ${qty} 超过装车数量 ${l.quantity}`,
        );
      }
      returnLines.push({ batchNo: l.batchNo, quantity: qty });
    }
    if (returnLines.length === 0) {
      throw new ValidationError("没有需要退回的数量");
    }
    const handoff = {
      certNo: certNo(),
      prevCertNo,
      clientCertNo,
      transferNo: transfer.transferNo,
      shipmentNo: shipment.shipmentNo,
      type: "return",
      fromNode,
      toNode,
      actor,
      counterparty: String(toNode),
      at,
      seq,
      recordId,
      note: reason,
    };
    const exception = {
      exceptionNo: `EX-${crypto.randomBytes(6).toString("hex").toUpperCase()}`,
      transferNo: transfer.transferNo,
      shipmentNo: shipment.shipmentNo,
      kind: "return",
      reason,
      at,
      reportedBy: actor,
      node: fromNode,
      quantities: Object.fromEntries(returnLines.map((l) => [l.batchNo, l.quantity])),
      resolved: false,
    };
    return [
      { type: "HANDOFF_RECORDED", payload: handoff },
      {
        type: "RETURN_STARTED",
        payload: { transferNo: transfer.transferNo, shipmentNo: shipment.shipmentNo, reason, exception },
      },
    ];
  }

  startReturn(transferNo, shipmentNo, input = {}) {
    const transfer = this.#getTransfer(transferNo);
    const shipment = this.#getShipment(transfer, shipmentNo);
    const { actor, fromNode, toNode, reason, quantities, certNo: presentedCert } = input;
    assertActor(actor);
    if (shipment.status !== "in_transit") {
      throw new ConflictError(`车批当前状态为 ${shipment.status}，不能发起退回`);
    }
    if (shipment.chainTipCertNo !== presentedCert) {
      throw new ConflictError(
        `退回必须出示末端凭证 ${shipment.chainTipCertNo}`,
        { code: "STALE_CERT", expected: shipment.chainTipCertNo },
      );
    }
    const entries = this.#buildReturnStartEvents(transfer, shipment, {
      actor,
      fromNode: fromNode ?? shipment.expectedNode,
      toNode,
      reason,
      at: nowIso(),
      quantities,
      prevCertNo: shipment.chainTipCertNo,
    });
    this.#commitMany(entries);
    return {
      shipment: this.viewShipment(transfer, shipmentNo),
      returnCert: entries[0].payload,
      exception: entries[1].payload.exception,
    };
  }

  #buildReturnReceiveEvents(transfer, shipment, fields) {
    const {
      actor,
      node,
      at,
      quantities: rawQuantities,
      restock = true,
      exceptions: exInput,
      prevCertNo,
      clientCertNo = null,
      seq = null,
      recordId = null,
      fromNode,
    } = fields;
    const q = rawQuantities ?? {};
    const confirmed = {};
    for (const l of shipment.lines) {
      const got = q[l.batchNo] ?? 0;
      if (!Number.isInteger(got) || got < 0) {
        throw new ValidationError(`批次 ${l.batchNo} 的退回确认数量必须是非负整数`);
      }
      if (got > l.quantity) {
        throw new ConflictError(
          `批次 ${l.batchNo} 退回确认 ${got} 超过装车数量 ${l.quantity}`,
        );
      }
      if (got > 0) confirmed[l.batchNo] = got;
    }
    if (Object.keys(confirmed).length === 0) {
      throw new ValidationError("退回确认数量全为 0");
    }
    const exceptions = [];
    for (const l of shipment.lines) {
      const diff = l.quantity - (confirmed[l.batchNo] ?? 0);
      if (diff > 0) {
        const reason =
          exInput?.find((e) => e.batchNo === l.batchNo)?.reason ?? "退回途中短缺，未入库";
        exceptions.push({
          exceptionNo: `EX-${crypto.randomBytes(6).toString("hex").toUpperCase()}`,
          transferNo: transfer.transferNo,
          shipmentNo: shipment.shipmentNo,
          batchNo: l.batchNo,
          kind: "return_shortage",
          quantity: diff,
          reason,
          at,
          reportedBy: actor,
          node,
          resolved: false,
        });
      }
    }
    // 过期物资退回不能重新入库，必须登记为损耗
    if (restock) {
      for (const batchNo of Object.keys(confirmed)) {
        if (isExpired(this.state.batches[batchNo])) {
          throw new ConflictError(`批次 ${batchNo} 已过期，不能重新入库（restock 请置为 false）`);
        }
      }
    }
    const handoff = {
      certNo: certNo(),
      prevCertNo,
      clientCertNo,
      transferNo: transfer.transferNo,
      shipmentNo: shipment.shipmentNo,
      type: "return_received",
      fromNode: fromNode ?? shipment.expectedNode ?? "",
      toNode: node,
      actor,
      counterparty: String(node),
      at,
      seq,
      recordId,
      note: restock ? "退回到站并重新入库" : "退回到站，不重新入库",
    };
    return [
      { type: "HANDOFF_RECORDED", payload: handoff },
      {
        type: "RETURN_RECEIVED",
        payload: {
          transferNo: transfer.transferNo,
          shipmentNo: shipment.shipmentNo,
          actor,
          node,
          at,
          quantities: confirmed,
          restock,
          exceptions,
        },
      },
    ];
  }

  receiveReturn(transferNo, shipmentNo, input = {}) {
    const transfer = this.#getTransfer(transferNo);
    const shipment = this.#getShipment(transfer, shipmentNo);
    const {
      actor,
      node,
      certNo: presentedCert,
      quantities,
      restock = true,
      exceptions: exInput,
    } = input;
    assertActor(actor);
    if (!node) throw new ValidationError("缺少退回到站节点 node");
    if (shipment.status !== "returning") {
      throw new ConflictError(`车批当前状态为 ${shipment.status}，未在退回途中`);
    }
    if (shipment.chainTipCertNo !== presentedCert) {
      throw new ConflictError(
        `退回到站必须出示末端凭证 ${shipment.chainTipCertNo}`,
        { code: "STALE_CERT", expected: shipment.chainTipCertNo },
      );
    }
    if (shipment.expectedNode && shipment.expectedNode !== node) {
      throw new ConflictError(`退回到站节点应为 ${shipment.expectedNode}，而不是 ${node}`);
    }
    const entries = this.#buildReturnReceiveEvents(transfer, shipment, {
      actor,
      node,
      at: nowIso(),
      quantities,
      restock,
      exceptions: exInput,
      prevCertNo: shipment.chainTipCertNo,
      fromNode: input.fromNode,
    });
    this.#commitMany(entries);
    return {
      shipment: this.viewShipment(transfer, shipmentNo),
      receivedCert: entries[0].payload,
      exceptions: entries[1].payload.exceptions,
    };
  }

  recordException(input = {}) {
    const { transferNo, shipmentNo, batchNo, kind, quantity, reason, actor, node } = input;
    assertActor(actor);
    if (!node) throw new ValidationError("缺少上报节点 node");
    if (transferNo) this.#getTransfer(transferNo);
    if (shipmentNo) this.#getShipment(this.#getTransfer(transferNo), shipmentNo);
    if (batchNo) this.#getBatch(batchNo);
    if (!["damage", "expiry", "theft", "other", "shortage"].includes(kind)) {
      throw new ValidationError("异常类别不支持");
    }
    if (quantity !== undefined && (!Number.isInteger(quantity) || quantity < 0)) {
      throw new ValidationError("异常数量必须是非负整数");
    }
    if (!reason) throw new ValidationError("必须填写异常情况 reason");
    const exception = {
      exceptionNo: `EX-${crypto.randomBytes(6).toString("hex").toUpperCase()}`,
      transferNo: transferNo ?? null,
      shipmentNo: shipmentNo ?? null,
      batchNo: batchNo ?? null,
      kind,
      quantity: quantity ?? null,
      reason,
      at: nowIso(),
      reportedBy: actor,
      node,
      resolved: false,
    };
    this.#commit("EXCEPTION_RECORDED", { exception });
    return exception;
  }

  resolveException(exceptionNo, { actor, resolution } = {}) {
    assertActor(actor);
    const exception = this.state.exceptions.find((e) => e.exceptionNo === exceptionNo);
    if (!exception) throw new NotFoundError(`异常 ${exceptionNo} 不存在`);
    if (exception.resolved) return exception;
    const at = nowIso();
    this.#commit("EXCEPTION_RESOLVED", { exceptionNo, actor, resolution: resolution ?? "", at });
    return this.state.exceptions.find((e) => e.exceptionNo === exceptionNo);
  }

  listTransfers({ destination } = {}) {
    return Object.values(this.state.transfers)
      .filter((t) => !destination || t.destination === destination)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((t) => this.viewTransfer(t.transferNo));
  }

  // ---------- 视图 ----------

  viewShipment(transfer, shipmentNo) {
    const s = this.#getShipment(transfer, shipmentNo);
    return {
      ...s,
      handoffs: s.handoffs.map((h) => ({ ...h })),
      lines: s.lines.map((l) => ({ ...l })),
    };
  }

  viewTransfer(transferNo) {
    const t = this.#getTransfer(transferNo);
    return {
      transferNo: t.transferNo,
      destination: t.destination,
      destinationName: t.destinationName,
      note: t.note,
      createdBy: t.createdBy,
      createdAt: t.createdAt,
      cancelled: t.cancelled,
      status: transferStatus(t),
      lines: t.lines.map((l) => ({
        ...l,
        outstanding: Math.max(0, l.quantity - netShipped(l)),
      })),
      shipments: t.shipments.map((s) => ({
        shipmentNo: s.shipmentNo,
        vehicle: s.vehicle,
        loadNode: s.loadNode,
        loadedBy: s.loadedBy,
        loadedAt: s.loadedAt,
        status: s.status,
        expectedNode: s.expectedNode ?? null,
        chainTipCertNo: s.chainTipCertNo,
        terminalCertNo: s.terminalCertNo ?? null,
        signedAt: s.signedAt ?? null,
        returnedAt: s.returnedAt ?? null,
        returnReason: s.returnReason ?? null,
        lines: s.lines,
      })),
    };
  }

  // 仓管员还原整段旅程：批次 → 调拨 → 车批 → 凭证链 → 异常，按时间排序。
  journey(transferNo) {
    const t = this.viewTransfer(transferNo);
    const timeline = [];
    for (const s of t.shipments) {
      const full = this.#getShipment(this.#getTransfer(transferNo), s.shipmentNo);
      timeline.push({
        kind: "loaded",
        at: full.loadedAt,
        node: full.loadNode,
        actor: full.loadedBy,
        shipmentNo: full.shipmentNo,
        certNo: full.handoffs[0]?.certNo ?? null,
        lines: full.lines,
      });
      for (const h of full.handoffs) {
        timeline.push({
          kind: `handoff:${h.type}`,
          at: h.at,
          node: h.fromNode,
          actor: h.actor,
          shipmentNo: h.shipmentNo,
          certNo: h.certNo,
          prevCertNo: h.prevCertNo,
          fromNode: h.fromNode,
          toNode: h.toNode,
          seq: h.seq,
          recordId: h.recordId,
          note: h.note,
        });
      }
      if (full.signedAt) {
        timeline.push({
          kind: "signed",
          at: full.signedAt,
          node: full.signedNode,
          actor: full.signedBy,
          shipmentNo: full.shipmentNo,
          certNo: full.terminalCertNo,
          received: full.signedQuantities,
          writtenOff: full.writtenOffQuantities,
        });
      }
      if (full.returnedAt) {
        timeline.push({
          kind: "returned",
          at: full.returnedAt,
          node: full.returnedNode,
          actor: full.returnedBy,
          shipmentNo: full.shipmentNo,
          certNo: full.terminalCertNo,
          quantities: full.returnedQuantities,
        });
      }
    }
    timeline.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
    return { transfer: t, timeline };
  }

  // 目的地汇总
  destinationSummary(destination) {
    const rows = [];
    for (const t of Object.values(this.state.transfers)) {
      if (destination && t.destination !== destination) continue;
      for (const line of t.lines) {
        const batch = this.state.batches[line.batchNo];
        rows.push({
          destination: t.destination,
          destinationName: t.destinationName,
          transferNo: t.transferNo,
          batchNo: line.batchNo,
          category: batch?.category ?? null,
          name: batch?.name ?? null,
          requested: line.quantity,
          shipped: line.shipped,
          received: line.received,
          returned: line.returned,
          writtenOff: line.writtenOff,
          inTransit: Math.max(0, netShipped(line) - line.received - line.writtenOff),
          outstanding: Math.max(0, line.quantity - netShipped(line)),
        });
      }
    }
    const grouped = new Map();
    for (const r of rows) {
      const key = `${r.destination}|${r.batchNo}`;
      if (!grouped.has(key)) {
        grouped.set(key, { ...r, transfers: [r.transferNo] });
      } else {
        const g = grouped.get(key);
        for (const f of ["requested", "shipped", "received", "returned", "writtenOff", "inTransit", "outstanding"]) {
          g[f] += r[f];
        }
        g.transfers.push(r.transferNo);
      }
    }
    return [...grouped.values()].map(({ transferNo, ...rest }) => rest);
  }

  listExceptions({ unresolvedOnly = false } = {}) {
    return this.state.exceptions
      .filter((e) => !unresolvedOnly || !e.resolved)
      .sort((a, b) => a.at.localeCompare(b.at));
  }

  close() {
    this.journal.close();
  }
}
