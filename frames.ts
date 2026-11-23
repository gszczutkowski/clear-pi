import {
  foregroundAnsi, getTerminalColorMode, parseColor, stripTerminalSequences,
  truncateToWidth, visibleWidth, type Component,
} from "@earendil-works/pi-tui";
import { safeTitle, type FrameOptions } from "./config.ts";

const reset = "\x1b[0m";
const upstreamAmber = "\x1b[38;2;214;158;46m";
export const isImageLine = (line: string) => /\x1b(?:_G|\]1337;File=)/.test(line);
export const hasContent = (line: string) => isImageLine(line) || stripTerminalSequences(line).trim() !== "";
const fits = (line: string, width: number) => visibleWidth(line) <= width ? line : truncateToWidth(line, width, "");
const accent = (options: FrameOptions) => foregroundAnsi(parseColor(options.color), getTerminalColorMode());

function top(title: string, width: number, color: string): string {
  const label = fits(`─ ${safeTitle(title)} `, width - 2);
  return `${color}╭${label}${"─".repeat(width - 2 - visibleWidth(label))}╮${reset}`;
}
const bottom = (width: number, color: string) => `${color}╰${"─".repeat(width - 2)}╯${reset}`;

/** A display-only wrapper. The native child still owns Markdown, images and input. */
export function framed(child: Component, options: FrameOptions): Component {
  if (!options.enabled) return child;
  let inset = 0;
  let body: string[] = [];
  let bordered = false;
  return {
    invalidate: () => child.invalidate(),
    render(width) {
      inset = width >= 6 ? 2 : width >= 3 ? 1 : 0;
      bordered = false;
      if (width < 1) return [];
      const inner = width - 2 * inset;
      body = child.render(inner);
      bordered = inset > 0 && body.some(hasContent);
      if (!bordered) return body.map((line) => isImageLine(line) ? line : fits(line, width));
      const color = accent(options);
      const pad = inset === 2 ? " " : "";
      return [top(options.title, width, color), ...body.map((raw) => {
        if (isImageLine(raw)) return raw; // Don't prepend text to image transport sequences.
        const line = fits(raw, inner);
        return `${color}│${reset}${pad}${line}${reset}${" ".repeat(inner - visibleWidth(line))}${pad}${color}│${reset}`;
      }), bottom(width, color)];
    },
    handleMouse(event) {
      if (!bordered) return child.handleMouse?.(event);
      const y = event.y - 1;
      const x = event.x - inset;
      const width = event.width - 2 * inset;
      if (x < 0 || x >= width || y < 0 || y >= body.length) return undefined;
      return child.handleMouse?.({ ...event, x, y, width, height: body.length });
    },
  };
}

/** Adopt the original pi-herdr-subagents card without copying its report renderer. */
export function subagentFrame(child: Component, options: FrameOptions, sender: string): Component {
  const title = options.title.replaceAll("{sender}", () => sender);
  const fallback = framed(child, { ...options, title });
  let removed = false;
  let fallbackUsed = false;
  return {
    invalidate: () => child.invalidate(),
    render(width) {
      removed = false;
      fallbackUsed = false;
      if (width < 1) return [];
      const lines = child.render(width);
      const first = lines.findIndex(hasContent);
      const last = lines.findLastIndex(hasContent);
      const header = first === -1 ? "" : stripTerminalSequences(lines[first]);
      const footer = last === -1 ? "" : stripTerminalSequences(lines[last]);
      const upstreamHeader = header.startsWith("╭") && (header.startsWith("╭─ Message from ") || lines[first]?.startsWith(upstreamAmber));
      if (width < 3 || !upstreamHeader || !/^╰─*╯$/.test(footer)) {
        fallbackUsed = true;
        return fallback.render(width);
      }
      if (!options.enabled) {
        removed = true;
        return lines.slice(first + 1, last).map((line) => {
          // Remove only the boundary cells, preserving the native report's colors.
          return line.replace(/^\x1b\[[\d;]+m│\x1b\[0m/, "").replace(/\x1b\[[\d;]+m│\x1b\[0m$/, "");
        });
      }
      const color = accent(options);
      const restyled = lines.slice();
      restyled[first] = top(title, width, color);
      restyled[last] = bottom(width, color);
      for (let i = first + 1; i < last; i++) {
        restyled[i] = lines[i]
          .replace(`${upstreamAmber}│${reset}`, () => `${color}│${reset}`)
          .replace(/\x1b\[38;2;214;158;46m│\x1b\[0m$/, () => `${color}│${reset}`);
      }
      return restyled;
    },
    // The original report currently has no mouse actions when its borders are removed.
    handleMouse: (event) => fallbackUsed ? fallback.handleMouse?.(event) : removed ? undefined : child.handleMouse?.(event),
  };
}
