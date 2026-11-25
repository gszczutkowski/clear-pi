import assert from "node:assert/strict";
import { test } from "node:test";
import { AssistantMessageComponent, CustomMessageComponent, initTheme, SkillInvocationMessageComponent, ToolExecutionComponent, UserMessageComponent, type Theme } from "@earendil-works/pi-coding-agent";
import { Container, foregroundAnsi, getCapabilities, getTerminalColorMode, parseColor, setCapabilities, stripTerminalSequences, Text, visibleWidth, type TUI, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { mountToolGroups } from "../tool-groups.ts";
import { parseSettings, type Settings, type TranscriptIcons } from "../config.ts";

initTheme("dark", false);
const theme = { fg: (_token: string, text: string) => text } as Theme;
const width = 80;

function setup(arrowTheme = theme) {
  const chat = new Container();
  const document = new Container();
  for (const child of [new Container(), new Container(), chat]) document.addChild(child);
  const ui = Object.assign(new Container(), { requests: 0, requestRender() { this.requests++; } });
  ui.addChild(document);
  const tui = ui as unknown as TUI;
  let globalExpanded = false;
  const mount = (frames?: Settings["frames"], icons?: TranscriptIcons) => mountToolGroups(tui, arrowTheme, () => globalExpanded, frames, icons);
  const setGlobal = (expanded: boolean) => {
    globalExpanded = expanded;
    for (const row of chat.children) if (row instanceof ToolExecutionComponent || row instanceof SkillInvocationMessageComponent
      || row instanceof CustomMessageComponent) row.setExpanded(expanded);
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

test("messages share activity in order and expand independently from ordinary tools", () => {
  const { chat, mount, assistant, tool, render, mouse, setGlobal } = setup();
  assistant("Before communication");
  tool("subagent", { name: "Worker", task: "Initial assignment\nHidden assignment detail" });
  chat.addChild(new CustomMessageComponent({ role: "custom", customType: "subagent_result", display: true,
    timestamp: 0, content: "Incoming report\nHidden report detail", details: { name: "Scout" } }));
  tool("subagent_resume", { name: "Reviewer", sessionPath: "/fixture", message: "Follow-up\nHidden follow-up detail" });
  tool("caller_ping", { message: "Need decision\nHidden decision detail" });
  tool("bash", { command: "echo ordinary" });
  const cleanup = mount(parseSettings(undefined).frames);
  let text = render().join("\n");
  assert.equal(render().filter(line => line.startsWith("╭")).length, 1);
  assert.match(text, /Before communication[\s\S]*sent the message to Worker: Initial assignment[\s\S]*received message from Scout: Incoming report[\s\S]*sent the message to Reviewer: Follow-up[\s\S]*sent the message to Parent: Need decision/);
  assert.doesNotMatch(text, /Hidden|echo ordinary/);
  const click = (name: string) => mouse(render().findIndex(line => line.includes(name)), { x: 3 });
  assert.equal(click("received message from Scout")?.handled, true);
  text = render().join("\n");
  assert.match(text, /Hidden report detail/);
  assert.doesNotMatch(text, /Hidden assignment|Hidden follow-up|echo ordinary/);
  assert.equal(click("sent the message to Reviewer")?.handled, true);
  assert.match(render().join("\n"), /Hidden follow-up detail/);
  setGlobal(true);
  assert.match(render().join("\n"), /Hidden assignment detail[\s\S]*Hidden report detail[\s\S]*Hidden follow-up detail[\s\S]*Hidden decision detail[\s\S]*echo ordinary/);
  setGlobal(false);
  assert.doesNotMatch(render().join("\n"), /Hidden|echo ordinary/);
  cleanup();
});

test("communication failures remain visible and expandable, and peer identities are distinct", () => {
  const { chat, tool, mount, render, mouse, setGlobal } = setup();
  tool("subagent", { name: "Alpha", agent: "worker", task: "Launch task" }).updateResult({
    content: [{ type: "text", text: "Launch denied" }], isError: true });
  tool("subagent_resume", { sessionPath: "/private/session.jsonl", message: "Continue task" }).updateResult({
    content: [{ type: "text", text: "Session unavailable" }], isError: true });
  for (const name of ["Alpha", "Beta"]) chat.addChild(new CustomMessageComponent({ role: "custom",
    customType: "subagent_result", content: "Report", display: true, timestamp: 0, details: { name, agent: "worker" } }));
  const cleanup = mount(parseSettings(undefined).frames);
  assert.match(render().join("\n"), /failed to send the message to Alpha: Launch task \[failed\]/);
  assert.match(render().join("\n"), /failed to send the message to Subagent: Continue task \[failed\]/);
  assert.match(render().join("\n"), /received message from Alpha \(worker\)[\s\S]*received message from Beta \(worker\)/);
  assert.doesNotMatch(render().join("\n"), /private\/session|Launch denied|Session unavailable/);
  mouse(render().findIndex(line => line.includes("failed to send the message to Alpha")), { x: 3 });
  assert.match(render().join("\n"), /Launch denied/);
  setGlobal(true);
  assert.match(render().join("\n"), /Session unavailable/);
  cleanup();
});

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
  const originals = [chat.render, chat.handleMouse, chat.invalidate, row.setExpanded];
  const cleanup = mount();
  for (let columns = 0; columns <= width; columns++) {
    const lines = render(columns);
    assert.equal(lines.length, columns === 0 ? 0 : 1);
    for (const line of lines) assert.ok(visibleWidth(line) <= columns);
  }
  assert.equal(mouse(0)?.handled, true);
  cleanup();
  cleanup();
  assert.deepEqual([chat.render, chat.handleMouse, chat.invalidate, row.setExpanded], originals);
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

test("non-expandable activity has a marker and three-column hanging indent", () => {
  const { mount, assistant, tool, render, mouse } = setup();
  const cleanup = mount(parseSettings(undefined).frames);
  assistant("Reading relevant docs");
  assistant("Usunę te komendy, zaktualizuję dokumentację i testy. Automatyczne odświeżanie limitów pozostanie bez zmian.");
  assistant("Running tests");
  tool("bash", { command: "npm test" });
  assistant("Done");
  try {
    const lines = render(48);
    const start = lines.findIndex(line => line.includes("\uF449 Usunę"));
    assert.ok(start >= 0);
    assert.ok(lines.some(line => line.includes("\uF449 Reading relevant docs")));
    assert.match(lines[start + 1], /^│ {3}\S/); // Two-column hanging indent plus frame padding.
    assert.match(lines[start + 2], /^│ {3}\S/);
    assert.ok(lines.some(line => line.includes("▸ Running tests")));
    assert.ok(lines.every(line => visibleWidth(line) <= 48));
    assert.equal(mouse(start, { x: 2 })?.handled, undefined);
    assert.ok(lines.some(line => line.includes("Done") && !line.includes("\uF449")));
  } finally { cleanup(); }
});

test("streaming activity keeps markers and puts a new tool arrow on the first wrapped line", () => {
  const { mount, assistant, tool, render, mouse } = setup();
  const cleanup = mount(parseSettings(undefined).frames);
  try {
    assistant("Reading relevant docs");
    const message = "Usunę te komendy, zaktualizuję dokumentację i testy. Automatyczne odświeżanie limitów oraz /clear-progress pozostaną bez zmian.";
    const pending = assistant(message);
    pending.updateContent({ content: [{ type: "text", text: message },
      { type: "toolCall", id: "pending", name: "bash", arguments: { command: "npm test" } }],
      stopReason: "toolUse" } as Parameters<typeof pending.updateContent>[0], true);
    let lines = render();
    assert.ok(lines.some(line => line.includes("\uF449 Reading relevant docs")));
    assert.ok(lines.some(line => line.includes("\uF449 Usunę")));
    tool("bash", { command: "npm test" });
    lines = render();
    const title = lines.findIndex(line => line.includes("▸ Usunę"));
    assert.ok(title >= 0);
    assert.match(lines[title + 1], /^│ {3}\S/);
    assert.ok(!lines[title + 1].includes("▸"));
    assert.ok(lines.some(line => line.includes("\uF449 Reading relevant docs")));
    assert.equal(mouse(title, { x: 2 })?.handled, true);
    lines = render();
    assert.ok(lines.some(line => line.includes("▾ Usunę")));
    assert.ok(lines.some(line => line.includes("npm test")));
    assert.ok(lines.every(line => visibleWidth(line) <= width));
  } finally { cleanup(); }
});

test("framed activity renders natively once at the wrapping width and routes mouse against that layout", (t) => {
  const { mount, assistant, tool, render, mouse } = setup();
  const cleanup = mount(parseSettings(undefined).frames);
  t.after(cleanup);
  assistant("Getting started");
  const activity = assistant("Checking " + "the configured output width ".repeat(6));
  const nativeRender = t.mock.method(activity, "render");
  const nativeMouse = t.mock.method(activity, "handleMouse");
  tool("bash", { command: "npm test" });
  const lines = render();
  const title = lines.findIndex((line) => line.includes("▸ Checking"));
  assert.ok(title >= 0);
  // Two outer margin cells, four border/padding cells, and one marker column.
  const nativeWidth = width - 7;
  assert.deepEqual(nativeRender.mock.calls.map(({ arguments: [columns] }) => columns), [nativeWidth]);
  assert.match(lines[title + 1], /^│ {3}\S/);
  mouse(title + 1, { x: 5 });
  assert.deepEqual(nativeMouse.mock.calls.map(({ arguments: [event] }) => [event.x, event.y, event.width]), [[2, 2, nativeWidth]]);
  assert.equal(mouse(title, { x: 2 })?.handled, true);
  assert.match(render().join("\n"), /▾ Checking[\s\S]*npm test/);
});

test("custom transcript icons decorate framed activity, thinking, and tool toggles", (t) => {
  for (const activity of ["*", ""]) {
    const { mount, assistant, tool, render, mouse } = setup();
    const cleanup = mount(parseSettings(undefined).frames, { activity, expanded: "v", collapsed: ">" });
    t.after(cleanup);
    tool("bash", { command: "echo fallback" });
    assistant("Standalone update");
    assistant("Expandable update");
    tool("bash", { command: "echo inline" });
    assistant("Done", "Final check");
    const lines = render();
    const expectedMarker = activity || " ";
    assert.ok(lines.some((line) => line.includes(`│ ${expectedMarker} Standalone update`)));
    assert.ok(lines.some((line) => line.includes(`│ ${expectedMarker} Final check`)));
    assert.doesNotMatch(lines.join("\n"), /[▸▾\uF449]/u);
    assert.equal(mouse(lines.findIndex((line) => line.includes("> Agent research")), { x: 2 })?.handled, true);
    assert.equal(mouse(render().findIndex((line) => line.includes("> Expandable update")), { x: 2 })?.handled, true);
    assert.match(render().join("\n"), /v Agent research[\s\S]*echo fallback[\s\S]*v Expandable update[\s\S]*echo inline/);
  }
});

test("custom arrows also work without frames", (t) => {
  const { mount, assistant, tool, render, mouse } = setup();
  t.after(mount(undefined, { activity: "*", expanded: "v", collapsed: ">" }));
  tool("bash", { command: "echo fallback" });
  assistant("Expandable update");
  tool("bash", { command: "echo inline" });
  assert.deepEqual(render(), ["> AI tools", "", "> Expandable update"]);
  assert.equal(mouse(2)?.handled, true);
  assert.match(render().join("\n"), /v Expandable update[\s\S]*echo inline/);
});

test("an image-first activity keeps raw transport and a separate clickable tool heading", (t) => {
  const { mount, assistant, tool, render, ui, mouse } = setup();
  t.after(mount(parseSettings(undefined).frames));
  const image = "\x1b_Ga=T;fixture\x1b\\";
  assistant("Illustrated update").render = () => ["", image, " Native caption"];
  tool("bash", { command: "echo result" });
  const raw = ui.render(width);
  assert.ok(raw.includes(image));
  assert.match(render().join("\n"), /\uF449 Native caption[\s\S]*▸ Agent research/);
  assert.equal(raw.filter((line) => line.includes("▸")).length, 1);
  assert.equal(mouse(raw.findIndex((line) => line.includes("▸ Agent research")), { x: 2 })?.handled, true);
  assert.match(render().join("\n"), /▾ Agent research[\s\S]*echo result/);
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

test("the prompt uses terminal defaults and the activity body uses one gray, with Agent research as the first fallback", () => {
  for (const appearance of ["light", "dark"] as const) {
    const { chat, ui, mount, tool, assistant, mouse, render } = setup({ ...theme, appearance } as Theme);
    const cleanup = mount(parseSettings(undefined).frames);
    const prompt = new UserMessageComponent("Prompt body");
    chat.addChild(prompt);
    tool("bash", { command: "echo first" }).updateResult({ content: [{ type: "text", text: "First result" }] });
    const wide = assistant("Wide status");
    wide.render = columns => [`\x1b[30;47m${"x".repeat(columns)}\x1b[0m`]; // Exercise a full-width native row.
    tool("bash", { command: "echo second" });
    const lines = render();
    assert.deepEqual(lines.filter(line => line.includes("▸")).map(line => line.match(/▸ [^│]+/)?.[0].trim()), ["▸ Agent research", `▸ ${"x".repeat(72)}`]);
    assert.equal(mouse(lines.findIndex(line => line.includes("Agent research")), { x: 2 })?.handled, true);
    const gray = foregroundAnsi(parseColor(appearance === "light" ? "#595959" : "#b0b0b0"), getTerminalColorMode());
    assert.ok(gray);
    const styled = ui.render(width);
    const promptLine = styled.find(line => line.includes("Prompt body"))!;
    assert.doesNotMatch(promptLine, /\x1b\[(?:48[;:]|4[0-7]m|10[0-7]m)/);
    for (const fragment of ["▾ Agent research", "echo first", "First result", "xxxx", "▸ xxxx"]) {
      const line = styled.find(line => stripTerminalSequences(line).includes(fragment))!;
      const body = line.slice(line.indexOf("│") + 1, line.lastIndexOf("│"));
      assert.ok(body.includes(gray));
      const rest = body.replace(/\x1b\[[\d;:]*m$/, "").replaceAll(gray, ""); // Exclude the right border's color.
      assert.doesNotMatch(rest, /\x1b\[(?:[34]8[;:]|[34][0-7]m|9[0-7]m|10[0-7]m)/);
    }
    cleanup();
  }
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
  assert.match(render().join("\n"), /Agent activity[\s\S]*I have received message from Resume \(worker\): Report/);
  assert.ok(!ui.render(width).join("\n").includes(sunset));
  card.setExpanded(true);
  assert.match(render().join("\n"), /Report/);
  cleanup();
  assert.match(render().join("\n"), /Message from Resume/);
  cleanup = mount({ ...frames, subagentMessage: { ...frames.subagentMessage, enabled: false } });
  assert.match(render().join("\n"), /Agent activity[\s\S]*Report/);
  cleanup();
});

function trackRenders(row: { render(width: number): string[] }) {
  const original = row.render;
  let calls = 0;
  row.render = (columns) => {
    calls++;
    return original.call(row, columns);
  };
  return () => calls;
}

test("completed framed fragments reuse lines at one width while the active turn stays live", () => {
  const { chat, mount, assistant, render } = setup();
  const firstPrompt = new UserMessageComponent("Cached prompt");
  chat.addChild(firstPrompt);
  const completed = assistant("Cached historical answer", "Historical thinking");
  const promptRenders = trackRenders(firstPrompt);
  const historyRenders = trackRenders(completed);
  chat.addChild(new UserMessageComponent("Next prompt"));
  const active = assistant("Active answer draft");
  const activeRenders = trackRenders(active);
  const cleanup = mount(parseSettings(undefined).frames);
  const first = render();
  const before = [promptRenders(), historyRenders(), activeRenders()];
  assert.ok(before.every((count) => count > 0));
  assert.deepEqual(render(), first);
  assert.deepEqual([promptRenders(), historyRenders()], before.slice(0, 2));
  assert.ok(activeRenders() > before[2]);
  active.updateContent({ content: [{ type: "text", text: "Updated active answer" }], stopReason: "stop" } as Parameters<typeof active.updateContent>[0], true);
  assert.match(render().join("\n"), /Cached historical answer[\s\S]*Updated active answer/);
  assert.equal(historyRenders(), before[1]);

  const resized = render(36);
  assert.ok(resized.every((line) => visibleWidth(line) <= 36));
  assert.ok(promptRenders() > before[0]);
  assert.ok(historyRenders() > before[1]);
  const afterResize = historyRenders();
  assert.deepEqual(render(36), resized);
  assert.equal(historyRenders(), afterResize);
  completed.setHiddenThinkingLabel("Hidden label");
  completed.setHideThinkingBlock(true);
  assert.match(render(36).join("\n"), /Hidden label/);
  assert.doesNotMatch(render(36).join("\n"), /Historical thinking/);
  assert.ok(historyRenders() > afterResize);
  cleanup();
});

test("cached historical tool groups refresh theme and expansion and route mouse to native rows", () => {
  let appearance: "light" | "dark" = "dark";
  const { chat, ui, mount, setGlobal, assistant, tool, render, mouse } = setup({
    ...theme, get appearance() { return appearance; },
  } as Theme);
  const styledArrow = (hex: string) => `${foregroundAnsi(parseColor(hex), getTerminalColorMode())}▸`;
  chat.addChild(new UserMessageComponent("First historical prompt"));
  const unaffected = trackRenders(assistant("Unaffected history"));
  chat.addChild(new UserMessageComponent("Historical prompt"));
  const activity = assistant("Historical progress");
  const row = tool("bash", { command: "echo historical" });
  row.updateResult({ content: [{ type: "text", text: "Historical tool result" }] });
  chat.addChild(new UserMessageComponent("Active prompt"));
  const count = trackRenders(activity);
  const cleanup = mount(parseSettings(undefined).frames);
  assert.ok(ui.render(width).some((line) => line.includes(styledArrow("#b0b0b0"))));
  const before = count();
  ui.render(width);
  assert.equal(count(), before);
  appearance = "light";
  ui.invalidate();
  assert.ok(ui.render(width).some((line) => line.includes(styledArrow("#595959"))));
  assert.ok(count() > before);
  const afterTheme = count();
  const unaffectedBeforeClicks = unaffected();
  assert.ok(unaffectedBeforeClicks > 0);
  const header = () => render().findIndex((line) => /[▸▾] Historical progress/.test(line));
  assert.equal(mouse(header(), { x: 2 })?.handled, true);
  assert.match(render().join("\n"), /▾ Historical progress[\s\S]*Historical tool result/);
  const result = render().findIndex((line) => line.includes("Historical tool result"));
  assert.equal(mouse(result, { x: 5 })?.handled, true);
  assert.equal(mouse(header(), { x: 2 })?.handled, true);
  assert.doesNotMatch(render().join("\n"), /Historical tool result/);
  assert.ok(count() > afterTheme);
  const recached = count();
  render();
  assert.equal(count(), recached);
  assert.equal(unaffected(), unaffectedBeforeClicks); // Individual toggles must not re-render unrelated history.
  setGlobal(true);
  assert.match(render().join("\n"), /▾ Historical progress[\s\S]*Historical tool result/);
  setGlobal(false);
  assert.doesNotMatch(render().join("\n"), /Historical tool result/);
  cleanup();
});

test("expanded historical tool images remain live and preserve raw Kitty transport", () => {
  const capabilities = getCapabilities();
  setCapabilities({ ...capabilities, images: "kitty" });
  const { chat, ui, mount, assistant, tool, render, mouse } = setup();
  const cleanup = mount(parseSettings(undefined).frames);
  try {
    chat.addChild(new UserMessageComponent("Use an image"));
    assistant("Historical image progress");
    const row = tool("read", { path: "pixel.png" });
    const data = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/rVgAAAAASUVORK5CYII=";
    row.updateResult({ content: [{ type: "image", mimeType: "image/png", data }] });
    chat.addChild(new UserMessageComponent("Later prompt"));
    const transport = () => ui.render(width).filter((line) => line.includes("\x1b_G"));
    assert.deepEqual(transport(), []);
    assert.equal(mouse(render().findIndex((line) => line.includes("▸ Historical image progress")), { x: 2 })?.handled, true);
    const lines = transport();
    assert.equal(lines.length, 1);
    assert.ok(lines[0].startsWith("\x1b_G")); // No frame, ANSI color or indentation before the sequence.
    assert.ok(lines[0].includes(data));
    row.setShowImages(false);
    assert.deepEqual(transport(), []);
    row.setShowImages(true);
    assert.equal(transport().length, 1);
  } finally {
    cleanup();
    setCapabilities(capabilities);
  }
});


test("skill and help notices expand independently by mouse and follow Ctrl+O", (t) => {
  const { chat, tui, render, mouse } = setup();
  chat.addChild(new SkillInvocationMessageComponent({ name: "release-create-notes", location: "/skill/SKILL.md",
    content: "Private skill instructions\n\nSecond paragraph", userMessage: undefined }));
  chat.addChild(new CustomMessageComponent({ role: "custom", customType: "subagent_ping", display: true, timestamp: 0,
    content: "native notice", details: { name: "F10.C kontynuacja testu styku", agent: "feature-coordinator", sessionFile: "/sessions/worker.jsonl",
      message: "R2 worker exited without structured output. " + "native/regression artifact ".repeat(12) + "\nSecond line of help.", keepOpen: true } }));
  let expanded = false;
  t.after(mountToolGroups(tui, theme, () => expanded, parseSettings(undefined).frames, undefined,
    () => "Use this skill to create release notes for a system fix version."));
  const text = () => render().join("\n");
  const fitted = () => {
    for (const columns of [1, 5, 8, 20, 80, 120]) assert.ok(render(columns).every((line) => visibleWidth(line) <= columns));
  };
  fitted();
  assert.match(text(), /▸ Skill invoked[\s\S]*Name: +release-create-notes[\s\S]*Description: +Use this skill/);
  assert.match(text(), /▸ I have received message from F10.C kontynuacja testu styku/);
  assert.doesNotMatch(text(), /Private skill instructions|Second line of help|worker\.jsonl|native notice/);
  assert.doesNotMatch(text(), /Needs help|Message from/);
  const heading = (title: string) => render().findIndex((line) => line.startsWith("╭") && line.includes(title));
  assert.equal(mouse(heading("Skill invoked"), { x: width - 1 }), undefined);
  assert.equal(mouse(heading("Skill invoked"), { x: 3, button: "right" }), undefined);
  assert.equal(mouse(heading("Skill invoked"), { x: 3 })?.handled, true);
  assert.match(text(), /▾ Skill invoked[\s\S]*Instructions: +Private skill instructions[\s\S]*Second paragraph/);
  assert.match(text(), /▸ I have received/);
  assert.equal(mouse(render().findIndex(line => line.includes("▸ I have received")), { x: 3 })?.handled, true);
  assert.match(text(), /▾ I have received[\s\S]*Second line of help/);
  assert.doesNotMatch(text(), /Preview:/);
  fitted();
  assert.equal(mouse(heading("Skill invoked"), { x: 3 })?.handled, true);
  assert.doesNotMatch(text(), /Private skill instructions/);
  assert.match(text(), /Second line of help/);
  expanded = true;
  assert.match(text(), /▾ Skill invoked[\s\S]*▾ I have received/);
  expanded = false;
  assert.match(text(), /▸ Skill invoked[\s\S]*▸ I have received/);
  assert.doesNotMatch(text(), /Private skill instructions|Second line of help/);
});

test("notice settings restore native rendering and customize titles and arrows independently", (t) => {
  const { chat, render, tui, setGlobal } = setup();
  chat.addChild(new SkillInvocationMessageComponent({ name: "skill-title", location: "/skill/SKILL.md",
    content: "Native expanded skill", userMessage: undefined }));
  chat.addChild(new CustomMessageComponent({ role: "custom", customType: "subagent_ping", display: true, timestamp: 0,
    content: "Native help fallback", details: {} }));
  chat.addChild(new CustomMessageComponent({ role: "custom", customType: "subagent_ping", display: true, timestamp: 0,
    content: "Original help text", details: { name: "worker", message: "Some help" } }));
  const settings = parseSettings({ transcriptNotices: { skill: { enabled: false }, help: { title: "Assistance" } },
    transcriptIcons: { collapsed: ">", expanded: "v" } });
  t.after(mountToolGroups(tui, theme, () => false, settings.frames, settings.transcriptIcons, undefined, settings.transcriptNotices));
  assert.match(render().join("\n"), /\[skill\].*skill-title[\s\S]*Native help fallback[\s\S]*> I have received message from worker: Some help/);
  setGlobal(true);
  assert.match(render().join("\n"), /Native expanded skill/);
});
