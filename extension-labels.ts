import { Container, Text, stripTerminalSequences, type TUI } from "@earendil-works/pi-tui";

/** Normalize Pi's compact labels, not resource identities or loader metadata. */
export function extensionName(label: string): string {
  let name = label.replace(/\\/g, "/");
  // Package entry point suffix (including arbitrary build directories).
  const suffix = name.indexOf(":", /^[A-Za-z]:\//.test(name) ? 2 : 0);
  if (suffix !== -1) name = name.slice(0, suffix);
  // npm scopes and versions are presentation details here.
  name = name.replace(/^@[^/]+\//, "").replace(/@[^/]*$/, "");
  const parts = name.split("/").filter(Boolean);
  name = parts.at(-1) ?? name;
  if (/^index\.(?:[cm]?[jt]s|[jt]sx)$/i.test(name) && parts.length > 1) name = parts.at(-2)!;
  return name.replace(/\.(?:[cm]?[jt]s|[jt]sx)$/i, "") || label;
}

export function compactExtensionText(text: string): string {
  const plain = stripTerminalSequences(text);
  if (!plain.startsWith("[Extensions]\n")) return text;
  const newline = text.indexOf("\n");
  const body = text.slice(newline + 1);
  // Preserve the theme's ANSI prefix/suffix and native list order.
  return text.slice(0, newline + 1) + body.replace(/[^\x1b]+|\x1b\[[0-9;:]*m/g, (chunk) => {
    if (chunk.startsWith("\x1b")) return chunk;
    return chunk.split(", ").map((item) => {
      const match = item.match(/^(\s*)(.*?)(\s*)$/s)!;
      return match[1] + extensionName(match[2]!) + match[3];
    }).join(", ");
  });
}

type ResourceText = Text & { build: () => string; state: { expanded: boolean } };

/** Pi 1.6.0 private layout adapter. Unknown layouts/components remain native. */
export function mountExtensionLabels(tui: TUI): () => void {
  const document = tui.children?.[0];
  if (!(document instanceof Container) || document.constructor !== Container || document.children.length !== 3
    || !document.children.every((child) => child.constructor === Container)) return () => {};
  const resources = document.children[1] as Container;
  const nativeRender = resources.render;
  const patched = new Map<ResourceText, { original: () => string; wrapped: () => string }>();
  const render: typeof resources.render = function (width) {
    for (const child of resources.children) {
      const row = child as ResourceText;
      if (!(row instanceof Text) || typeof row.build !== "function" || typeof row.state?.expanded !== "boolean" || patched.has(row)) continue;
      const original = row.build;
      const wrapped = () => {
        const text = original.call(row);
        return row.state.expanded ? text : compactExtensionText(text);
      };
      patched.set(row, { original, wrapped });
      row.build = wrapped;
      row.invalidate();
    }
    return nativeRender.call(resources, width);
  };
  resources.render = render;
  return () => {
    if (resources.render === render) resources.render = nativeRender;
    for (const [row, { original, wrapped }] of patched) {
      if (row.build === wrapped) { row.build = original; row.invalidate(); }
    }
    patched.clear();
  };
}
