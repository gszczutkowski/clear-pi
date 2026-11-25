import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadSettings, parseSettings } from "./config.ts";
import { quotaText, renderFooter } from "./footer.ts";
import { mountToolGroups } from "./tool-groups.ts";
import { mountExtensionLabels } from "./extension-labels.ts";
import { UsageClient } from "./usage.ts";
import { createProgressDashboard } from "./progress.ts";

export default function clearPi(pi: ExtensionAPI) {
  let client: UsageClient | undefined;
  let quotaTimer: ReturnType<typeof setTimeout> | undefined;
  let lastQuotaText: string | undefined;
  let context: ExtensionContext | undefined;
  let requestRender: (() => void) | undefined;
  let disposeFooter: (() => void) | undefined;
  let settings = parseSettings(undefined);

  const render = () => requestRender?.();
  const progress = createProgressDashboard(pi);
  const syncQuota = () => {
    clearTimeout(quotaTimer);
    quotaTimer = undefined;
    const current = client;
    if (!current) return;
    const now = Date.now();
    // Both bar widths can change independently when usage changes.
    const icon = settings.footer.codexQuota.icon;
    const text = quotaText(current, now, 8, false, true, icon) + "\n" + quotaText(current, now, 3, false, true, icon);
    if (text !== lastQuotaText) {
      lastQuotaText = text;
      render();
    }
    const next = Math.min(current.nextRefreshAt(), current.nextDisplayChangeAt(now));
    if (!Number.isFinite(next)) return;
    quotaTimer = setTimeout(() => {
      if (current !== client) return;
      if (current.nextRefreshAt() <= Date.now()) void refresh();
      else syncQuota();
    }, Math.max(1, Math.ceil(next - now)));
    quotaTimer.unref();
  };
  const refresh = async () => {
    const current = client;
    const ctx = context;
    if (!current || !ctx) return;
    const pending = current.refresh(() => ctx.modelRegistry.getProviderAuth("openai-codex"));
    syncQuota();
    await pending;
    if (current === client) syncQuota();
  };
  const stopClient = () => {
    clearTimeout(quotaTimer);
    quotaTimer = undefined;
    lastQuotaText = undefined;
    client?.dispose();
    client = undefined;
  };
  const selectProvider = (ctx: ExtensionContext) => {
    context = ctx;
    // Same-provider model switches preserve cache and any in-flight refresh.
    if (!settings.footer.codexQuota.enabled || ctx.model?.provider !== "openai-codex") stopClient();
    else if (!client) {
      client = new UsageClient({ fetch: (...args) => fetch(...args), now: Date.now });
      void refresh();
      return; // Loading already requested a repaint.
    }
    render();
  };
  const stop = () => {
    progress.stop();
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
      const unsubscribe = settings.footer.gitBranch.enabled ? footerData.onBranchChange(request) : undefined;
      const skills = new Map((pi.getCommands?.() ?? []).filter((command) => command.source === "skill")
        .map((command) => [command.name.replace(/^skill:/, ""), command.description ?? ""]));
      const unmountExtensionLabels = mountExtensionLabels(tui);
      const unmountToolGroups = mountToolGroups(tui, theme, () => ctx.ui.getToolsExpanded(), settings.frames, settings.transcriptIcons,
        (name) => skills.get(name) ?? "", settings.transcriptNotices);
      const dispose = () => {
        if (disposed) return;
        disposed = true;
        unsubscribe?.();
        unmountToolGroups();
        unmountExtensionLabels();
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
    progress.start(ctx, settings.progress, render, settings.progressIcons);
  });
  // Pi treats unregistered slash input as a prompt. Catch only the former command
  // forms, without adding duplicate commands or intercepting ordinary messages.
  pi.on("input", (event, ctx) => {
    if (event.source !== "interactive" || ctx.mode !== "tui" || event.images?.length) return;
    const input = event.text.trim();
    if (/^\/clear-pi(?:[ \t]+[^\r\n]*)?$/.test(input)) {
      ctx.ui.notify("Quota is shown in the footer and refreshes automatically.", "info");
    } else if (/^\/clear-pi-progress(?:[ \t]+[^\r\n]*)?$/.test(input)) {
      ctx.ui.notify("Use /clear-progress; use /clear-progress full for the former scrollable report.", "info");
    } else return;
    return { action: "handled" };
  });
  pi.on("model_select", (_event, ctx) => { if (context) selectProvider(ctx); });
  const updateContext = (_event: unknown, ctx: ExtensionContext) => {
    if (!context) return;
    context = ctx;
    progress.update(ctx);
    render();
  };
  pi.on("tool_execution_end", updateContext);
  pi.on("thinking_level_select", updateContext);
  pi.on("session_tree", updateContext);
  pi.on("session_compact", updateContext);
  pi.on("message_end", updateContext);
  pi.on("agent_settled", updateContext);
  pi.on("session_shutdown", (_event, ctx) => {
    stop();
    if (ctx.mode === "tui") ctx.ui.setFooter(undefined);
  });
}
