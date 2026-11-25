import { performance } from "node:perf_hooks";
import * as renderer from "../progress-view.ts";
import type { ProgressRun, ProgressView } from "../progress-view.ts";

const run = (i: number, children: ProgressRun[] = [], role = "worker"): ProgressRun => ({
  id: `R${i}`, name: `Example ${i}`, role, task: "Example task", status: "RESULT REPORTED",
  summary: "A synthetic saved result that describes the status of the run. ".repeat(5), children,
});
for (const [label, unassigned] of [
  ["Agents: 20 roots × 50 children", Array.from({ length: 20 }, (_, i) => run(i, Array.from({ length: 50 }, (_, j) => run(20 + i * 50 + j))))],
  ["Coordinated: 1000 roots", Array.from({ length: 1000 }, (_, i) => run(i, [], i === 0 ? "feature-coordinator" : "worker"))],
] as const) {
  const view: ProgressView = { title: null, tasks: [], unassigned };
  const prepared = renderer.prepareProgress?.(view);
  for (const [name, options] of [
    ["compact (cold)", { compact: true }],
    ...(prepared ? [["compact (prepared)", { compact: true, prepared }]] as const : []),
    ["full (cold)", { details: true, maxRuns: 100 }],
  ] as const) {
    for (let i = 0; i < 10; i++) renderer.renderProgress(view, 100, options);
    let lines = 0;
    const samples = Array.from({ length: 41 }, () => {
      const start = performance.now();
      lines = renderer.renderProgress(view, 100, options).length;
      return performance.now() - start;
    }).sort((a, b) => a - b);
    console.log(`${label}, ${name}: median ${samples[20].toFixed(3)} ms (${lines} lines)`);
  }
}
