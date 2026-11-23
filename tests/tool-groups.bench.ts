import { performance } from "node:perf_hooks";
import { AssistantMessageComponent, initTheme, ToolExecutionComponent, UserMessageComponent } from "@earendil-works/pi-coding-agent";
import { Container, Spacer, type TUI } from "@earendil-works/pi-tui";
import { parseSettings } from "../config.ts";
import { mountToolGroups } from "../tool-groups.ts";

initTheme("dark", false);
const theme = { fg: (_token: string, text: string) => text } as import("@earendil-works/pi-coding-agent").Theme;
const frames = parseSettings(undefined).frames;
const width = 100;
const warmup = 10;
const samples = 40;

function measure(chat: Container) {
  for (let i = 0; i < warmup; i++) chat.render(width);
  const elapsed = Array.from({ length: samples }, () => {
    const start = performance.now();
    chat.render(width);
    return performance.now() - start;
  }).sort((a, b) => a - b);
  return ((elapsed[samples / 2 - 1] + elapsed[samples / 2]) / 2).toFixed(3);
}

function assistant(text: string, toolCallId?: string) {
  return new AssistantMessageComponent({ content: [
    { type: "text", text },
    ...(toolCallId ? [{ type: "toolCall", id: toolCallId, name: "read", arguments: { path: "src/index.ts" } }] : []),
  ], stopReason: toolCallId ? "toolUse" : "stop" } as Parameters<AssistantMessageComponent["updateContent"]>[0]);
}

console.log(`Node ${process.version}; median of ${samples} renders after ${warmup} warmups, width ${width}, no terminal or footer`);
console.log("turns\tnative (ms)\tframed (ms)");
for (const turns of [20, 200, 500]) {
  const ui = new Container() as TUI;
  const document = new Container();
  const chat = new Container();
  ui.addChild(document);
  for (const child of [new Container(), new Container(), chat]) document.addChild(child);
  for (let turn = 1; turn <= turns; turn++) {
    const id = String(turn);
    const tool = new ToolExecutionComponent("read", id, { path: "src/index.ts" }, {}, undefined, ui, process.cwd());
    tool.updateResult({ content: [{ type: "text", text: "export const ready = true;" }] });
    chat.addChild(new Spacer(1));
    chat.addChild(new UserMessageComponent(`Please check the configuration for turn ${turn}.`));
    chat.addChild(assistant("Checking **src/index.ts** for the current configuration.", id));
    chat.addChild(tool);
    chat.addChild(assistant("The configuration is correct. No changes are needed."));
  }
  const native = measure(chat);
  const unmount = mountToolGroups(ui, theme, () => false, frames);
  const framed = measure(chat);
  unmount();
  console.log(`${turns}\t${native}\t\t${framed}`);
}
