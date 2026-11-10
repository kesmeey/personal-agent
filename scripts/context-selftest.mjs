import assert from "node:assert/strict";
import test from "node:test";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { loadConfig } from "../src/config.ts";
import { assembleContext } from "../src/context.ts";
import { temporary } from "./runtime-fixtures.mjs";
test("context selection honors priorities and exact JSON budget, deduplicates and never modifies caller data", () => {
  const items = [
    { id: "index", source: "index", text: "低优先级目录".repeat(100), priority: 9 },
    { id: "state", source: "task", text: "目标：完成测试；约束：不推送", priority: 0 },
    { id: "memory", source: "memory", text: '含引号 " 和换行\n 的记忆', priority: 2 },
    { id: "duplicate", source: "memory", text: '含引号 " 和换行\n 的记忆', priority: 2 },
  ];
  const before = structuredClone(items);
  const packed = assembleContext(items, 250);
  assert.deepEqual(JSON.parse(packed.text).map((item) => item.id), ["state", "memory"]);
  assert.equal(packed.stats.chars, packed.text.length);
  assert(packed.text.length <= 250);
  assert.equal(packed.stats.omitted, 1);
  assert.equal(packed.stats.duplicates, 1);
  assert.deepEqual(items, before);
  assert.equal(assembleContext(items, 2).text, "[]");
  assert.throws(() => assembleContext(items, 1));
});

test("background budgets validate their character unit and preserve old configurations", (t) => {
  const { root } = temporary(t);
  const file = path.join(root, "config.json");
  const base = { agent: { userId: "fixture" }, pi: { command: "node", args: [] } };
  for (const value of [1, -1, 2.5]) {
    writeFileSync(file, JSON.stringify({ ...base, agent: { ...base.agent, maxBackgroundChars: value } }));
    assert.throws(() => loadConfig(file), /maxBackgroundChars/);
  }
  writeFileSync(file, JSON.stringify({ ...base, agent: { ...base.agent, maxBackgroundChars: 2 } }));
  assert.equal(loadConfig(file).agent.maxBackgroundChars, 2);
});
