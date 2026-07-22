import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(
    new Request("http://localhost/", { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("server-renders the Berlin Trace product shell", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
  const html = await response.text();
  assert.match(html, /<html lang="zh-CN">/);
  assert.match(html, /Berlin Trace/);
  assert.match(html, /图钉线迹规划器/);
  assert.match(html, /穿线/);
  assert.match(html, /浏览/);
  assert.match(html, /完成并匹配/);
  assert.match(html, /路线偏好/);
  assert.match(html, /VBB/);
  assert.doesNotMatch(html, /Starter Project|Building your site|react-loading-skeleton/);
});

test("bundles a current, Berlin-only multimodal VBB network", async () => {
  const raw = await readFile(new URL("../public/berlin-transit.json", import.meta.url), "utf8");
  const network = JSON.parse(raw);
  assert.equal(network.source, "VBB GTFS");
  assert.equal(network.license, "CC BY 4.0");
  assert.match(network.sourceUpdatedAt, /^20\d{2}-\d{2}-\d{2}$/);
  assert.ok(network.lines.length > 300);
  const modes = new Set(network.lines.map((line) => line.mode));
  for (const mode of ["subway", "light_rail", "tram", "bus", "rail", "ferry"]) {
    assert.ok(modes.has(mode), `missing ${mode}`);
  }
  for (const line of network.lines) {
    assert.ok(line.polylines.length > 0);
    assert.equal(line.polylineBboxes.length, line.polylines.length);
    assert.ok(line.stops.length > 0);
  }
});
