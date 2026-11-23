import { watch, type FSWatcher } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { defaultProgress, type ProgressOptions } from "./config.ts";
import { createProgressReader, type ProgressSnapshot, type ProgressWatch } from "./progress-data.ts";
import { saveProgressExport } from "./progress-export.ts";
import { renderProgress, type ProgressView } from "./progress-view.ts";

export const PROGRESS_WIDGET = "clear-pi-progress";
const empty: ProgressView = { title: null, tasks: [], unassigned: [] };

function branchKey(manager: ExtensionContext["sessionManager"]): string | undefined {
  const id = manager.getHeader()?.id;
  const file = manager.getSessionFile();
  return id && file ? JSON.stringify([id, manager.getSessionDir(), file, manager.getLeafId()]) : undefined;
}

interface DashboardDependencies {
  createReader?: () => (manager: ExtensionContext["sessionManager"]) => Promise<ProgressSnapshot>;
  watch?: typeof watch;
  render?: typeof renderProgress;
}

/** Presentation only: no transcript writes, tools, model requests, or control bus. */
export function createProgressDashboard(pi: ExtensionAPI, dependencies: DashboardDependencies = {}) {
  const readFactory = dependencies.createReader ?? createProgressReader;
  const renderReport = dependencies.render ?? renderProgress;
  let context: ExtensionContext | undefined;
  let options = { ...defaultProgress };
  let projection: { key: string | undefined; view: ProgressView; exportable: boolean } | undefined;
  let read: ReturnType<typeof readFactory> | undefined;
  const watchers = new Map<string, { watcher: FSWatcher; names: Set<ProgressWatch["filename"]> }>();
  let pending: ReturnType<typeof setTimeout> | undefined;
  let inFlight = false;
  let queued = false;
  let revision = 0;
  let mounted = false;
  let explicit = false;
  let stopped = true;
  let requestRender: (() => void) | undefined;

  const currentView = () => projection && context && projection.key === branchKey(context.sessionManager) ? projection.view : empty;
  const reportRows = (compact: boolean) => {
    let cache: { view: ProgressView; width: number; maxTasks: number; maxRuns: number; lines: string[] } | undefined;
    return (width: number) => {
      const view = currentView();
      const { maxTasks, maxRuns } = options;
      if (cache?.view === view && cache.width === width && cache.maxTasks === maxTasks && cache.maxRuns === maxRuns) return cache.lines;
      const lines = renderReport(view, width, { maxTasks, maxRuns, details: !compact, compact });
      const rows = compact && lines.length ? [...lines, truncateToWidth("/clear-progress expand — full view", width, "")] : lines;
      cache = { view, width, maxTasks, maxRuns, lines: rows };
      return cache.lines;
    };
  };
  const clearWatchers = () => {
    for (const { watcher } of watchers.values()) watcher.close();
    watchers.clear();
  };
  const clearPending = () => { if (pending) clearTimeout(pending); pending = undefined; queued = false; };
  const paint = () => {
    const ctx = context;
    if (!ctx || ctx.mode !== "tui" || typeof ctx.ui.setWidget !== "function") return;
    const view = currentView();
    const visible = options.enabled && (explicit || view.tasks.length > 0 || view.unassigned.length > 0 || !!view.notice);
    if (!visible) {
      if (mounted) ctx.ui.setWidget(PROGRESS_WIDGET, undefined);
      mounted = false;
      return;
    }
    // Replace herdr's plan summary, but leave the explicitly opened history tree alone.
    ctx.ui.setWidget("subagent-plan", undefined);
    if (mounted) return;
    ctx.ui.setWidget(PROGRESS_WIDGET, (_tui, theme) => {
      const rows = reportRows(true);
      return { render: (width: number) => rows(width).map(line => theme.fg("muted", line)), invalidate() {} };
    });
    mounted = true;
  };
  const schedule = () => {
    if (stopped || pending || !options.enabled) return;
    pending = setTimeout(() => {
      pending = undefined;
      if (inFlight) queued = true;
      else void refresh();
    }, 80);
    pending.unref();
  };
  const observe = (targets: ProgressWatch[]) => {
    const desired = new Map<string, Set<ProgressWatch["filename"]>>();
    for (const { directory, filename } of targets) {
      if (!desired.has(directory)) {
        if (desired.size >= 32) continue;
        desired.set(directory, new Set());
      }
      desired.get(directory)!.add(filename);
    }
    for (const [directory, entry] of watchers) {
      if (!desired.has(directory)) { entry.watcher.close(); watchers.delete(directory); }
    }
    let added = false;
    for (const [directory, names] of desired) {
      const existing = watchers.get(directory);
      if (existing) { existing.names = names; continue; }
      try {
        const watcher = (dependencies.watch ?? watch)(directory, (_event, filename) => {
          const entry = watchers.get(directory);
          if (entry?.watcher !== watcher) return;
          const name = filename?.toString();
          // Some platforms omit filenames. Reconcile conservatively in that case.
          if (!name) { schedule(); return; }
          for (const filter of entry.names) {
            const matches = typeof filter === "string"
              ? (process.platform === "win32" ? filter.toLowerCase() === name.toLowerCase() : filter === name)
              : filter.test(name);
            if (matches) { schedule(); break; }
          }
        });
        watcher.on("error", () => { watcher.close(); if (watchers.get(directory)?.watcher === watcher) watchers.delete(directory); });
        watchers.set(directory, { watcher, names });
        added = true;
      } catch { /* Missing directories are retried at the next native boundary. */ }
    }
    return added;
  };
  const refresh = async () => {
    if (stopped || !context || !options.enabled || !read) { paint(); return; }
    const manager = context.sessionManager;
    const key = branchKey(manager);
    const job = ++revision;
    inFlight = true;
    const stillActive = () => job === revision && !stopped && options.enabled;
    const current = () => stillActive() && context?.sessionManager === manager && branchKey(manager) === key;
    try {
      const next = await read(manager);
      if (!current()) return;
      projection = { key, view: next.view, exportable: !!key };
      // Catch writes in the interval between discovery and installing a new watch.
      if (observe(next.watches)) schedule();
    } catch {
      if (!current()) return;
      projection = { key, view: { ...empty, notice: "Progress data unavailable; no completion inferred." }, exportable: false };
      clearWatchers();
    } finally {
      if (job === revision) {
        inFlight = false;
        if (stillActive()) {
          if (current()) { paint(); requestRender?.(); }
          if (queued || !current()) { queued = false; schedule(); }
        }
      }
    }
  };
  const stop = () => {
    stopped = true;
    ++revision;
    inFlight = false;
    clearPending();
    clearWatchers();
    if (mounted) context?.ui.setWidget(PROGRESS_WIDGET, undefined);
    mounted = false;
    context = undefined;
    requestRender = undefined;
    read = undefined;
    projection = undefined;
  };
  const command: Parameters<ExtensionAPI["registerCommand"]>[1] = {
    description: "Show/export plan and nested agent progress without model calls: expand|compact|off|refresh|export",
    getArgumentCompletions: prefix => ["expand", "compact", "off", "refresh", "export"]
      .filter(value => value.startsWith(prefix)).map(value => ({ value, label: value })),
    handler: async (args, ctx) => {
      if (ctx.mode !== "tui") { if (ctx.hasUI) ctx.ui.notify("Progress dashboard: TUI only", "info"); return; }
      if (stopped || !context) return;
      const action = args.trim();
      if (action && !["expand", "compact", "off", "refresh", "export"].includes(action)) {
        ctx.ui.notify("Usage: /clear-progress [expand|compact|off|refresh|export]", "warning"); return;
      }
      if (action === "export") {
        const manager = ctx.sessionManager;
        const key = branchKey(manager);
        const current = () => !stopped && context?.sessionManager === manager && branchKey(manager) === key;
        const stale = () => ctx.ui.notify("Progress snapshot is not current. Run /clear-progress refresh before exporting.", "warning");
        try {
          const id = manager.getHeader()?.id;
          if (!id || !/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error("Unavailable session identity");
          if (!key || !projection?.exportable || projection.key !== key || !current()) { stale(); return; }
          const directory = join(manager.getSessionDir(), "artifacts", id, "clear-progress");
          // Export only the already projected snapshot, without reading history again.
          const file = await saveProgressExport(projection.view, directory, options, current);
          if (file && current()) ctx.ui.notify(`Progress exported: ${file}`, "info");
          else if (!file && !stopped && context?.sessionManager === manager) stale();
        } catch {
          if (current()) ctx.ui.notify("Progress export failed: cannot write the report to session artifacts.", "error");
        }
        return;
      }
      context = ctx;
      explicit = true;
      options.enabled = action !== "off";
      clearPending();
      if (!options.enabled) {
        ++revision;
        inFlight = false;
        clearWatchers();
        paint();
        requestRender?.();
        return;
      }
      read ??= readFactory();
      await refresh();
      if (stopped || !options.enabled || context?.sessionManager !== ctx.sessionManager) return;
      if ((!action || action === "expand") && typeof ctx.ui.custom === "function") {
        await ctx.ui.custom<void>((tui, theme, keys, done) => {
          const rows = reportRows(false);
          let top = 0;
          let page = 1;
          let total = 0;
          return {
            invalidate() {},
            render(width: number) {
              const lines = rows(width);
              total = lines.length;
              page = Math.max(1, Math.floor(tui.terminal.rows * 0.75) - 2);
              top = Math.min(top, Math.max(0, total - page));
              return [...lines.slice(top, top + page).map(line => theme.fg("muted", line)),
                theme.fg("dim", truncateToWidth(`↑↓ PgUp/PgDn Home/End · Esc close · ${top + 1}–${Math.min(top + page, total)}/${total}`, width, ""))];
            },
            handleInput(data: string) {
              if (keys.matches(data, "tui.select.cancel") || keys.matches(data, "tui.select.confirm")) { done(); return; }
              if (keys.matches(data, "tui.select.up")) top--;
              else if (keys.matches(data, "tui.select.down")) top++;
              else if (matchesKey(data, "pageUp")) top -= page;
              else if (matchesKey(data, "pageDown")) top += page;
              else if (matchesKey(data, "home")) top = 0;
              else if (matchesKey(data, "end")) top = total;
              else return;
              top = Math.max(0, Math.min(top, Math.max(0, total - page)));
              tui.requestRender();
            },
            handleMouse(event: { type: string; wheelDelta?: number }) {
              if (event.type !== "wheel") return;
              top = Math.max(0, Math.min(top + Math.sign(event.wheelDelta ?? 0) * 3, Math.max(0, total - page)));
              tui.requestRender();
              return { handled: true };
            },
          };
        });
      }
    },
  };
  pi.registerCommand("clear-progress", command);
  pi.registerCommand("clear-pi-progress", command);
  return {
    start(ctx: ExtensionContext, settings: ProgressOptions, render: () => void) {
      stop();
      if (ctx.mode !== "tui" || typeof ctx.ui.setWidget !== "function") return;
      context = ctx;
      options = { ...settings };
      explicit = false;
      requestRender = render;
      stopped = false;
      if (options.enabled) read = readFactory();
      return refresh();
    },
    update(ctx: ExtensionContext) { if (!stopped) { context = ctx; schedule(); } },
    stop,
  };
}
