import { performance } from "node:perf_hooks";
import { AssistantMessageComponent, initTheme, ToolExecutionComponent, UserMessageComponent } from "@earendil-works/pi-coding-agent";
import { Container, Spacer, stripTerminalSequences, type TUI } from "@earendil-works/pi-tui";
import { parseSettings } from "../config.ts";
import { mountToolGroups } from "../tool-groups.ts";

initTheme("dark", false);
const theme = { fg: (_token: string, text: string) => text } as import("@earendil-works/pi-coding-agent").Theme;
const frames = parseSettings(undefined).frames;
const width = 100;
const warmup = 10;
const samples = 40;
const median = (elapsed: number[]) => {
  elapsed.sort((a, b) => a - b);
  return ((elapsed[(elapsed.length - 1) >> 1] + elapsed[elapsed.length >> 1]) / 2).toFixed(3);
};

function measure(chat: Container) {
  for (let i = 0; i < warmup; i++) chat.render(width);
  const elapsed = Array.from({ length: samples }, () => {
    const start = performance.now();
    chat.render(width);
    return performance.now() - start;
  });
  return median(elapsed);
}

function assistant(text: string, toolCallId?: string) {
  return new AssistantMessageComponent({ content: [
    { type: "text", text },
    ...(toolCallId ? [{ type: "toolCall", id: toolCallId, name: "read", arguments: { path: "src/index.ts" } }] : []),
  ], stopReason: toolCallId ? "toolUse" : "stop" } as Parameters<AssistantMessageComponent["updateContent"]>[0]);
}

console.log(`Node ${process.version}; median of ${samples} renders after ${warmup} warmups, width ${width}, no terminal or footer`);
console.log("turns\tnative (ms)\tframed (ms)\tactive widths\tafter one click (ms)\tassistant renders");
const activityText = "Checking **src/index.ts** for the current configuration.";
for (const turns of [20, 200, 500]) {
  const ui = Object.assign(new Container(), { requestRender() {} }) as unknown as TUI;
  const document = new Container();
  const chat = new Container();
  const activeActivity = assistant(activityText, String(turns));
  const assistantRows: AssistantMessageComponent[] = [];
  ui.addChild(document);
  for (const child of [new Container(), new Container(), chat]) document.addChild(child);
  for (let turn = 1; turn <= turns; turn++) {
    const id = String(turn);
    const tool = new ToolExecutionComponent("read", id, { path: "src/index.ts" }, {}, undefined, ui, process.cwd());
    tool.updateResult({ content: [{ type: "text", text: "export const ready = true;" }] });
    chat.addChild(new Spacer(1));
    chat.addChild(new UserMessageComponent(`Please check the configuration for turn ${turn}.`));
    const activity = turn === turns ? activeActivity : assistant(activityText, id);
    const answer = assistant("The configuration is correct. No changes are needed.");
    assistantRows.push(activity, answer);
    chat.addChild(activity);
    chat.addChild(tool);
    chat.addChild(answer);
  }
  const native = measure(chat);
  const unmount = mountToolGroups(ui, theme, () => false, frames);
  const framed = measure(chat);
  const widths: number[] = [];
  const render = activeActivity.render;
  activeActivity.render = (columns) => {
    widths.push(columns);
    return render.call(activeActivity, columns);
  };
  let lines = chat.render(width);
  const warmWidths = widths.join(", ");
  let assistantRenders = 0;
  for (const row of assistantRows) {
    const original = row.render;
    row.render = (columns) => { assistantRenders++; return original.call(row, columns); };
  }
  const afterClick: number[] = [];
  for (let i = 0; i < 7; i++) {
    const y = lines.findIndex(line => /[▸▾] Checking /.test(stripTerminalSequences(line)));
    const clicked = chat.handleMouse({ type: "click", button: "left", x: 2, y, screenX: 2, screenY: y,
      width, height: lines.length, shift: false, alt: false, ctrl: false });
    if (!clicked?.handled) throw new Error("Historical tool group click missed");
    assistantRenders = 0;
    const start = performance.now();
    lines = chat.render(width);
    afterClick.push(performance.now() - start);
  }
  unmount();
  console.log(`${turns}\t${native}\t\t${framed}\t\t[${warmWidths}]\t\t${median(afterClick)}\t\t\t${assistantRenders}`);
}
