import assert from "node:assert/strict";
import test from "node:test";
import { startTestApp } from "./helpers.js";

test("健康检查返回服务状态", async (t) => {
  const ctx = await startTestApp(t);
  const response = await ctx.call("GET", "/health");
  assert.deepEqual(response.body, { service: "relief-supply", status: "ok" });
});

test("未知接口返回 404", async (t) => {
  const ctx = await startTestApp(t);
  const response = await ctx.call("GET", "/no-such-route");
  assert.equal(response.status, 404);
});
