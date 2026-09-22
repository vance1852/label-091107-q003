import { ApiError, badRequest } from "./errors.js";

const MAX_BODY_BYTES = 1024 * 1024;

export async function readJsonBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw badRequest("请求体超过 1MB 限制");
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  const text = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(text);
  } catch {
    throw badRequest("请求体不是合法的 JSON");
  }
}

export function sendJson(response, status, payload) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

/** 显式包装非 200 的响应，避免与数组类型的正常响应体混淆。 */
export class HttpResult {
  constructor(status, payload) {
    this.status = status;
    this.payload = payload;
  }
}

export const created = (payload) => new HttpResult(201, payload);

/**
 * 极简路由：method + 正则路径（命名分组提取参数）。
 * handler({ params, query, body, service }) 返回响应体（默认 200）或 HttpResult。
 */
export function createRouter(routes) {
  return async function route(request, response, service) {
    const url = new URL(request.url, "http://localhost");
    for (const [method, pattern, handler] of routes) {
      if (method !== request.method) continue;
      const match = pattern.exec(url.pathname);
      if (!match) continue;
      try {
        const body = method === "GET" || method === "DELETE" ? {} : await readJsonBody(request);
        const result = await handler({
          params: match.groups ?? {},
          query: url.searchParams,
          body,
          service,
        });
        if (result instanceof HttpResult) sendJson(response, result.status, result.payload);
        else sendJson(response, 200, result);
      } catch (error) {
        if (error instanceof ApiError) {
          sendJson(response, error.status, { error: error.message, code: error.code });
        } else {
          console.error("未处理的服务异常：", error);
          sendJson(response, 500, { error: "服务内部错误", code: "internal" });
        }
      }
      return;
    }
    sendJson(response, 404, { error: "接口不存在", code: "not_found" });
  };
}
