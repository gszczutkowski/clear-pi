import * as Pi from "@earendil-works/pi-coding-agent";
import { noticeCard, noticePreview, type NoticeContent } from "./notice-cards.ts";
import { Container, foregroundAnsi, getTerminalColorMode, Markdown, parseColor, stripTerminalSequences, truncateToWidth, visibleWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import { defaultTranscriptIcons, defaultTranscriptNotices, safeTitle, type Settings, type TranscriptIcons, type FrameOptions } from "./config.ts";
import { framed, hasContent, isImageLine, subagentFrame } from "./frames.ts";
const leadingMargin = /^((?:\x1b\[[\d;:]*m|\x1b\]133;[ABC]\x07)*)( {0,2})/;
const activityGray = { light: parseColor("#595959"), dark: parseColor("#b0b0b0") };

type ToolRow = Pi.ToolExecutionComponent;
type RunRow = Pi.AssistantMessageComponent | ToolRow;
interface CachedRun {
  rows: readonly RunRow[];
  terminal: boolean;
  content: readonly (Component[] | undefined)[];
  fragment: Component;
}
interface Group { kind: "tools"; rows: ToolRow[] }
interface Assistant {
  kind: "assistant";
  component: Pi.AssistantMessageComponent;
  lines: readonly string[];
  first: number;
  previous: boolean;
  followed?: boolean;
  group?: Group;
}

// Verified on Pi 1.6.0: both TUI modes mount [header, resources, chat] first.
// There is no public transcript factory. Leave unrecognized layouts untouched.
function findChat(tui: TUI): Container | undefined {
  const document = tui.children?.[0];
  if (!(document instanceof Container) || document.constructor !== Container || document.children.length !== 3) return;
  if (!document.children.every((child) => child.constructor === Container)) return;
  return document.children[2] as Container;
}

// Pi 1.6.0 replaces the content container's children on message, thinking and padding updates.
function assistantState(component: Pi.AssistantMessageComponent) {
  return component as unknown as {
    lastMessage?: Parameters<Pi.AssistantMessageComponent["updateContent"]>[0];
    contentContainer?: Container;
    isStreaming?: boolean;
  };
}

function snapshot(component: Component, lines: readonly string[]): Component {
  return { render: () => lines, invalidate() {}, handleMouse: (event) => component.handleMouse?.(event) };
}

function answerCandidate(component: Pi.AssistantMessageComponent): boolean {
  const message = assistantState(component).lastMessage;
  return !!message && !message.content.some((block) => block.type === "toolCall")
    && message.content.some((block) => block.type === "text" && block.text.trim());
}

function answerLines(component: Pi.AssistantMessageComponent, part: "thinking" | "answer"): Component {
  let start = 0;
  let height = 0;
  return {
    invalidate() {},
    render(width) {
      const lines = component.render(width);
      height = lines.length;
      const children = assistantState(component).contentContainer?.children ?? [];
      const textIndex = children.findIndex((child) => child instanceof Markdown);
      const split = textIndex === -1 ? 0 : children.slice(0, textIndex).reduce((offset, child) => offset + child.render(width).length, 0);
      start = part === "answer" ? split : 0;
      const visible = part === "answer" ? lines.slice(split) : lines.slice(0, split);
      return visible.some(hasContent) ? visible : [];
    },
    handleMouse: (event) => component.handleMouse({ ...event, y: event.y + start, height }),
  };
}

// Reserve the marker column before native wrapping, so continuation lines align.
const activityWidth = (width: number) => Math.max(1, width - 1);

function activityInfo(component: Component, marker: string, nativeLines?: readonly string[]): Component {
  let shifts: number[] = [];
  return {
    invalidate() { component.invalidate(); },
    render(width) {
      let first = true;
      shifts = [];
      // Native assistant Markdown has one column of horizontal padding. Replace
      // that column, rather than adding a second margin in front of it.
      return (nativeLines ?? component.render(activityWidth(width))).map((line, index) => {
        if (!line || isImageLine(line)) return line;
        const [leading = "", escapes = "", margin = ""] = line.match(leadingMargin) ?? [];
        // Once a printable character is found, a full ANSI strip just to test
        // emptiness would only duplicate work done by the outer frame.
        if (!/^[ \t]*[^\s\x00-\x1f\x7f-\x9f]/.test(line.slice(leading.length)) && !stripTerminalSequences(line).trim()) return line;
        const removed = Math.min(1, margin.length);
        shifts[index] = 2 - removed;
        const prefix = first && marker ? `${marker} ` : "  ";
        first = false;
        const decorated = prefix + escapes + line.slice(leading.length - margin.length + removed);
        // The native layout already fit width - 1. Replacing one column with
        // two cannot overflow; only lines without the expected margin need a check.
        return removed && width >= 2 ? decorated : truncateToWidth(decorated, width, "");
      });
    },
    handleMouse: (event) => component.handleMouse?.({ ...event, x: event.x - (shifts[event.y] ?? 0), width: activityWidth(event.width) }),
  };
}

/** Project the transcript without moving native rows or modifying Pi's messages. */
export function mountToolGroups(
  tui: TUI, theme: Pi.Theme, getToolsExpanded: () => boolean, frames?: Settings["frames"],
  icons: TranscriptIcons = defaultTranscriptIcons,
  skillDescription: (name: string) => string = () => "",
  notices: Settings["transcriptNotices"] = defaultTranscriptNotices,
): () => void {
  const chat = findChat(tui);
  const Tool = Pi.ToolExecutionComponent;
  const Message = Pi.AssistantMessageComponent;
  const User = Pi.UserMessageComponent;
  const Custom = Pi.CustomMessageComponent;
  if (!chat || [Tool, Message, User, Custom].some((Row) => typeof Row !== "function")) return () => {};

  const view = new Container();
  const nativeRender = chat.render;
  const nativeMouse = chat.handleMouse;
  const nativeInvalidate = chat.invalidate;
  let cacheWidth: number | undefined;
  let completedRuns = new WeakMap<RunRow, CachedRun>();
  let completedPrompts = new WeakMap<Pi.UserMessageComponent, { content: Component[]; fragment: Component }>();
  let noticeCards = new WeakMap<Component, Component>();
  const clearCache = () => {
    completedRuns = new WeakMap();
    completedPrompts = new WeakMap();
    noticeCards = new WeakMap();
  };
  const invalidate: typeof chat.invalidate = () => {
    // Pi calls chat.invalidate() as part of theme changes (including terminal color reports).
    clearCache();
    nativeInvalidate.call(chat);
  };
  const overrides = new WeakMap<Component, { revision: number; expanded: boolean }>();
  const decorated = new WeakMap<ToolRow, { setExpanded: ToolRow["setExpanded"]; local?: boolean }>();
  let globalExpanded = getToolsExpanded();
  let revision = 0;
  let active = true;
  const syncGlobal = () => {
    const expanded = getToolsExpanded();
    if (globalExpanded !== expanded) {
      globalExpanded = expanded;
      revision++;
      completedRuns = new WeakMap();
    }
  };
  const localExpansion = (row: Component) => {
    const override = overrides.get(row);
    return override?.revision === revision ? override.expanded : undefined;
  };
  const isExpanded = (row: Component) => localExpansion(row) ?? globalExpanded;
  const syncRow = (row: ToolRow, local: boolean | undefined) => {
    let state = decorated.get(row);
    if (!state) {
      const setExpanded = row.setExpanded;
      state = { setExpanded };
      decorated.set(row, state);
      // Ctrl+O sets Pi's global state first, then updates each native tool row.
      row.setExpanded = (expanded) => {
        if (active) syncGlobal();
        setExpanded.call(row, expanded);
      };
    }
    if (state.local !== local) {
      state.local = local;
      row.setExpanded(local ?? globalExpanded);
    }
  };
  const toggle = (group: Group, runKey: RunRow | undefined) => {
    syncGlobal();
    const expanded = !isExpanded(group.rows[0]);
    overrides.set(group.rows[0], { revision, expanded });
    if (runKey) completedRuns.delete(runKey);
    for (const row of group.rows) syncRow(row, expanded);
    tui.requestRender();
    return { handled: true };
  };
  const glyph = (expanded: boolean) => expanded ? icons.expanded : icons.collapsed;
  const arrow = (group: Group) => theme.fg("accent", glyph(isExpanded(group.rows[0])));

  const addNotice = (row: Component, options: FrameOptions, content: () => NoticeContent) => {
    let card = noticeCards.get(row);
    if (!card) {
      card = noticeCard(options, content(), glyph, () => isExpanded(row), () => {
        syncGlobal();
        overrides.set(row, { revision, expanded: !isExpanded(row) });
        tui.requestRender();
      });
      noticeCards.set(row, card);
    }
    view.addChild(card);
  };

  const project = (children: readonly Component[], width: number, target: Container, researchHeading = false, runKey?: RunRow) => {
    target.clear();
    const sections: (Assistant | Group | { kind: "other"; component: Component })[] = [];
    let assistant: Assistant | undefined;
    let group: Group | undefined;
    // The marker and either arrow occupy the same column. Render once at the
    // final wrapping width, then choose which marker to use after grouping.
    const messageWidth = frames ? activityWidth(width) : width;

    for (const child of children) {
      if (child instanceof Message) {
        const lines = child.render(messageWidth);
        const first = lines.findIndex(hasContent);
        if (first === -1) continue; // Tool-only rounds do not break an existing section.
        if (assistant) assistant.followed = true;
        assistant = { kind: "assistant", component: child, lines, first, previous: assistant !== undefined };
        sections.push(assistant);
        group = undefined;
      } else if (child instanceof Tool) {
        if (!group) {
          group = { kind: "tools", rows: [] };
          if (assistant) assistant.group = group;
          sections.push(group);
        }
        group.rows.push(child);
      } else {
        sections.push({ kind: "other", component: child });
        assistant = undefined;
        group = undefined;
      }
    }

    const inline = new Set<Group>();
    let expandedTools = false;
    for (const section of sections) {
      if (section.kind === "assistant") {
        const { group } = section;
        const inlineGroup = frames && group && !isImageLine(section.lines[section.first]) ? group : undefined;
        const component = frames
          ? activityInfo(section.component, inlineGroup ? arrow(inlineGroup) : icons.activity, section.lines)
          : section.component;
        const source = frames ? component.render(width) : section.lines;
        const measured = frames && width < 3 ? source : section.lines;
        const first = measured === section.lines ? section.first : measured.findIndex(hasContent);
        const last = measured.findLastIndex(hasContent);
        // Keep existing spacing around normal messages, but pack successive one-line updates.
        const offset = first >= 0 && first === last && section.previous && (group || section.followed) ? first : 0;
        const lines = source.slice(offset);
        const titleIndex = (frames ? first : last) - offset;
        let shift = 0;
        if (inlineGroup && first >= 0) inline.add(inlineGroup);
        if (group && !frames) {
          const title = lines[titleIndex];
          const [leading = "", escapes = "", margin = ""] = title.match(leadingMargin) ?? [];
          shift = 2 - margin.length;
          // Keep Pi's styling, shell markers and complete text; don't prefix image transport lines.
          const text = stripTerminalSequences(title).trimEnd();
          if (!isImageLine(title) && text && visibleWidth(text) + shift <= width) {
            lines[titleIndex] = truncateToWidth(`${arrow(group)} ${escapes}${title.slice(leading.length)}`, width, "");
            inline.add(group);
          }
        }
        target.addChild({
          render: () => lines,
          invalidate() {},
          handleMouse(event) {
            const onTitle = group && inline.has(group) && event.y === titleIndex;
            if (onTitle && event.x >= 0 && event.x < 2) {
              if (event.type === "click" && event.button === "left") return toggle(group, runKey);
              return undefined;
            }
            return component.handleMouse?.({ ...event, x: event.x - (onTitle ? shift : 0),
              y: event.y + offset, height: source.length });
          },
        });
      } else if (section.kind === "tools") {
        const group = section;
        const local = localExpansion(group.rows[0]);
        for (const row of group.rows) syncRow(row, local);
        if (!inline.has(group)) {
          const heading = researchHeading ? " Agent research" : " AI tools";
          researchHeading = false;
          const label = width > 1 ? truncateToWidth(heading, width - 1) : "";
          const hitWidth = 1 + visibleWidth(label);
          target.addChild({
            render: () => [arrow(group) + label],
            invalidate() {},
            handleMouse: (event) => event.type === "click" && event.button === "left" && event.x >= 0 && event.x < hitWidth ? toggle(group, runKey) : undefined,
          });
        }
        if (isExpanded(group.rows[0])) {
          expandedTools = true;
          for (const row of group.rows) target.addChild(row);
        }
      } else {
        target.addChild(section.component);
      }
    }
    return expandedTools;
  };

  const addRun = (run: RunRow[], terminal: boolean, completed: boolean, width: number, options: Settings["frames"]) => {
    if (!run.length) return;
    const saved = completed ? completedRuns.get(run[0]) : undefined;
    if (saved?.terminal === terminal && saved.rows.length === run.length && run.every((row, i) =>
      row === saved.rows[i] && (!(row instanceof Message) || assistantState(row).contentContainer?.children === saved.content[i]))) {
      view.addChild(saved.fragment);
      return;
    }

    const part = new Container();
    let expandedTools = false;
    const last = run.at(-1);
    const answer = terminal && last instanceof Message && answerCandidate(last) ? last : undefined;
    const work = answer ? run.slice(0, -1) : run;
    const activity = new Container();
    const thinking = answer && assistantState(answer).lastMessage?.content.some((block) => block.type === "thinking")
      ? activityInfo(answerLines(answer, "thinking"), icons.activity) : undefined;
    if (work.length || thinking) {
      let offset = 0;
      let height = 0;
      part.addChild(framed({
        invalidate() {},
        render(width) {
          expandedTools = project(work, width, activity, options.agentActivity.enabled, run[0]);
          if (thinking) activity.addChild(thinking);
          const lines = activity.render(width);
          height = lines.length;
          offset = height > 0 && !hasContent(lines[0]) ? 1 : 0;
          return lines.slice(offset);
        },
        handleMouse: (event) => activity.handleMouse({ ...event, y: event.y + offset, height }),
      }, options.agentActivity, foregroundAnsi(activityGray[theme.appearance === "light" ? "light" : "dark"], getTerminalColorMode())));
    }
    if (answer) part.addChild(framed(answerLines(answer, "answer"), options.agentAnswer));
    if (!completed) {
      for (const child of part.children) view.addChild(child);
      return;
    }

    const lines = part.render(width);
    const fragment = snapshot(part, lines);
    view.addChild(fragment);
    // Tool renderers and image conversion can update independently. Keep visible tools
    // and image transport live instead of relying on their private invalidation paths.
    if (!expandedTools && !lines.some(isImageLine) && run.every((row) => {
      if (!(row instanceof Message)) return true;
      const { contentContainer, isStreaming } = assistantState(row);
      return contentContainer && isStreaming === false;
    })) {
      completedRuns.set(run[0], { rows: run, terminal, fragment,
        content: run.map((row) => row instanceof Message ? assistantState(row).contentContainer?.children : undefined) });
    } else {
      completedRuns.delete(run[0]);
    }
  };

  const addPrompt = (row: Pi.UserMessageComponent, completed: boolean, width: number, options: Settings["frames"]) => {
    const saved = completed ? completedPrompts.get(row) : undefined;
    if (saved?.content === row.children) {
      view.addChild(saved.fragment);
      return;
    }
    const prompt = framed(row, options.userPrompt, "");
    if (!completed) {
      view.addChild(prompt);
      return;
    }
    const lines = prompt.render(width);
    const fragment = snapshot(prompt, lines);
    if (!lines.some(isImageLine)) completedPrompts.set(row, { content: row.children, fragment });
    view.addChild(fragment);
  };

  const render: typeof chat.render = (width) => {
    if (!active) return nativeRender.call(chat, width);
    view.clear();
    if (cacheWidth !== width) {
      cacheWidth = width;
      clearCache();
    }
    if (width < 1) return [];
    syncGlobal();
    if (!frames) {
      project(chat.children, width, view);
    } else {
      let run: RunRow[] = [];
      // A notice or a subagent card stays in transcript order. It does not turn
      // preceding progress into a final answer if more agent work follows it.
      let nextWork = false;
      // Only a subsequent native prompt seals earlier work. The entire tail stays live.
      let lastPrompt = -1;
      const terminalHere = new Array<boolean>(chat.children.length);
      for (let i = chat.children.length - 1; i >= 0; i--) {
        const child = chat.children[i];
        if (child instanceof User) {
          nextWork = false;
          if (lastPrompt === -1) lastPrompt = i;
        }
        terminalHere[i] = !nextWork;
        if (child instanceof Tool || (child instanceof Message && assistantState(child).lastMessage?.content.length)) nextWork = true;
      }
      for (const [index, child] of chat.children.entries()) {
        if (child instanceof Message || child instanceof Tool) {
          run.push(child);
          continue;
        }
        // Native spacer before a user prompt/notice must stay outside the frame.
        addRun(run, terminalHere[index], index <= lastPrompt, width, frames);
        run = [];
        if (child instanceof User) {
          addPrompt(child, index < lastPrompt, width, frames);
        } else if (notices.skill.enabled && typeof Pi.SkillInvocationMessageComponent === "function" && child instanceof Pi.SkillInvocationMessageComponent) {
          // Pi 1.6.0 retains the parsed invocation here; leave unrecognized rows native.
          const block = (child as unknown as { skillBlock?: Pi.ParsedSkillBlock }).skillBlock;
          if (typeof block?.name === "string" && typeof block.content === "string") {
            addNotice(child, notices.skill, () => ({
              summary: [["Name", block.name], ["Description", skillDescription(block.name) || "—"]],
              details: [["Instructions", block.content]],
            }));
          } else view.addChild(child);
        } else if (child instanceof Custom) {
          const message = (child as unknown as { message?: { customType?: string; details?: {
            name?: unknown; agent?: unknown; message?: unknown; sessionFile?: unknown; keepOpen?: unknown;
          } } }).message;
          if (message?.customType === "subagent_ping" && notices.help.enabled && typeof message.details?.message === "string") {
            const { name, agent, message: request, sessionFile, keepOpen } = message.details;
            addNotice(child, notices.help, () => ({
              summary: [["Name", typeof name === "string" ? name : "subagent"], ["Role", typeof agent === "string" ? agent : "—"]],
              preview: ["Preview", noticePreview(request) || "—"],
              details: [
                ["Request", request], ...(typeof sessionFile === "string" ? [["Session", sessionFile] as const] : []),
                ...(keepOpen === true ? [["Follow-up", "The existing pane was kept open."] as const] : []),
              ],
            }));
          } else if (message?.customType === "subagent_result") {
            const { name, agent } = message.details ?? {};
            const sender = safeTitle(`${typeof name === "string" ? name : "subagent"}${typeof agent === "string" ? ` (${agent})` : ""}`);
            view.addChild(subagentFrame(child, frames.subagentMessage, sender));
          } else view.addChild(child);
        } else view.addChild(child);
      }
      addRun(run, true, false, width, frames);
    }
    return view.render(width);
  };
  const handleMouse: typeof chat.handleMouse = (event) => active ? view.handleMouse(event) : nativeMouse.call(chat, event);
  chat.render = render;
  chat.handleMouse = handleMouse;
  chat.invalidate = invalidate;

  return () => {
    if (!active) return;
    active = false;
    if (chat.render === render) chat.render = nativeRender;
    if (chat.handleMouse === handleMouse) chat.handleMouse = nativeMouse;
    if (chat.invalidate === invalidate) chat.invalidate = nativeInvalidate;
    clearCache();
    view.clear();
    for (const child of chat.children) {
      if (!(child instanceof Tool)) continue;
      const row = decorated.get(child);
      if (!row) continue;
      child.setExpanded = row.setExpanded;
      if (row.local !== undefined) child.setExpanded(getToolsExpanded());
    }
  };
}
