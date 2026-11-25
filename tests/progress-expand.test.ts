import assert from "node:assert/strict";
import test from "node:test";
import { renderProgress, type ProgressView } from "../progress-view.ts";

for (const mode of ["Solo", "Agents", "Coordinated"]) {
  test(`expand reveals omitted ${mode} summary rows without detailed cards`, () => {
    const view: ProgressView = { title: "Plan", unassigned: [], tasks: Array.from({ length: 12 }, (_, i) => ({
      id: `T${i + 1}`, title: `Feature ${i + 1}`, status: "pending",
      runs: mode === "Solo" ? [] : [{ id: `run-${i}`, name: `Operation ${i + 1}`, task: "Task", status: "SAVED",
        role: mode === "Agents" ? "worker" : "coordinator", summary: "Feedback", children: [] }],
    })) };
    const compact = renderProgress(view, 160, { compact: true, details: false }).join("\n");
    const expanded = renderProgress(view, 160, { compact: false, details: false }).join("\n");
    if (mode === "Solo") { assert.equal(compact, ""); assert.equal(expanded, ""); return; }
    assert.match(compact, /hidden/);
    assert.doesNotMatch(expanded, /hidden|Result:|╭─ Task/);
    assert.match(expanded, /T12|Operation 12/);
    assert.ok(expanded.split("\n").length > compact.split("\n").length);
  });
}
