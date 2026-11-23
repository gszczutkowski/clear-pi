import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { defaultFooter, loadSettings, parseSettings } from "../config.ts";

test("partial settings validate types, colors and title controls independently", () => {
  const { frames, footer } = parseSettings({
    frames: { agentAnswer: { title: "Good\n\x1b[31manswer\x1b[0m", color: "#aa33cc", enabled: false },
      userPrompt: { color: "bad", enabled: "false" }, agentActivity: null },
    footer: { cwd: false, context: "false", received: false },
  });
  assert.deepEqual(frames.agentAnswer, { title: "Good answer", color: "#aa33cc", enabled: false });
  assert.deepEqual(frames.userPrompt, { title: "User prompt", color: "#595959", enabled: true });
  assert.equal(frames.agentActivity.enabled, true);
  assert.deepEqual(footer.cwd, { ...defaultFooter.cwd, enabled: false });
  assert.deepEqual(footer.context, defaultFooter.context);
  assert.deepEqual(footer.received, { ...defaultFooter.received, enabled: false });
});

test("load reads a BOM JSON file and falls back on missing or malformed content", () => {
  const directory = mkdtempSync(join(tmpdir(), "clear-pi-"));
  const file = join(directory, "config.json");
  const url = pathToFileURL(file);
  try {
    assert.deepEqual(loadSettings(url).settings, parseSettings(undefined));
    assert.equal(loadSettings(url).warning, undefined);
    writeFileSync(file, '\uFEFF{"footer":{"codexQuota":false}}');
    assert.deepEqual(loadSettings(url).settings.footer.codexQuota, { ...defaultFooter.codexQuota, enabled: false });
    writeFileSync(file, "not JSON");
    assert.deepEqual(loadSettings(url).settings, parseSettings(undefined));
    assert.match(loadSettings(url).warning ?? "", /config\.json/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("footer icons support Unicode and empty values, validate separately from visibility, and match the shipped config", () => {
  const { footer } = parseSettings({ footer: {
    cwd: { enabled: false, icon: "📁" }, context: { enabled: "no", icon: "" },
    gitBranch: { enabled: false, icon: "\x1b]8;;https://invalid.example\x07" },
    model: { icon: "\uD800" }, thinking: { icon: "x\u202e" },
    codexQuota: { enabled: true, icon: " ⏱️ " },
  } });
  assert.deepEqual(footer.cwd, { enabled: false, icon: "📁" });
  assert.deepEqual(footer.context, { enabled: true, icon: "" });
  assert.deepEqual(footer.gitBranch, { ...defaultFooter.gitBranch, enabled: false });
  assert.deepEqual(footer.model, defaultFooter.model);
  assert.deepEqual(footer.thinking, defaultFooter.thinking);
  assert.deepEqual(footer.codexQuota, { enabled: true, icon: "⏱️" });
  assert.deepEqual(loadSettings().settings.footer, defaultFooter);
});
