import assert from "node:assert/strict";
import test from "node:test";
import { appendFileSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { RuntimeTraceStore, readRuntimeTraces, summarizeRuntimeTraces } from "../src/runtime-trace.ts";
import { temporary } from "./runtime-fixtures.mjs";
function trace(id, firstTextMs = 20) {
  return { requestId: id, at: "2026-11-10T00:00:00.000Z", model: "fixture-model", ok: true,
    timings: { queueMs: 3, sessionMs: 2, attachmentsMs: 1, memoryMs: 4, contextMs: 1, preparationMs: 8, runnerQueueMs: 1, runMs: 30, totalMs: 42, firstTextMs },
    metrics: { queueMs: 1, modelCalls: 2, toolCalls: 2, toolErrors: 0, toolMs: 5, stopReason: "completed" },
    usage: { tokens: 10, cost: 0.01, input: 1, output: 2, cacheRead: 7, cacheWrite: 0 },
    context: { budgetChars: 100, chars: 80, selected: 2, omitted: 1, duplicates: 0 } };
}

test("traces persist only whitelisted metrics, survive partial lines and rotate to one bounded archive", (t) => {
  const { root } = temporary(t);
  const file = path.join(root, "traces.jsonl");
  const store = new RuntimeTraceStore(file, (text) => text.replaceAll("test-secret", "[hidden]"));
  const row = trace("test-secret");
  row.prompt = "PRIVATE_PROMPT";
  row.timings.PRIVATE_TIMING_NAME = 99;
  row.metrics.args = "PRIVATE_TOOL_ARGS";
  row.usage.raw = "PRIVATE_USAGE";
  row.context.raw = "PRIVATE_CONTEXT";
  store.append(row);
  const saved = readFileSync(file, "utf8");
  assert(!saved.includes("PRIVATE_"));
  assert(!saved.includes("test-secret"));
  appendFileSync(file, "{broken half line\n");
  assert.equal(readRuntimeTraces(file).length, 1);
  writeFileSync(file, "x".repeat(2 * 1024 * 1024));
  store.append(trace("rotated"));
  assert(existsSync(`${file}.1`));
  assert(statSync(file).size < 2 * 1024 * 1024);
  assert.equal(readRuntimeTraces(file)[0].requestId, "rotated");
  assert.equal(summarizeRuntimeTraces([]).totalMs.p95, undefined);
  const other = trace("second", undefined); delete other.timings.firstTextMs; other.timings.totalMs = 100;
  const summary = summarizeRuntimeTraces([trace("first"), other]);
  assert.equal(summary.totalMs.p50, 42); assert.equal(summary.totalMs.p95, 100);
  assert.equal(summary.firstTextSamples, 1); assert.equal(summary.tokens, 20);
});
