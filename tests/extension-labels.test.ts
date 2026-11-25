import assert from "node:assert/strict";
import { test } from "node:test";
import { Container, Text, type TUI } from "@earendil-works/pi-tui";
import { compactExtensionText, extensionName, mountExtensionLabels } from "../extension-labels.ts";

test("compact extension names are generic", () => {
  const before = "@buyong/pi-codex-image-gen@0.3.3:dist, clear-pi, job-done.ts, kiro-tool-compat.ts, pi-provider-kiro:dist, subagents, youtube-summary";
  const after = "pi-codex-image-gen, clear-pi, job-done, kiro-tool-compat, pi-provider-kiro, subagents, youtube-summary";
  assert.equal(compactExtensionText(`[Extensions]\n  ${before}`), `[Extensions]\n  ${after}`);
  for (const [label, expected] of [
    ["@new-scope/new-package@2.0.0-beta.1:lib/main.js", "new-package"],
    ["new-package:src/other.ts", "new-package"],
    ["tools/my.extension.mjs", "my.extension"],
    ["C:\\tools\\my-plugin\\index.ts", "my-plugin"],
    ["nested/plugin/index.js", "plugin"],
    ["plugin.cjs", "plugin"],
  ]) assert.equal(extensionName(label!), expected);
});

test("keeps colors and leaves other resource sections untouched", () => {
  assert.equal(compactExtensionText("\x1b[35m[Extensions]\x1b[0m\n\x1b[2m  plugin.ts, @scope/pkg@latest:build\x1b[0m"),
    "\x1b[35m[Extensions]\x1b[0m\n\x1b[2m  plugin, pkg\x1b[0m");
  const skills = "[Skills]\n  skill.ts";
  assert.equal(compactExtensionText(skills), skills);
});

class ResourceText extends Text {
  state = { expanded: false };
  build = () => this.state.expanded ? "[Extensions]\n  /full/path/plugin.ts" : "[Extensions]\n  plugin.ts";
  render(width: number) { this.setText(this.build()); return super.render(width); }
}

test("adapts dynamically added rows, preserves expanded details and cleans up", () => {
  const tui = new Container();
  const document = new Container();
  const resources = new Container();
  document.addChild(new Container()); document.addChild(resources); document.addChild(new Container());
  tui.addChild(document);
  const nativeRender = resources.render;
  const dispose = mountExtensionLabels(tui as TUI);
  const row = new ResourceText("", 0, 0);
  const original = row.build;
  resources.addChild(row);
  const rendered = () => resources.render(100).map((line) => line.trimEnd()).join("\n");
  assert.equal(rendered(), "[Extensions]\n  plugin");
  row.state.expanded = true;
  assert.match(resources.render(100).join("\n"), /\/full\/path\/plugin.ts/);
  row.state.expanded = false;
  row.invalidate();
  assert.equal(rendered(), "[Extensions]\n  plugin");
  dispose(); dispose();
  assert.equal(resources.render, nativeRender);
  assert.equal(row.build, original);
  assert.equal(rendered(), "[Extensions]\n  plugin.ts");
});

test("unknown document layouts stay untouched", () => {
  const tui = new Container();
  const original = tui.render;
  mountExtensionLabels(tui as TUI)();
  assert.equal(tui.render, original);
});
