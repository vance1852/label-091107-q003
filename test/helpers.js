import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createApp } from "../src/app.js";

export const T0 = new Date("2026-09-22T08:00:00.000Z");

/** 启动一个使用临时数据目录的应用实例，时钟可手动推进。 */
export async function startApp({ now } = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), "relief-"));
  return openApp(dataDir, now);
}

/** 启动实例并注册到测试清理钩子，断言失败也不会泄漏句柄。 */
export async function startTestApp(t, options) {
  const ctx = await startApp(options);
  t.after(() => ctx.close());
  return ctx;
}

export async function openApp(dataDir, now) {
  let clock = now ?? T0;
  const app = await createApp({ dataDir, now: () => clock });
  app.listen(0);
  const { port } = app.address();
  const base = `http://127.0.0.1:${port}`;

  async function call(method, url, body) {
    const response = await fetch(base + url, {
      method,
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  }

  return {
    app,
    dataDir,
    call,
    setClock: (date) => {
      clock = date;
    },
    close: () =>
      new Promise((resolve) => {
        app.close(async () => {
          await app.service.close();
          resolve();
        });
        // fetch 的 keep-alive 连接会阻止 close 回调触发，强制断开
        app.closeAllConnections?.();
      }),
  };
}

/** 登记一个批次并返回响应体。 */
export async function seedBatch(ctx, overrides = {}) {
  const response = await ctx.call("POST", "/batches", {
    materialType: "饮用水",
    quantity: 100,
    location: "省级仓库",
    keeper: "仓管员甲",
    ...overrides,
  });
  if (response.status !== 201) throw new Error(`登记批次失败：${JSON.stringify(response.body)}`);
  return response.body;
}
