import { stripTerminalSequences, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import type { FrameOptions } from "./config.ts";
import { frameWidth } from "./frame-layout.ts";
import { framed } from "./frames.ts";

type Field = readonly [label: string, value: string];
export interface NoticeContent { summary: readonly Field[]; preview?: Field; details: readonly Field[] }
const clean = (value: string) => stripTerminalSequences(value).replace(/\r\n?/g, "\n").replace(/\t/g, "    ")
  .replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f\u2028-\u202e\u2066-\u2069]/g, " ");

export function noticePreview(value: string): string {
  const content = clean(value).trim();
  const first = content.split("\n", 1)[0];
  return content.length > first.length || first.length > 120 ? `${first.slice(0, 120).trimEnd().toWellFormed()}…` : first;
}

/** A short metadata view with a clickable title and on-demand multiline details. */
export function noticeCard(options: FrameOptions, content: NoticeContent,
  arrow: (expanded: boolean) => string, isExpanded: () => boolean, toggle: () => void): Component {
  let cache: { width: number; expanded: boolean; lines: readonly string[] } | undefined;
  return {
    invalidate() { cache = undefined; },
    render(width) {
      const expanded = isExpanded();
      if (cache?.width === width && cache.expanded === expanded) return cache.lines;
      const body: Component = {
        invalidate() {},
        render(inner) {
          const lines: string[] = [];
          const add = ([label, value]: Field) => {
            const prefix = `${label}:`.padEnd(14);
            const valueLines = clean(value).split("\n");
            if (inner <= prefix.length) {
              lines.push(...wrapTextWithAnsi(`${label}:`, inner));
              for (const line of valueLines) lines.push(...wrapTextWithAnsi(line, inner));
              return;
            }
            let indent = prefix;
            for (const line of valueLines) {
              for (const wrapped of wrapTextWithAnsi(line, inner - prefix.length)) {
                lines.push(indent + wrapped);
                indent = " ".repeat(prefix.length);
              }
            }
          };
          for (const field of content.summary) add(field);
          if (expanded) {
            lines.push("");
            for (const field of content.details) add(field);
          } else if (content.preview) add(content.preview);
          return lines;
        },
      };
      const lines = framed(body, { ...options, title: `${arrow(expanded)} ${options.title}` }, "").render(width);
      cache = { width, expanded, lines };
      return lines;
    },
    handleMouse(event) {
      // At very small widths the arrow can be clipped. Ctrl+O still works there.
      const columns = frameWidth(cache?.width ?? 0);
      if (columns >= 5 && event.y === 0 && event.x >= 0 && event.x < columns && event.type === "click" && event.button === "left") {
        toggle();
        return { handled: true };
      }
    },
  };
}
