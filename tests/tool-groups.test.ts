import assert from "node:assert/strict";
import { test } from "node:test";
import { AssistantMessageComponent, CustomMessageComponent, initTheme, ToolExecutionComponent, UserMessageComponent, type Theme } from "@earendil-works/pi-coding-agent";
import { Container, stripTerminalSequences, Text, visibleWidth, type TUI, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { mountToolGroups } from "../tool-groups.ts";
import { parseSettings, type Settings } from "../config.ts";

initTheme("dark", false);
const theme = { fg: (_token: string, text: string) => text } as Theme;
const width = 80;

function setup() {
  const chat = new Container();
  const document = new Container();
  for (const child of [new Container(), new Container(), chat]) document.addChild(child);
  const ui = Object.assign(new Container(), { requests: 0, requestRender() { this.requests++; } });
  ui.addChild(document);
  const tui = ui as unknown as TUI;
  let globalExpanded = false;
  const mount = (frames?: Settings["frames"]) => mountToolGroups(tui, theme, () => globalExpanded, frames);
  const setGlobal = (expanded: boolean) => {
    globalExpanded = expanded;
    for (const row of chat.children) if (row instanceof ToolExecutionComponent) row.setExpanded(expanded);
  };
  let nextId = 0;
  const tool = (name: string, args: Record<string, unknown>) => {
    const row = new ToolExecutionComponent(name, String(++nextId), args, {}, undefined, tui, process.cwd());
    row.setExpanded(globalExpanded);
    chat.addChild(row);
    return row;
  };
  const assistant = (text = "", thinking = "") => {
    const row = new AssistantMessageComponent();
    const content = [
      ...(thinking ? [{ type: "thinking", thinking }] : []),
      ...(text ? [{ type: "text", text }] : []),
    ];
    row.updateContent({ content, stopReason: "stop" } as Parameters<typeof row.updateContent>[0]);
    chat.addChild(row);
    return row;
  };
  const render = (columns = width) => ui.render(columns).map((line) => stripTerminalSequences(line).trimEnd());
  const mouse = (y: number, overrides: Partial<TuiMouseEvent> = {}) => ui.handleMouse({
    type: "click", button: "left", x: 0, y, screenX: 0, screenY: y,
    width, height: render().length, shift: false, alt: false, ctrl: false, ...overrides,
  });
  return { chat, ui, tui, mount, setGlobal, tool, assistant, render, mouse };
}
const headings = (lines: string[]) => lines.filter((line) => /^[▸▾]/u.test(line));

test("uses visible progress as independent headings and merges intervening tool-only rounds", () => {
  const { chat, ui, mount, tool, assistant, render, mouse } = setup();
  chat.addChild(new Text("User prompt", 0, 0));
  assistant("Patching setExpanded sync");
  const bash = tool("bash", { command: "echo one" });
  const cleanup = mount();
  bash.updateResult({ content: [{ type: "text", text: "First command result" }] });
  assistant();
  tool("read", { path: "README.md" }).updateResult({ content: [{ type: "text", text: "File contents" }] });
  assistant("", "Checking loader return types");
  tool("bash", { command: "echo two" }).updateResult({ content: [{ type: "text", text: "Example failure" }], isError: true });
  assistant();
  tool("bash", { command: "echo three" });
  assistant("Improving cleanup test");
  assistant("Saving milestone");
  tool("write", { path: "note.md" });
  assistant("Final answer");

  assert.deepEqual(render(), ["User prompt", "", "▸ Patching setExpanded sync", "▸ Checking loader return types",
    " Improving cleanup test", "▸ Saving milestone", "", " Final answer"]);
  assert.equal(mouse(2, { type: "wheel", button: "none", wheelDelta: 1 }), undefined);
  assert.equal(mouse(2, { button: "right" }), undefined);
  assert.equal(mouse(2, { x: 70 }), undefined);
  const requestsBeforeClick = ui.requests;
  assert.equal(mouse(2)?.handled, true);
  assert.equal(ui.requests, requestsBeforeClick + 1);
  let lines = render();
  assert.deepEqual(headings(lines), ["▾ Patching setExpanded sync", "▸ Checking loader return types", "▸ Saving milestone"]);
  assert.match(lines.join("\n"), /echo one[\s\S]*First command result[\s\S]*README\.md[\s\S]*File contents/);
  assert.doesNotMatch(lines.join("\n"), /echo two|Example failure/);
  assert.equal(mouse(lines.indexOf("▸ Checking loader return types"))?.handled, true);
  assert.equal(mouse(2)?.handled, true);
  lines = render();
  assert.deepEqual(headings(lines), ["▸ Patching setExpanded sync", "▾ Checking loader return types", "▸ Saving milestone"]);
  assert.match(lines.join("\n"), /echo two[\s\S]*Example failure[\s\S]*echo three/);
  assert.doesNotMatch(lines.join("\n"), /echo one|note\.md/);
  cleanup();
});

test("streaming updates stay in native cards and a heading can appear after a tool", () => {
  const { mount, tool, assistant, render, mouse } = setup();
  const cleanup = mount();
  const update = assistant();
  const row = tool("bash", { command: "echo before" });
  row.updateArgs({ command: "echo after" });
  row.markExecutionStarted();
  row.updateResult({ content: [{ type: "text", text: "Partial output" }] }, true);
  assert.deepEqual(render(), ["▸ AI tools"]);
  assert.equal(mouse(0)?.handled, true);
  assert.match(render().join("\n"), /echo after[\s\S]*Partial output/);
  update.updateContent({ content: [{ type: "text", text: "Running checks" }], stopReason: "stop" } as Parameters<typeof update.updateContent>[0]);
  row.updateResult({ content: [{ type: "text", text: "Complete output" }] });
  const resultIndex = render().findIndex((line) => line.includes("Complete output"));
  assert.ok(resultIndex > 0);
  assert.equal(mouse(resultIndex)?.handled, true);
  assert.deepEqual(headings(render()), ["▾ Running checks"]);
  assert.equal(mouse(1)?.handled, true);
  assert.deepEqual(render(), ["", "▸ Running checks"]);
  cleanup();
});

test("global expansion resets local overrides and rebuilds do not retain them", () => {
  const { chat, mount, setGlobal, tool, render, mouse } = setup();
  const cleanup = mount();
  tool("bash", { command: "echo first" });
  assert.equal(mouse(0)?.handled, true);
  tool("bash", { command: "echo next" });
  assert.deepEqual(headings(render()), ["▾ AI tools"]);
  assert.match(render().join("\n"), /echo next/);
  setGlobal(true);
  assert.deepEqual(headings(render()), ["▾ AI tools"]);
  assert.equal(mouse(0)?.handled, true);
  assert.deepEqual(render(), ["▸ AI tools"]);
  setGlobal(false);
  setGlobal(true);
  assert.deepEqual(headings(render()), ["▾ AI tools"]);
  assert.equal(mouse(0)?.handled, true);

  chat.clear();
  tool("bash", { command: "echo new branch" });
  assert.deepEqual(headings(render()), ["▾ AI tools"]);
  assert.match(render().join("\n"), /echo new branch/);
  assert.doesNotMatch(render().join("\n"), /echo first/);
  cleanup();
});

test("narrow headers fit, unmount restores native methods, and unknown layouts do nothing", () => {
  const { chat, tui, mount, tool, render, mouse } = setup();
  const row = tool("bash", { command: "echo original" });
  const originals = [chat.render, chat.handleMouse, row.setExpanded];
  const cleanup = mount();
  for (let columns = 0; columns <= width; columns++) {
    const lines = render(columns);
    assert.equal(lines.length, columns === 0 ? 0 : 1);
    for (const line of lines) assert.ok(visibleWidth(line) <= columns);
  }
  assert.equal(mouse(0)?.handled, true);
  cleanup();
  cleanup();
  assert.deepEqual([chat.render, chat.handleMouse, row.setExpanded], originals);
  assert.match(render().join("\n"), /echo original/);
  assert.deepEqual(headings(render()), []);
  tui.children.unshift(new Text("Unexpected layout", 0, 0));
  const ignored = mount();
  assert.equal(chat.render, originals[0]);
  ignored();
});

test("only visible lines become titles, and groups do not cross user messages", () => {
  const { chat, mount, tool, assistant, render, mouse } = setup();
  const cleanup = mount();
  const hidden = assistant("", "Hidden thinking");
  hidden.setHiddenThinkingLabel("");
  hidden.setHideThinkingBlock(true);
  tool("bash", { command: "echo hidden" });
  chat.addChild(new Text("Next prompt", 0, 0));
  assistant("First line\n\n**Second line** with Unicode 🧪");
  tool("bash", { command: "echo visible" });
  const lines = render();
  assert.deepEqual(headings(lines), ["▸ AI tools", "▸ Second line with Unicode 🧪"]);
  assert.ok(lines.includes(" First line"));
  assert.doesNotMatch(lines.join("\n"), /Hidden thinking/);
  assert.equal(mouse(lines.indexOf("▸ Second line with Unicode 🧪"))?.handled, true);
  assert.match(render().join("\n"), /echo visible/);
  assert.doesNotMatch(render().join("\n"), /echo hidden/);
  cleanup();
});

test("frames prompt, grouped activity, and answer; preserves mouse coordinates", () => {
  const { chat, ui, mount, tool, assistant, render, mouse } = setup();
  const frames = parseSettings(undefined).frames;
  const cleanup = mount(frames);
  chat.addChild(new UserMessageComponent("Check the project 🧪"));
  assistant("Running checks");
  tool("bash", { command: "echo first" }).updateResult({ content: [{ type: "text", text: "Done" }] });
  assistant();
  tool("bash", { command: "echo next" });
  assistant("Everything passed", "One last check");
  chat.addChild(new UserMessageComponent("Next question"));
  assistant("Second answer");
  const lines = render();
  assert.deepEqual(lines.filter((line) => line.startsWith("╭")).map((line) => line.match(/^╭─ (.*?) ─/)?.[1]),
    ["User prompt", "Agent activity", "Agent answer", "User prompt", "Agent answer"]);
  assert.match(lines.join("\n"), /User prompt[\s\S]*Check the project[\s\S]*Agent activity[\s\S]*▸ Running checks[\s\S]*One last check[\s\S]*Agent answer[\s\S]*Everything passed/);
  const rendered = ui.render(width).filter((line) => stripTerminalSequences(line).startsWith("╭"));
  assert.equal(new Set(rendered.slice(0, 3).map((line) => line.split("╭")[0])).size, 3);
  const arrowLine = lines.findIndex((line) => line.includes("▸ Running checks"));
  assert.equal(mouse(arrowLine, { x: 0 }), undefined);
  assert.equal(mouse(arrowLine, { x: 2 })?.handled, true);
  assert.match(render().join("\n"), /▾ Running checks[\s\S]*echo first[\s\S]*echo next/);
  assert.equal(mouse(render().findIndex((line) => line.includes("Done")), { x: 5 })?.handled, true);
  for (let columns = 1; columns <= width; columns++) {
    assert.ok(ui.render(columns).every((line) => visibleWidth(line) <= columns), `overflow at ${columns}`);
  }
  cleanup();
});

test("adopts the upstream subagent frame without replacing its native content", () => {
  const { chat, mount, render, ui } = setup();
  const sunset = "\x1b[38;2;214;158;46m";
  const reset = "\x1b[0m";
  const old = (_message: unknown, { expanded }: { expanded: boolean }) => ({ invalidate() {}, render(columns: number) {
    const content = expanded ? "Full report" : "Report";
    const title = "─ Message from Resume (worker) ";
    return [`${sunset}╭${title}${"─".repeat(columns - title.length - 2)}╮${reset}`,
      `${sunset}│${reset}${content}${" ".repeat(columns - content.length - 2)}${sunset}│${reset}`,
      `${sunset}╰${"─".repeat(columns - 2)}╯${reset}`];
  } });
  const card = new CustomMessageComponent({ role: "custom", customType: "subagent_result", content: "Report", display: true,
    details: { name: "Resume", agent: "worker" }, timestamp: 0 }, old);
  chat.addChild(card);
  const frames = parseSettings({ frames: { subagentMessage: { title: "Agent: {sender}", color: "#E00078" } } }).frames;
  let cleanup = mount(frames);
  assert.equal(render().filter((line) => line.startsWith("╭")).length, 1);
  assert.match(render().join("\n"), /Agent: Resume \(worker\)[\s\S]*Report/);
  assert.ok(!ui.render(width).join("\n").includes(sunset));
  card.setExpanded(true);
  assert.match(render().join("\n"), /Full report/);
  cleanup();
  assert.match(render().join("\n"), /Message from Resume/);
  cleanup = mount({ ...frames, subagentMessage: { ...frames.subagentMessage, enabled: false } });
  assert.doesNotMatch(render().join("\n"), /[╭│╯]/);
  assert.match(render().join("\n"), /Full report/);
  cleanup();
});
