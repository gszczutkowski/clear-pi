import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadSettings, parseSettings } from "./config.ts";
import { renderFooter } from "./footer.ts";
import { mountToolGroups } from "./tool-groups.ts";
import { UsageClient } from "./usage.ts";

export default function clearPi(pi: ExtensionAPI) {
  let client: UsageClient | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let context: ExtensionContext | undefined;
  let requestRender: (() => void) | undefined;
  let disposeFooter: (() => void) | undefined;
  let settings = parseSettings(undefined);

  const render = () => requestRender?.();
  const refresh = async (force = false) => {
    const current = client;
    const ctx = context;
    if (!current || !ctx) return;
    await current.refresh(() => ctx.modelRegistry.getProviderAuth("openai-codex"), force);
    if (current === client && context) render();
  };
  const stopClient = () => {
    client?.dispose();
    client = undefined;
  };
  const selectProvider = (ctx: ExtensionContext) => {
    context = ctx;
    // Same-provider model switches preserve cache and any in-flight refresh.
    if (!settings.footer.codexQuota || ctx.model?.provider !== "openai-codex") stopClient();
    else if (!client) {
      client = new UsageClient({ fetch: (...args) => fetch(...args), now: Date.now });
      void refresh();
    }
    render();
  };
  const stop = () => {
    clearInterval(timer);
    timer = undefined;
    stopClient();
    disposeFooter?.();
    context = undefined;
  };

  pi.on("session_start", (_event, ctx) => {
    stop();
    // Component factories and polling belong only to an interactive TUI.
    if (ctx.mode !== "tui") return;
    const config = loadSettings();
    settings = config.settings;
    if (config.warning) ctx.ui.notify(config.warning, "warning");
    context = ctx;
    ctx.ui.setFooter((tui, theme, footerData) => {
      disposeFooter?.();
      let disposed = false;
      const request = () => { if (!disposed) tui.requestRender(); };
      const unsubscribe = settings.footer.gitBranch ? footerData.onBranchChange(request) : undefined;
      const unmountToolGroups = mountToolGroups(tui, theme, () => ctx.ui.getToolsExpanded(), settings.frames);
      const dispose = () => {
        if (disposed) return;
        disposed = true;
        unsubscribe?.();
        unmountToolGroups();
        if (requestRender === request) requestRender = undefined;
        if (disposeFooter === dispose) disposeFooter = undefined;
      };
      requestRender = request;
      disposeFooter = dispose;
      return {
        dispose,
        invalidate() {},
        render: (width) => !disposed && context ? renderFooter(context, theme, footerData, client, width, Date.now(), settings.footer) : [],
      };
    });
    selectProvider(ctx);
    // Countdown repaint is independent of UsageClient's bounded cache/retry clock.
    if (settings.footer.codexQuota) {
      timer = setInterval(() => { render(); void refresh(); }, 1000);
      timer.unref();
    }
  });
  pi.on("model_select", (_event, ctx) => { if (context) selectProvider(ctx); });
  const updateContext = (_event: unknown, ctx: ExtensionContext) => {
    if (!context) return;
    context = ctx;
    render();
  };
  pi.on("thinking_level_select", updateContext);
  pi.on("session_tree", updateContext);
  pi.on("session_compact", updateContext);
  pi.on("message_end", updateContext);
  pi.on("agent_settled", (event, ctx) => { updateContext(event, ctx); void refresh(); });
  pi.on("session_shutdown", (_event, ctx) => {
    stop();
    if (ctx.mode === "tui") ctx.ui.setFooter(undefined);
  });
  pi.registerCommand("clear-pi", {
    description: "Show Codex account quota status; refresh to fetch again",
    getArgumentCompletions: (prefix) => "refresh".startsWith(prefix) ? [{ value: "refresh", label: "refresh" }] : null,
    handler: async (args, ctx) => {
      if (!ctx.hasUI) return;
      const arg = args.trim();
      if (arg && arg !== "refresh") {
        ctx.ui.notify("Usage: /clear-pi [refresh]", "warning");
        return;
      }
      // Do not start polling or auth in RPC mode, or revive a stopped runtime.
      const active = context;
      if (arg === "refresh" && active) await refresh(true);
      if (active !== context) return;
      render();
      const fallback = ctx.mode !== "tui" ? "Codex usage: TUI only"
        : !settings.footer.codexQuota ? "Codex usage: disabled in config.json" : "Codex usage: unsupported provider";
      ctx.ui.notify(client?.status() ?? fallback, "info");
    },
  });
}
