import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";

/** Keep borders away from the terminal's last columns and overlay scrollbars. */
export const FRAME_RIGHT_MARGIN = 2;
export const frameWidth = (width: number) => Number.isFinite(width)
  ? Math.max(0, Math.floor(width) - FRAME_RIGHT_MARGIN) : 0;

/** Keep emphasis, but neutralize native panel colors (including inverse video).
 * Consume extended-color arguments as a unit; their values can also be SGR codes. */
function restyleSgr(sequence: string, foreground: string): string {
  const params = sequence.slice(2, -1).split(";");
  let styled = "";
  for (let i = 0; i < params.length; i++) {
    const param = params[i];
    const code = Number(param.split(":", 1)[0]);
    if (code === 38 || code === 48 || code === 58) {
      if (!param.includes(":")) {
        const mode = Number(params[++i]);
        i += mode === 2 ? 3 : mode === 5 ? 1 : 0;
      }
    } else if (code === 0) {
      styled += `\x1b[0m${foreground}`;
    } else if (!((code >= 30 && code <= 49) || (code >= 90 && code <= 107) || [2, 7, 8, 59].includes(code))) {
      styled += `\x1b[${param}m`;
    }
  }
  return styled;
}

/** Preserve links and safe styling, not cursor movement or erase commands.
 * A foreground override also replaces all panel backgrounds with the terminal default. */
export function frameContentLine(raw: string, foreground?: string): string {
  const tokens = raw.split(/(\x1b\[[\d;:]*m|\x1b\]8;[^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\]133;[ABC]\x07)/g);
  let column = 0;
  const content = tokens.map((token, index) => {
    if (index % 2) return foreground !== undefined && token.startsWith("\x1b[") ? restyleSgr(token, foreground) : token;
    return stripTerminalSequences(token).split("\t").map((part, tab) => {
      const padding = tab ? " ".repeat(8 - column % 8) : "";
      const text = part.replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
      column += padding.length + visibleWidth(text);
      return padding + text;
    }).join("");
  }).join("");
  return foreground === undefined ? content : `\x1b[0m${foreground}${content}`;
}
