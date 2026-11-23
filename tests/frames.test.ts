import assert from "node:assert/strict";
import test from "node:test";
import { stripTerminalSequences as strip, visibleWidth } from "@earendil-works/pi-tui";
import { frameContentLine, frameWidth } from "../frame-layout.ts";
import { framed, subagentFrame } from "../frames.ts";
import { renderProgress } from "../progress-view.ts";

const options = { enabled: true, title: "User prompt", color: "#595959" };
const amber = "\x1b[38;2;214;158;46m", reset = "\x1b[0m";

test("native frames reserve scrollbar columns and keep every right border after hostile/wide content", () => {
  const child: any = { invalidate() {}, render: () => [
    "", "\x1b[31mText\t界面 👩‍💻\x1b[0m", "\x1b[99Ccursor\x1b[2K\rcontent", "long ".repeat(100),
    "\x1b]8;;https://example.invalid\x07link\x1b]8;;\x07",
  ] };
  const frame = framed(child, options);
  for (let width = 0; width <= 250; width++) {
    const lines = frame.render(width);
    for (const line of lines) assert.ok(visibleWidth(line) <= frameWidth(width));
    if (width >= 5) {
      assert.ok(strip(lines[0]).endsWith("╮"));
      assert.ok(strip(lines.at(-1)!).endsWith("╯"));
      for (const line of lines.slice(1, -1)) {
        assert.ok(strip(line).endsWith("│"));
        assert.equal(visibleWidth(line), frameWidth(width));
        assert.doesNotMatch(line, /\t|\r|\x1b\[99C|\x1b\[2K/);
      }
    }
  }
});

test("line normalization preserves SGR and hyperlinks while expanding tabs at measured columns", () => {
  const styled = "\x1b[31m界\tB\x1b[0m";
  assert.equal(strip(frameContentLine(styled)), "界      B");
  assert.match(frameContentLine(styled), /\x1b\[31m/);
  const link = "\x1b]8;;https://example.invalid\x07text\x1b]8;;\x07";
  assert.equal(frameContentLine(link), link);
});

test("normalized colors preserve emphasis and links without inheriting panel colors", () => {
  const gray = "\x1b[38;2;176;176;176m";
  const link = "\x1b]8;;https://example.invalid\x07link\x1b]8;;\x07";
  const input = `\x1b[1;38;2;0;1;2;48;5;7mBold\x1b[0;38:2::0:0:0;48:5:240;7;2;4:3m ${link}\x1b[m`;
  assert.equal(frameContentLine(input, gray), `${reset}${gray}\x1b[1mBold${reset}${gray}\x1b[4:3m ${link}${reset}${gray}`);
  assert.equal(frameContentLine(input, ""), `${reset}\x1b[1mBold${reset}\x1b[4:3m ${link}${reset}`);
  assert.equal(strip(frameContentLine(input, gray)), "Bold link");
});

test("adopted and fallback subagent frames use exactly one margin and preserve their right edge", () => {
  let childWidth = 0;
  const native: any = { invalidate() {}, render(width: number) {
    childWidth = width;
    return [`${amber}╭─ Message from worker${"─".repeat(Math.max(0, width - 23))}╮${reset}`,
      `${amber}│${reset}\x1b[30;48;5;242mresult\t界\x1b[0m${amber}│${reset}`,
      `${amber}╰${"─".repeat(width - 2)}╯${reset}`];
  } };
  const adopted = subagentFrame(native, options, "worker");
  const lines = adopted.render(80);
  assert.equal(childWidth, 78);
  for (const line of lines) assert.equal(visibleWidth(line), 78);
  assert.ok(strip(lines[1]).endsWith("│"));
  assert.doesNotMatch(lines[1], /\x1b\[30;48|\x1b\[48;/);
  const fallback = subagentFrame({ invalidate() {}, render: () => ["\x1b[37m\x1b[45mplain result"] }, options, "worker");
  const fallbackLines = fallback.render(80);
  for (const line of fallbackLines) assert.equal(visibleWidth(line), 78);
  assert.doesNotMatch(fallbackLines[1], /\x1b\[(?:37|45)m/);
});

test("mouse events ignore the right margin and use the rendered content width", () => {
  let received: any;
  const frame = framed({ invalidate() {}, render: () => ["content"], handleMouse(event) { received = event; return { handled: true }; } }, options);
  frame.render(80);
  frame.handleMouse!({ x: 2, y: 1, width: 80, height: 3 } as any);
  assert.equal(received.width, 74);
  received = undefined;
  frame.handleMouse!({ x: 78, y: 1, width: 80, height: 3 } as any);
  assert.equal(received, undefined);
});

test("progress report reserves one outer margin, without repeatedly shrinking nested boxes", () => {
  const lines = renderProgress({ title: "Plan", tasks: [{ id: "T1", title: "Feature", status: "pending", runs: [] }], unassigned: [] }, 80, { details: true });
  for (const line of lines) assert.equal(visibleWidth(line), 78);
  assert.ok(lines.some(line => line.includes("╭─ Task T1")));
});
