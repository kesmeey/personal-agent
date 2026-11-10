import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import type { ContextStats } from "./context.ts";
import type { PiUsage, RunMetrics } from "./execution-monitor.ts";

export interface RequestTimings {
  queueMs: number; sessionMs: number; attachmentsMs: number; memoryMs: number; contextMs: number;
  preparationMs: number; runnerQueueMs: number; runMs: number; totalMs: number; firstTextMs?: number;
}
export interface RuntimeTrace {
  requestId: string; at: string; model: string; ok: boolean;
  timings: RequestTimings; metrics?: RunMetrics; usage?: PiUsage; context?: ContextStats;
}
const MAX_BYTES = 2 * 1024 * 1024;

/** 诊断副本不是任务事实库；只保存白名单指标，不保存 prompt、工具参数、结果正文或错误堆栈。 */
export class RuntimeTraceStore {
  private readonly file: string;
  private readonly redact: (text: string) => string;
  constructor(file: string, redact: (text: string) => string = (text) => text) {
    this.file = file;
    this.redact = redact;
  }

  append(trace: RuntimeTrace): void {
    const { requestId, at, model, ok, timings, metrics, usage, context } = trace;
    const timingKeys: Array<keyof RequestTimings> = ["queueMs", "sessionMs", "attachmentsMs", "memoryMs", "contextMs", "preparationMs", "runnerQueueMs", "runMs", "totalMs", "firstTextMs"];
    const safeTimings = Object.fromEntries(timingKeys.map((key) => [key, timings[key]]).filter(([, value]) => typeof value === "number" && Number.isFinite(value) && value >= 0));
    const safeMetrics = metrics && { queueMs: metrics.queueMs, firstTextMs: metrics.firstTextMs, modelCalls: metrics.modelCalls, toolCalls: metrics.toolCalls, toolErrors: metrics.toolErrors, toolMs: metrics.toolMs, stopReason: metrics.stopReason };
    const safeUsage = usage && { tokens: usage.tokens, cost: usage.cost, input: usage.input, output: usage.output, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite };
    const safeContext = context && { budgetChars: context.budgetChars, chars: context.chars, selected: context.selected, omitted: context.omitted, duplicates: context.duplicates };
    const line = JSON.stringify({ requestId, at, model, ok, timings: safeTimings, metrics: safeMetrics, usage: safeUsage, context: safeContext }, (_key, value) => typeof value === "string" ? this.redact(value) : value) + "\n";
    if (Buffer.byteLength(line) > MAX_BYTES) throw new Error("诊断记录超出大小上限");
    mkdirSync(path.dirname(this.file), { recursive: true });
    if (existsSync(this.file) && statSync(this.file).size + Buffer.byteLength(line) > MAX_BYTES) {
      rmSync(`${this.file}.1`, { force: true });
      renameSync(this.file, `${this.file}.1`);
    }
    appendFileSync(this.file, line, { encoding: "utf8", mode: 0o600 });
  }
}

export function readRuntimeTraces(file: string): RuntimeTrace[] {
  if (!existsSync(file)) return [];
  const rows: RuntimeTrace[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    try {
      const value = JSON.parse(line);
      if (typeof value.requestId === "string" && typeof value.ok === "boolean" && Number.isFinite(value.timings?.totalMs)) rows.push(value);
    } catch { /* 诊断文件的半行不影响业务记录或其他有效样本。 */ }
  }
  return rows;
}

export function summarizeRuntimeTraces(rows: RuntimeTrace[]) {
  const percentile = (values: number[], ratio: number) => {
    const ordered = values.filter((value) => Number.isFinite(value) && value >= 0).sort((a, b) => a - b);
    return ordered.length ? ordered[Math.max(0, Math.ceil(ordered.length * ratio) - 1)] : undefined;
  };
  const total = rows.map((row) => row.timings.totalMs);
  const first = rows.flatMap((row) => row.timings.firstTextMs === undefined ? [] : [row.timings.firstTextMs]);
  return { requests: rows.length, succeeded: rows.filter((row) => row.ok).length, firstTextSamples: first.length,
    totalMs: { p50: percentile(total, 0.5), p95: percentile(total, 0.95) },
    firstTextMs: { p50: percentile(first, 0.5), p95: percentile(first, 0.95) },
    tokens: rows.reduce((sum, row) => sum + (row.usage?.tokens ?? 0), 0), cost: rows.reduce((sum, row) => sum + (row.usage?.cost ?? 0), 0) };
}
