import { createServer } from "node:http";
import { ConflictError, NotFoundError, ReliefService, ValidationError } from "./service.js";

// 简易路由器：不引入任何外部依赖。
export function createApp(serviceFactory) {
  const server = createServer((req, res) => handle(req, res, serviceFactory));
  return server;
}

async function readJson(request) {
  const limit = 1_000_000;
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new ValidationError("请求体超过 1MB 限制");
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ValidationError("请求体不是合法 JSON");
  }
}

function sendJson(response, statusCode, body) {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

async function handle(request, response, serviceFactory) {
  const url = new URL(request.url, "http://localhost");
  const path = url.pathname.replace(/\/+$/, "") || "/";
  try {
    if (request.method === "GET" && path === "/health") {
      sendJson(response, 200, { service: "relief-supply", status: "ok" });
      return;
    }

    const service = serviceFactory();
    const body = ["POST", "PATCH", "PUT"].includes(request.method)
      ? await readJson(request)
      : {};
    const query = Object.fromEntries(url.searchParams);
    const route = matchRoute(request.method, path, body, query, service);
    if (!route) {
      sendJson(response, 404, { error: "接口不存在" });
      return;
    }
    const result = route.run();
    sendJson(response, route.status, result);
  } catch (error) {
    if (error instanceof ValidationError) {
      sendJson(response, 400, { error: error.message, code: error.code, details: error.details });
    } else if (error instanceof NotFoundError) {
      sendJson(response, 404, { error: error.message, code: error.code });
    } else if (error instanceof ConflictError) {
      sendJson(response, 409, { error: error.message, code: error.code, details: error.details });
    } else {
      sendJson(response, 500, { error: "服务器内部错误" });
      // eslint-disable-next-line no-console
      console.error(error);
    }
  }
}

function matchRoute(method, path, body, query, s) {
  const ok = (run, status = 200) => ({ run, status });
  const seg = path.split("/").slice(1);

  // /batches ...
  if (seg[0] === "batches") {
    if (method === "POST" && seg.length === 1) return ok(() => s.registerBatch(body), 201);
    if (method === "GET" && seg.length === 1) {
      return ok(() =>
        s.listBatches({ includeExpired: query.includeExpired !== "false" }),
      );
    }
    if (seg.length === 2) {
      const no = decodeURIComponent(seg[1]);
      if (method === "GET") return ok(() => s.viewBatch(no));
      if (method === "PATCH") return ok(() => s.updateBatch(no, body));
    }
  }

  // /transfers ...
  if (seg[0] === "transfers") {
    if (method === "POST" && seg.length === 1) return ok(() => s.createTransfer(body), 201);
    if (method === "GET" && seg.length === 1) {
      return ok(() => s.listTransfers({ destination: query.destination }));
    }
    if (seg.length >= 2 && seg[1]) {
      const no = decodeURIComponent(seg[1]);
      if (seg.length === 2) {
        if (method === "GET") return ok(() => s.viewTransfer(no));
        if (method === "PATCH") return ok(() => s.adjustTransfer(no, body));
      }
      if (seg.length === 3 && seg[2] === "cancel" && method === "POST") {
        return ok(() => s.cancelTransfer(no, body));
      }
      if (seg.length === 3 && seg[2] === "journey" && method === "GET") {
        return ok(() => s.journey(no));
      }
      if (seg.length === 3 && seg[2] === "shipments" && method === "POST") {
        return ok(() => s.loadShipment(no, body), 201);
      }
      if (seg.length >= 5 && seg[2] === "shipments") {
        const shipmentNo = decodeURIComponent(seg[3]);
        const action = seg[4];
        if (action === "handoffs" && seg.length === 5 && method === "POST") {
          return ok(() => s.recordHandoff({ ...body, transferNo: no, shipmentNo }), 201);
        }
        if (action === "offline-handoffs" && seg.length === 5 && method === "POST") {
          return ok(() => s.syncOfflineHandoffs({ ...body, transferNo: no, shipmentNo }), 201);
        }
        if (action === "sign" && seg.length === 5 && method === "POST") {
          return ok(() => s.signShipment(no, shipmentNo, body));
        }
        if (action === "returns" && seg.length === 5 && method === "POST") {
          return ok(() => s.startReturn(no, shipmentNo, body));
        }
        if (action === "returns" && seg.length === 6 && seg[5] === "receive" && method === "POST") {
          return ok(() => s.receiveReturn(no, shipmentNo, body));
        }
      }
    }
  }

  if (seg[0] === "exceptions") {
    if (method === "POST" && seg.length === 1) return ok(() => s.recordException(body), 201);
    if (method === "GET" && seg.length === 1) {
      return ok(() => s.listExceptions({ unresolvedOnly: query.unresolvedOnly === "true" }));
    }
    if (method === "POST" && seg.length === 3 && seg[2] === "resolve") {
      return ok(() => s.resolveException(decodeURIComponent(seg[1]), body));
    }
  }

  if (seg[0] === "destinations") {
    if (method === "GET" && seg.length === 2 && seg[1] === "summary") {
      return ok(() => s.destinationSummary(query.destination));
    }
    if (method === "GET" && seg.length === 3 && seg[2] === "summary") {
      return ok(() => s.destinationSummary(decodeURIComponent(seg[1])));
    }
  }

  return null;
}

// 独立进程入口使用：懒加载单例，保证仅引入 /health 的测试不会落盘。
export function createDefaultApp() {
  let service;
  return createApp(() => (service ??= new ReliefService()));
}
