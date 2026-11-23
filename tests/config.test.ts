import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { loadSettings, parseSettings } from "../config.ts";

test("partial settings validate types, colors and title controls independently", () => {
  const { frames, footer } = parseSettings({
    frames: { agentAnswer: { title: "Good\n\x1b[31manswer\x1b[0m", color: "#aa33cc", enabled: false },
      userPrompt: { color: "bad", enabled: "false" }, agentActivity: null },
    footer: { cwd: false, context: "false", received: false },
  });
  assert.deepEqual(frames.agentAnswer, { title: "Good answer", color: "#aa33cc", enabled: false });
  assert.deepEqual(frames.userPrompt, { title: "User prompt", color: "#595959", enabled: true });
  assert.equal(frames.agentActivity.enabled, true);
  assert.equal(footer.cwd, false);
  assert.equal(footer.context, true);
  assert.equal(footer.received, false);
});

test("load reads a BOM JSON file and falls back on missing or malformed content", () => {
  const directory = mkdtempSync(join(tmpdir(), "clear-pi-"));
  const file = join(directory, "config.json");
  const url = pathToFileURL(file);
  try {
    assert.deepEqual(loadSettings(url).settings, parseSettings(undefined));
    assert.equal(loadSettings(url).warning, undefined);
    writeFileSync(file, '\uFEFF{"footer":{"codexQuota":false}}');
    assert.equal(loadSettings(url).settings.footer.codexQuota, false);
    writeFileSync(file, "not JSON");
    assert.deepEqual(loadSettings(url).settings, parseSettings(undefined));
    assert.match(loadSettings(url).warning ?? "", /config\.json/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
