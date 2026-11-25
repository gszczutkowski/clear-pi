import assert from "node:assert/strict";

import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";

import { renderProgress, type ProgressRun, type ProgressView } from "../progress-view.ts";



const run = (id: string, summary?: string): ProgressRun => ({ id, name: id, role: "worker", task: "Feature", status: "RESULT REPORTED", summary, children: [] });

test("table counts all descendants independently of display limits and uses only root reports", () => {

  const root = run("abcdef012345", "Saved coordinator report");

  root.children = [run("hidden-child", "Never borrow this resolution")];

  const view: ProgressView = { title: "Plan", branch: "real-branch", tasks: [

    { id: "T1", title: "One", status: "in_review", runs: [root] },

    { id: "T2", title: "Two", status: "blocked", runs: [run("fedcba987654")] },

  ], unassigned: [] };

  for (const compact of [false, true]) {

    const output = renderProgress(view, 160, { compact, maxRuns: 1 }).join("\n");

    assert.match(output, /󰄬 2\/2 · 󱙺 3/);

    assert.match(output, /T1: in_review/);

    assert.match(output, /\u{F17A9} 󰢻/u);
    assert.doesNotMatch(output, /\/abcde worker/);

    assert.match(output, /Saved coordinator report/);

    assert.doesNotMatch(output, /hidden-child|Never borrow|Implemented|╭─ coordinator/);

    assert.match(output, /1 row hidden/);

  }

});

test("partial table reports remain unknown and absent results are not fabricated", () => {

  const view: ProgressView = { title: null, tasks: [], unassigned: [run("first"), { ...run("second"), status: "mystery" }] };

  const output = renderProgress(view, 140).join("\n");

  assert.match(output, /completed · —/);

  assert.match(output, /unknown · —/);

  assert.doesNotMatch(output, /Branch:|accepted +\|/);

});


test("operation rows sanitize saved content and remain whole at every terminal width", () => {
  const view: ProgressView = { title: null, tasks: [], unassigned: [
    { ...run("f17a9123", "Implemented GRC\n\u001b[31mready\u001b[0m\u202e"), name: "issue-implementation", model: "openai-codex/gpt-6.1-sol", thinking: "medium" },
    run("second"), run("third"), run("fourth"),
  ] };
  for (let width = 0; width <= 250; width++) {
    const lines = renderProgress(view, width, { compact: true });
    assert.ok(lines.length <= 10);
    assert.ok(lines.every(line => visibleWidth(line) <= width));
    assert.doesNotMatch(lines.join("\n"), /|‮/);
  }
  const lines = renderProgress(view, 140, { compact: true });
  assert.match(lines.join("\n"), /Implemented GRC ready/);
  assert.match(lines.join("\n"), /\u{F17A9} 󰢻  gpt-6.1-sol ·  medium/u);
  assert.match(lines.join("\n"), /1 row hidden/);
  assert.equal(lines.filter(line => line.includes("model unknown")).length, 2);
});
