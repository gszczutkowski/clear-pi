// Run: node --experimental-strip-types ./tests/progress-data.bench.ts
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { createProgressReader } from "../progress-data.ts";

const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)].toFixed(2);
async function measure<T>(read: () => Promise<T>) {
  const start = performance.now();
  const timer = new Promise<number>(resolve => setTimeout(() => resolve(performance.now() - start), 0));
  const result = await read();
  return { result, elapsed: performance.now() - start, timer: await timer };
}

for (const count of [100, 500, 2000]) {
  const dir = await mkdtemp(join(tmpdir(), "clear-progress-bench-"));
  try {
    const root = { sessionId: "benchmark", sessionFile: join(dir, "parent.jsonl") };
    const eventDirectory = join(dir, "artifacts", root.sessionId, "subagent-history");
    await mkdir(eventDirectory, { recursive: true });
    const common = { version: 1, root, rootAssignmentId: "benchmark", rootCheckpoint: "checkpoint", rootBranchToken: "bench", eventDirectory };
    const coordinator = { ...common, parent: root, child: { sessionId: "coordinator", sessionFile: join(dir, "coordinator.jsonl") } };
    const worker = { ...common, parent: coordinator.child, child: { sessionId: "worker", sessionFile: join(dir, "worker.jsonl") } };
    for (const [role, lineage] of [["coordinator", coordinator], ["worker", worker]] as const) {
      await writeFile(`${lineage.child.sessionFile}.launch-profile.json`, JSON.stringify({ version: 1, sessionFile: lineage.child.sessionFile, role, lineage }));
    }
    const branch = [
      { type: "custom", id: "checkpoint", customType: "subagent-custody", data: { branchToken: "bench" } },
      { type: "custom", id: "lineage", customType: "subagent-lineage-assignment/v1", data: coordinator },
    ];
    const manager = { getSessionDir: () => dir, getSessionFile: () => root.sessionFile, getHeader: () => ({ id: root.sessionId }), getBranch: () => branch };
    const artifact = (n: number, summary = `Synthetic event ${n}`) => {
      const id = n.toString(16).padStart(64, "0");
      const lineage = n === 0 ? coordinator : worker;
      return writeFile(join(eventDirectory, `${id}.json`), JSON.stringify({
        version: 1, id, runId: n === 0 ? "coordinator" : `worker-${Math.ceil(n / 2)}`, lineage,
        kind: n === 0 || n % 2 === 1 ? "assignment" : "result", summary,
        timestamp: new Date(Date.UTC(2026, 0, 1) + n * 1000).toISOString(), refs: [],
      }));
    };
    for (let start = 0; start < count; start += 32) {
      await Promise.all(Array.from({ length: Math.min(32, count - start) }, (_, i) => artifact(start + i)));
    }
    const cold: number[] = [], changed: number[] = [], timer: number[] = [];
    for (let i = -1; i < 7; i++) { // One discarded warm-up, seven samples with new in-process caches.
      const read = createProgressReader();
      const first = await measure(() => read(manager));
      assert.equal(first.result.view.unassigned[0].children.length, count / 2);
      const summary = `Changed event ${i}: ${"x".repeat(i + 2)}`;
      await artifact(2, summary);
      const next = await measure(() => read(manager));
      assert.equal(next.result.view.unassigned[0].children[0].summary, summary);
      if (i >= 0) { cold.push(first.elapsed); changed.push(next.elapsed); timer.push(first.timer); }
    }
    console.log(`${count} events: first ${median(cold)} ms, one file changed ${median(changed)} ms, timer fired after ${median(timer)} ms during first read`);
  } finally { await rm(dir, { recursive: true, force: true }); }
}
