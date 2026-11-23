import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  createAgentSessionFromServices, createAgentSessionRuntime, createAgentSessionServices, InteractiveMode,
  SessionManager, SettingsManager, type CreateAgentSessionServicesOptions, type ProviderConfig,
} from "@earendil-works/pi-coding-agent";
import { Container, stripTerminalSequences, Text, visibleWidth, type Terminal } from "@earendil-works/pi-tui";
import { parseSettings } from "../config.ts";
import { mountToolGroups } from "../tool-groups.ts";

const piEntry = import.meta.resolve("@earendil-works/pi-coding-agent");
// Resolve Pi's own ESM-only provider package, including hoisted npm layouts.
const providerImport = registerHooks({
  resolve(specifier, context, nextResolve) {
    return nextResolve(specifier, specifier === "@earendil-works/pi-ai" ? { ...context, parentURL: piEntry } : context);
  },
});
const { createAssistantMessageEventStream } = await import("@earendil-works/pi-ai");
providerImport.deregister();

test("installed Pi 1.6.0: streaming, fullscreen mouse, tree rebuild, regular mode and native fallback", { timeout: 15_000 }, async (t) => {
  const piVersion = JSON.parse(readFileSync(new URL("../package.json", piEntry), "utf8")).version;
  assert.equal(piVersion, "1.6.0");
  const cwd = mkdtempSync(join(tmpdir(), "clear-pi-transcript-"));
  const agentDir = join(cwd, "agent");
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  t.mock.method(globalThis, "fetch", () => { throw new Error("Pi transcript test must not use the network"); });
  process.env.PI_OFFLINE = "1";
  process.env.PI_CODING_AGENT_DIR = agentDir;
  writeFileSync(join(cwd, "fixture.txt"), "Real read result from fixture\n");

  let input!: (data: string) => void;
  let writes = "";
  const terminal: Terminal = {
    columns: 100, rows: 60, kittyProtocolActive: false,
    start(callback) { input = callback; }, stop() {}, async drainInput() {},
    write(data) { writes += data; }, moveBy() {}, hideCursor() {}, showCursor() {},
    clearLine() {}, clearFromCursor() {}, clearScreen() {}, setTitle() {}, setProgress() {}, setProgramStatus() {},
  };
  const { promise: allowFinish, resolve: finishFirstResponse } = Promise.withResolvers<void>();
  const provider = "clear-pi-fixture";
  const api = "clear-pi-fixture-stream";
  const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const model = { id: "fixture", name: "Fixture model", api, provider, baseUrl: "http://unused.invalid", reasoning: false,
    input: ["text" as const], cost, contextWindow: 8192, maxTokens: 1024 };
  const message = (text: string): Parameters<NonNullable<ProviderConfig["streamSimple"]>>[1]["messages"][number] & { role: "assistant" } => ({
    role: "assistant", content: [{ type: "text", text }], api, provider, model: model.id, stopReason: "stop", timestamp: Date.now(),
    usage: { ...cost, totalTokens: 0, cost: { ...cost, total: 0 } },
  });
  let requests = 0;
  const streamSimple: NonNullable<ProviderConfig["streamSimple"]> = () => {
    const stream = createAssistantMessageEventStream();
    const first = ++requests === 1;
    void (async () => {
      const response = message("");
      stream.push({ type: "start", partial: response });
      stream.push({ type: "text_start", contentIndex: 0, partial: response });
      const text = first ? "Streaming progress" : requests === 2 ? "Final answer from main branch" : "Later answer";
      response.content[0] = { type: "text", text };
      stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: response });
      if (first) {
        await allowFinish;
        response.content[0] = { type: "text", text: `${text}: reading fixture` };
        stream.push({ type: "text_delta", contentIndex: 0, delta: ": reading fixture", partial: response });
      }
      stream.push({ type: "text_end", contentIndex: 0, content: first ? `${text}: reading fixture` : text, partial: response });
      if (first) {
        const toolCall = { type: "toolCall" as const, id: "read-fixture", name: "read", arguments: { path: "fixture.txt" } };
        response.stopReason = "toolUse";
        response.content.push(toolCall);
        stream.push({ type: "toolcall_start", contentIndex: 1, partial: response });
        stream.push({ type: "toolcall_end", contentIndex: 1, toolCall, partial: response });
      }
      stream.push({ type: "done", reason: first ? "toolUse" : "stop", message: response });
      stream.end();
    })();
    return stream;
  };

  let exerciseFallback!: (assertNative: () => void) => void;
  const settingsManager = SettingsManager.inMemory({ theme: "dark", quietStartup: true, compaction: { enabled: false } });
  const frames = parseSettings(undefined).frames;
  const resourceLoaderOptions: CreateAgentSessionServicesOptions["resourceLoaderOptions"] = {
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
    extensionFactories: [(pi) => {
      pi.registerProvider(provider, { api, baseUrl: model.baseUrl, apiKey: "unused", models: [model], streamSimple });
      pi.on("session_start", (_event, ctx) => {
        ctx.ui.setFooter((tui, theme) => {
          const document = tui.children[0] as Container;
          const chat = document.children[2] as Container;
          const native = [chat.render, chat.handleMouse, chat.invalidate];
          const unmount = mountToolGroups(tui, theme, () => ctx.ui.getToolsExpanded(), frames);
          assert.notEqual(chat.render, native[0]);
          exerciseFallback = (assertNative) => {
            unmount();
            assert.deepEqual([chat.render, chat.handleMouse, chat.invalidate], native);
            const unknownLayout = new Text("unexpected document child", 0, 0);
            document.addChild(unknownLayout);
            try {
              mountToolGroups(tui, theme, () => ctx.ui.getToolsExpanded(), frames)();
              assert.deepEqual([chat.render, chat.handleMouse, chat.invalidate], native);
              tui.requestRender();
              assertNative();
            } finally {
              document.removeChild(unknownLayout);
            }
            tui.requestRender();
          };
          return { render: () => [], invalidate() {}, dispose: unmount };
        });
      });
      pi.registerCommand("fixture-tree", { description: "Navigate fixture tree without a summary", handler: async (id, ctx) => {
        const result = await ctx.navigateTree(id, { summarize: false });
        assert.equal(result.cancelled, false);
      } });
    }],
  };
  const manager = SessionManager.inMemory(cwd);
  manager.appendMessage({ role: "user", content: "Shared prompt", timestamp: Date.now() });
  const shared = manager.appendMessage(message("Shared answer"));
  manager.appendMessage({ role: "user", content: "Alternate branch prompt", timestamp: Date.now() });
  const alternate = manager.appendMessage(message("Alternate branch answer"));
  manager.branch(shared);
  const runtime = await createAgentSessionRuntime(async ({ sessionManager, sessionStartEvent }) => {
    const services = await createAgentSessionServices({ cwd, agentDir, settingsManager, resourceLoaderOptions });
    assert.deepEqual(services.diagnostics, []);
    const result = await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, model, tools: ["read"] });
    return { ...result, services, diagnostics: services.diagnostics };
  }, { cwd, agentDir, sessionManager: manager });
  const mode = new InteractiveMode(runtime, { terminal, tuiMode: "fullscreen" });
  const interactive = mode as unknown as {
    renderer: { renderNow(): void; getScreenLines(): string[] };
    switchTuiMode(mode: "regular" | "fullscreen"): boolean;
  };
  const screen = () => {
    interactive.renderer.renderNow();
    return interactive.renderer.getScreenLines().map(stripTerminalSequences);
  };
  const text = () => screen().join("\n");
  const switchBranch = (id: string) => runtime.session.prompt(`/fixture-tree ${id}`);
  let main: Promise<void> | undefined;
  try {
    await mode.init();
    assert.match(writes, /\x1b\[\?1049h/);
    assert.equal(typeof exerciseFallback, "function", stripTerminalSequences(writes));
    assert.match(text(), /User prompt[\s\S]*Shared prompt[\s\S]*Agent answer[\s\S]*Shared answer/);
    assert.doesNotMatch(text(), /Alternate branch/);
    main = runtime.session.prompt("Main branch prompt");
    for (let retry = 0; retry < 100 && !text().includes("Streaming progress"); retry++) await delay(10);
    assert.match(text(), /Streaming progress/);
    assert.doesNotMatch(text(), /reading fixture|Final answer from main branch/);
    finishFirstResponse();
    await main;
    assert.match(text(), /▸ Streaming progress: reading fixture[\s\S]*Final answer from main branch/);
    assert.doesNotMatch(text(), /Real read result from fixture/);
    await runtime.session.prompt("Later prompt seals the main turn");
    assert.ok(screen().some((line) => line.includes("▸ Streaming progress")));

    const lines = screen();
    const y = lines.findIndex((line) => line.includes("▸ Streaming progress"));
    const x = visibleWidth(lines[y].split("▸")[0]);
    input(`\x1b[<0;${x + 1};${y + 1}M`);
    input(`\x1b[<0;${x + 1};${y + 1}m`);
    assert.match(text(), /▾ Streaming progress[\s\S]*Real read result from fixture/);
    assert.equal(requests, 3);

    const mainLeaf = manager.getLeafId();
    assert.ok(mainLeaf);
    await switchBranch(alternate);
    assert.match(text(), /User prompt[\s\S]*Alternate branch prompt[\s\S]*Alternate branch answer/);
    assert.doesNotMatch(text(), /Streaming progress|Real read result from fixture|Later prompt/);
    await switchBranch(mainLeaf);
    assert.match(text(), /▸ Streaming progress[\s\S]*Final answer from main branch/);
    assert.doesNotMatch(text(), /Real read result from fixture|Alternate branch/);
    writes = "";
    assert.equal(interactive.switchTuiMode("regular"), true);
    interactive.renderer.renderNow();
    assert.match(stripTerminalSequences(writes), /▸ Streaming progress[\s\S]*Final answer from main branch/);
    assert.equal(interactive.switchTuiMode("fullscreen"), true);
    exerciseFallback(() => {
      assert.match(text(), /Streaming progress[\s\S]*read fixture\.txt[\s\S]*Final answer from main branch/);
      assert.doesNotMatch(text(), /User prompt.*─|Agent (activity|answer).*─|[▸▾] Streaming progress|Real read result from fixture/);
    });
    input("\x0f"); // The real Ctrl+O binding still expands the native read card.
    assert.match(text(), /read fixture\.txt[\s\S]*Real read result from fixture/);
  } finally {
    finishFirstResponse();
    await main?.catch(() => {});
    mode.stop();
    await runtime.dispose();
  }
});
