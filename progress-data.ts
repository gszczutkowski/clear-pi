import { lstat, open, opendir, realpath, stat } from "node:fs/promises";
import { constants, type BigIntStats } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { ProgressRun, ProgressTask, ProgressView } from "./progress-view.ts";

type RecordData = Record<string, any>;
interface Identity { sessionId: string; sessionFile: string }
interface Lineage {
  version: 1; parent: Identity; root: Identity; child: Identity;
  rootAssignmentId: string; rootCheckpoint: string; rootBranchToken: string; eventDirectory: string;
}
interface Manager {
  getSessionDir(): string; getSessionFile(): string | undefined;
  getHeader(): { id: string } | null; getSessionId?(): string; getBranch(): any[];
}
const MAX_FILE = 2 * 1024 * 1024;
const MAX_EVENTS = 2000;
const MAX_ENTRIES = 10000;
const MAX_RUNS = 2000;
const object = (v: any): v is RecordData => !!v && typeof v === "object" && !Array.isArray(v);
const string = (v: any): v is string => typeof v === "string" && v.length > 0 && v.length <= 8192;
const missing = (error: unknown) => ["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException)?.code ?? "");
const normalize = (path: string) => process.platform === "win32" ? path.toLowerCase() : path;
const eventName = /^[a-f0-9]{64}\.json$/;
const kinds = ["assignment", "result", "ping", "continuation", "failure", "state", "decision"];
const BATCH = 32;

export interface ProgressWatch { directory: string; filename: string | RegExp }
export interface ProgressSnapshot { view: ProgressView; watches: ProgressWatch[] }

function sameFile(a: BigIntStats, b: BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}

// Bound both the read size and concurrent file handles. Reject files that changed mid-read.
async function json(path: string, max: number, observed?: BigIntStats): Promise<unknown> {
  observed ??= await lstat(path, { bigint: true });
  if (!observed.isFile() || observed.size > max) throw new Error("Invalid artifact");
  const file = await open(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  try {
    const before = await file.stat({ bigint: true });
    if (!before.isFile() || !sameFile(before, observed)) throw new Error("Invalid artifact");
    const bytes = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) throw new Error("Truncated artifact");
      offset += bytesRead;
    }
    if (!sameFile(before, await file.stat({ bigint: true }))) throw new Error("Artifact changed during read");
    return JSON.parse(bytes.toString("utf8"));
  } finally { await file.close(); }
}

type CachedEvent = { info: BigIntStats; event: RecordData };

/** Cache parsed, structurally valid events; branch authority and paths are checked anew per read. */
export function createProgressReader(load = json) {
  let events = new Map<string, CachedEvent>();
  let generation = 0;
  return async (manager: Manager): Promise<ProgressSnapshot> => {
    const revision = ++generation;
    const previous = events;
    const next = new Map<string, CachedEvent>();
    const snapshot = await project(manager, previous, next, load);
    if (revision === generation) events = next;
    return snapshot;
  };
}

export const readProgress = (manager: Manager) => createProgressReader()(manager);
function isLineage(v: any): v is Lineage {
  return object(v) && v.version === 1 && [v.parent, v.root, v.child].every(i => object(i) && string(i.sessionId) && string(i.sessionFile) && isAbsolute(i.sessionFile))
    && [v.rootAssignmentId, v.rootCheckpoint, v.rootBranchToken, v.eventDirectory].every(string) && isAbsolute(v.eventDirectory);
}
function text(value: unknown, max = 320): string | undefined {
  if (typeof value !== "string") return undefined;
  // Strip control strings as a unit, including OSC 8's invisible target.
  // Discard unterminated control strings to the end rather than exposing their payload.
  return value.replace(/(?:\x1b\]|\x9d)(?:[^\x07\x1b\x9c]|\x1b(?!\\))*(?:\x07|\x1b\\|\x9c|$)/g, "")
    .replace(/(?:\x1b[P^_X]|[\x90\x98\x9e\x9f])[\s\S]*?(?:\x1b\\|\x9c|$)/g, "")
    .replace(/(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]|\x1b[ -/]*[0-~]/g, "").replace(/[\x00-\x1f\x7f-\x9f]/g, " ")
    .replace(/\b(Bearer\s+)[^\s]+/gi, "$1[redacted]")
    .replace(/\b(api[_-]?key|token|password|secret)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]")
    .replace(/\s+/g, " ").trim().slice(0, max) || undefined;
}

/** Read-only, same-user snapshot adapter. Saved evidence never establishes liveness or acceptance. */
async function project(manager: Manager, previous: Map<string, CachedEvent>, next: Map<string, CachedEvent>, load: typeof json): Promise<ProgressSnapshot> {
  const notices = new Set<string>();
  const targets = new Map<string, Set<ProgressWatch["filename"]>>();
  // Canonical paths may change (including symlink replacements); never keep these across snapshots.
  const paths = new Map<string, Promise<string>>();
  const canonical = (path: string): Promise<string> => {
    path = resolve(path);
    if (!paths.has(path)) paths.set(path, realpath(path).catch(async error => {
      if (!missing(error) || dirname(path) === path) throw error;
      return join(await canonical(dirname(path)), basename(path));
    }).then(normalize));
    return paths.get(path)!;
  };
  const identity = async (i: Identity) => JSON.stringify([i.sessionId, await canonical(i.sessionFile)]);
  const scope = async (l: Lineage) => JSON.stringify([await identity(l.root), l.rootAssignmentId, l.rootCheckpoint,
    l.rootBranchToken, await canonical(l.eventDirectory)]);
  const provenance = async (l: Lineage) => {
    const [key, parent, child] = await Promise.all([scope(l), identity(l.parent), identity(l.child)]);
    return { scope: key, parent, child, key: JSON.stringify([key, parent, child]) };
  };
  const view: ProgressView = { title: null, tasks: [], unassigned: [] };
  const incomplete = () => notices.add("Incomplete evidence; run counts are a lower bound");
  const ancestors = new Map<string, Promise<string>>();
  function existingDirectory(path: string): Promise<string> {
    if (!ancestors.has(path)) ancestors.set(path, stat(path).then(info => {
      if (!info.isDirectory()) throw new Error("Not a directory");
      return path;
    }).catch(error => {
      if (!missing(error) || dirname(path) === path) throw error;
      return existingDirectory(dirname(path));
    }));
    return ancestors.get(path)!;
  }
  async function watch(directory: string, filename: string | RegExp) {
    const target = resolve(directory);
    try {
      const path = await existingDirectory(target);
      let child = target;
      if (path !== target) while (dirname(child) !== path) child = dirname(child);
      const name = path === target ? filename : basename(child);
      if (!targets.has(path)) targets.set(path, new Set());
      targets.get(path)!.add(name);
    } catch { incomplete(); }
  }
  async function optional(path: string, max = MAX_FILE): Promise<any> {
    try { return await load(path, max); } catch (error) {
      if (!missing(error)) incomplete();
      return undefined;
    }
  }
  try {
    const branch = manager.getBranch();
    const header = manager.getHeader();
    const file = manager.getSessionFile();
    const sessionDir = manager.getSessionDir();
    if (!header || !string(header.id) || basename(header.id) !== header.id || !file || !Array.isArray(branch)) {
      notices.add("Durable session identity unavailable");
      return { view: { ...view, notice: [...notices].join("; ") }, watches: [] };
    }
    const self = { sessionId: header.id, sessionFile: await canonical(file) };
    const selfKey = JSON.stringify([self.sessionId, self.sessionFile]);
    const checkpoints = new Map(branch.filter(e => e.type === "custom" && e.customType === "subagent-custody")
      .map(e => [e.id, e.data?.branchToken]));
    const custody = (checkpoint: unknown, token: unknown) => string(checkpoint) && string(token) && checkpoints.get(checkpoint) === token;
    const latest = branch.findLast(e => e.type === "custom" && typeof e.customType === "string" && e.customType.startsWith("pi-subagents-plan/"));
    let plan: RecordData | undefined;
    const tasksById = new Map<string, ProgressTask>();
    if (latest) {
      const p = latest.data;
      const statuses = ["pending", "in_progress", "blocked", "in_review", "accepted", "failed", "skipped", "cancelled"];
      if (latest.customType !== "pi-subagents-plan/v1" || !object(p) || p.schemaVersion !== 1 || !string(p.planId)
        || !string(p.title) || !object(p.authority) || !string(p.authority.sessionId) || !string(p.authority.branchInstanceId)
        || !Number.isSafeInteger(p.revision) || p.revision < 0 || !Array.isArray(p.tasks) || p.tasks.length > 1000
        || !p.tasks.every((t: any) => object(t) && string(t.taskId) && string(t.title) && statuses.includes(t.status)
          && Array.isArray(t.attempts) && t.attempts.length <= 1000 && t.attempts.every((a: any) => object(a) && string(a.attemptId)
            && Array.isArray(a.runIds) && a.runIds.length <= MAX_RUNS && a.runIds.every(string)))
        || new Set(p.tasks.map((t: any) => t.taskId)).size !== p.tasks.length) {
        notices.add("Unsupported or corrupt active plan; no fallback used");
      } else {
        view.title = text(p.title, 240) ?? "Untitled plan";
        if (p.authority.sessionId !== self.sessionId) notices.add("Foreign inherited plan (read-only); runs remain unassigned");
        else plan = p;
        view.tasks = p.tasks.map((t: any): ProgressTask => {
          const task = { id: /^T\d+$/.test(t.taskId) ? t.taskId : text(t.taskId, 100) ?? "", title: text(t.title, 240) ?? "Untitled task", status: t.status, runs: [] };
          tasksById.set(t.taskId, task);
          return task;
        });
      }
    }
    const anchors: Lineage[] = [];
    for (let i = branch.length - 1; i >= 0; i--) {
      const e = branch[i];
      if (e.type === "custom" && e.customType === "subagent-assignment" && isLineage(e.data?.lineage)
        && await identity(e.data.lineage.child) === selfKey) { anchors.push(e.data.lineage); break; }
    }
    if (!anchors.length) for (const e of branch) if (e.type === "custom" && e.customType === "subagent-lineage-assignment/v1" && isLineage(e.data)) {
      if (await identity(e.data.root) === selfKey && custody(e.data.rootCheckpoint, e.data.rootBranchToken)) anchors.push(e.data);
      else notices.add("History scope/branch mismatch ignored");
    }
    const scopes = new Map<string, Set<string>>();
    for (const anchor of anchors) {
      const directory = resolve(anchor.eventDirectory);
      if (!scopes.has(directory)) scopes.set(directory, new Set());
      scopes.get(directory)!.add(await scope(anchor));
    }
    const authorized = new Set([...scopes.values()].flatMap(keys => [...keys]));
    type Provenance = Awaited<ReturnType<typeof provenance>>;
    const runs = new Map<string, { id: string; run: ProgressRun; lineage?: Lineage; custody?: Provenance; binding?: any; root: boolean; time?: number }>();
    function add(id: string, name: string, task: string, lineage: Lineage | undefined, root: boolean, key?: Provenance, time?: number) {
      if (runs.has(id)) {
        const existing = runs.get(id)!;
        if (key && existing.custody && key.key !== existing.custody.key) { incomplete(); return undefined; }
        return existing;
      }
      if (runs.size >= MAX_RUNS) { incomplete(); return undefined; }
      const label = text(id, 100) ?? "Run";
      const entry = { id, run: { id: label, name: text(name, 100) || label, role: "unknown", task: text(task, 500) || "Assignment unavailable",
        status: root ? "SAVED" : "ASSIGNED", children: [] } as ProgressRun, lineage, root, time, custody: key, binding: undefined as any };
      runs.set(id, entry); return entry;
    }
    async function profile(entry: NonNullable<ReturnType<typeof add>>, p: any, sessionFile = entry.lineage?.child.sessionFile,
      key = entry.custody?.key) {
      if (!object(p) || p.version !== 1 || !string(p.sessionFile) || !sessionFile || await canonical(p.sessionFile) !== await canonical(sessionFile)
        || (key && (!isLineage(p.lineage) || (await provenance(p.lineage)).key !== key))
        || (!key && p.lineage !== undefined)) { incomplete(); return; }
      entry.run.role = text(p.role, 60) || "unknown";
      const runtime = p.runtimePlan;
      entry.run.model = text(runtime?.model, 120) || text(runtime?.modelId, 120);
      entry.run.thinking = text(runtime?.thinking, 30);
    }
    const runtimeDir = join(sessionDir, "artifacts", header.id, "subagent-runtime");
    await watch(runtimeDir, "manifest.json");
    const m = await optional(join(runtimeDir, "manifest.json"));
    if (m !== undefined) {
      if (!object(m) || m.schema !== 1 || !object(m.parent) || !object(m.runs) || !object(m.outbox)
        || !Number.isSafeInteger(m.revision) || m.revision < 0 || !string(m.generation)) notices.add("Unsupported or corrupt runtime manifest ignored");
      else if (!string(m.parent.sessionFile) || await canonical(m.parent.sessionFile) !== self.sessionFile || m.parent.headerId !== self.sessionId
        || !custody(m.parent.checkpoint, m.parent.branchToken)) notices.add("Runtime session/branch custody mismatch ignored");
      else {
        if (m.custodyPaused) notices.add("Saved runtime custody paused; liveness unverified");
        let count = 0;
        for (const [id, r] of Object.entries(m.runs) as [string, any][]) {
          if (++count > MAX_RUNS) { incomplete(); break; }
          if (!object(r) || r.id !== id || !string(id) || !string(r.sessionFile) || !isAbsolute(r.sessionFile)
            || !string(r.name) || !string(r.task) || !["prepared", "dispatch-intent", "supervised"].includes(r.phase)
            || !Number.isFinite(r.startTime) || !Array.isArray(r.eventCursor)
            || (r.lineage !== undefined && (!isLineage(r.lineage) || await canonical(r.lineage.child.sessionFile) !== await canonical(r.sessionFile)))) { incomplete(); continue; }
          const key = r.lineage && await provenance(r.lineage);
          const valid = key && authorized.has(key.scope);
          const entry = add(id, r.name, r.task, valid ? r.lineage : undefined, true, valid ? key : undefined, r.startTime);
          if (!entry) continue;
          entry.binding = r.planTask;
          if (r.profile) await profile(entry, r.profile, r.sessionFile, key?.key);
        }
      }
    }
    // No manifest references grant history access: only native active-branch anchors do.
    const events = new Map<string, { data: RecordData; key: Provenance; time: number }>();
    let scanned = 0;
    for (const [directory, keys] of scopes) {
      await watch(directory, eventName);
      const batch: string[] = [];
      const gather = async () => {
        const candidates = await Promise.all(batch.splice(0).map(async name => {
          try {
            const path = join(directory, name);
            const info = await lstat(path, { bigint: true });
            if (!info.isFile() || info.size > 24576) throw new Error("Invalid history file");
            const cached = previous.get(path);
            const data = cached && sameFile(cached.info, info) ? cached.event : await load(path, 24576, info);
            if (!object(data) || data.version !== 1 || name !== `${data.id}.json` || !string(data.runId) || !isLineage(data.lineage)
              || !kinds.includes(data.kind) || typeof data.summary !== "string" || Buffer.byteLength(data.summary, "utf8") > 320
              || !string(data.timestamp) || !Number.isFinite(Date.parse(data.timestamp))
              || !Array.isArray(data.refs) || data.refs.length > 4 || !data.refs.every(string)) throw new Error("Invalid history event");
            // Cache hits are still checked against the current branch's authorized scopes.
            if (!keys.has(await scope(data.lineage))) throw new Error("History scope mismatch");
            const key = await provenance(data.lineage);
            return { path, info, data, key, time: Date.parse(data.timestamp) };
          } catch { incomplete(); return undefined; }
        }));
        for (const item of candidates) if (item) {
          if (events.size >= MAX_EVENTS && !events.has(item.data.id)) { incomplete(); break; }
          events.set(item.data.id, item);
          next.set(item.path, { info: item.info, event: item.data });
        }
      };
      try {
        for await (const item of await opendir(directory, { bufferSize: BATCH })) {
          if (++scanned > MAX_ENTRIES || events.size >= MAX_EVENTS) { incomplete(); break; }
          if (!item.isFile() || !eventName.test(item.name)) { incomplete(); continue; }
          batch.push(item.name);
          if (batch.length === BATCH) await gather();
        }
        if (batch.length) await gather();
      } catch { incomplete(); }
    }
    for (const { data: e, key, time } of [...events.values()].sort((a, b) => a.time - b.time || a.data.id.localeCompare(b.data.id))) {
      // Plan state/decision runIds may be task IDs: they are not run creation records.
      if (["state", "decision"].includes(e.kind)) continue;
      const assignment = e.kind === "assignment" || e.kind === "continuation";
      const entry = add(e.runId, e.runId, e.kind === "assignment" ? e.summary : "", e.lineage, false, key);
      if (!entry) continue;
      if (assignment && (entry.time === undefined || time < entry.time)) entry.time = time;
      if (e.kind === "assignment") entry.run.task = text(e.summary, 500) || entry.run.task;
      if (e.kind === "result" || e.kind === "failure" || e.kind === "ping") {
        entry.run.status = e.kind === "result" ? "RESULT REPORTED" : e.kind === "failure" ? "FAILURE REPORTED" : "HELP REQUESTED";
        entry.run.summary = e.kind === "failure" ? "Failure reported; requires parent review" : text(e.summary);
      }
    }
    const profiles = new Map<string, Promise<any>>();
    const entries = [...runs.values()];
    for (let i = 0; i < entries.length; i += BATCH) await Promise.all(entries.slice(i, i + BATCH).map(async entry => {
      if (!entry.root && entry.lineage) {
        // A verified lineage explicitly references the child; never read its conversation.
        const path = `${entry.lineage.child.sessionFile}.launch-profile.json`;
        if (!profiles.has(path)) profiles.set(path, (async () => {
          await watch(dirname(path), basename(path));
          return optional(path, 131072);
        })());
        await profile(entry, await profiles.get(path));
      }
      if (entry.custody?.parent === selfKey) entry.root = true;
    }));
    const seenFeedback = new Set<string>();
    for (const e of branch) {
      const message = e.type === "custom_message" ? e : e.type === "message" ? e.message : undefined;
      if (!["subagent_result", "subagent_ping"].includes(message?.customType)) continue;
      const d = message.details;
      if (!object(d) || !string(d.eventId) || seenFeedback.has(d.eventId)) continue;
      // Native delivery carries eventId, not runId. Resolve only exact known-run prefixes.
      if (!d.eventId.startsWith("subagent:")) continue;
      const matches = [];
      for (const suffix of d.eventId.matchAll(/:completion(?=:|$)/g)) {
        const candidate = runs.get(d.eventId.slice("subagent:".length, suffix.index));
        if (candidate) matches.push(candidate);
      }
      const entry = matches.length === 1 ? matches[0] : undefined;
      if (!entry?.root || !entry.lineage || !isLineage(d.lineage) || entry.custody?.key !== (await provenance(d.lineage)).key
        || !string(d.sessionFile) || await canonical(d.sessionFile) !== await canonical(entry.lineage.child.sessionFile)) continue;
      seenFeedback.add(d.eventId);
      const failure = !!(d.error || d.errorMessage || (typeof d.exitCode === "number" && d.exitCode !== 0));
      entry.run.status = message.customType === "subagent_ping" ? "HELP REQUESTED" : failure ? "FAILURE REPORTED" : "RESULT REPORTED";
      entry.run.summary = failure ? "Failure reported; requires parent review" : text(d.structuredResult?.summary) || text(d.response) || text(d.message);
      entry.run.model = text(d.runtimePlan?.model, 120) || entry.run.model;
      entry.run.thinking = text(d.runtimePlan?.thinking, 30) || entry.run.thinking;
    }
    // Attach each run once. Repeated resumes retain distinct run IDs, but descendants
    // attach to one parent session incarnation (latest assignment preceding creation).
    type TimedRun = typeof entries[number] & { time: number };
    const index = new Map<string, TimedRun[]>();
    const indexKey = (scope: string, identity: string) => JSON.stringify([scope, identity]);
    for (const entry of entries) if (entry.custody && entry.time !== undefined) {
      const key = indexKey(entry.custody.scope, entry.custody.child);
      if (!index.has(key)) index.set(key, []);
      index.get(key)!.push(entry as TimedRun);
    }
    for (const group of index.values()) group.sort((a, b) => a.time - b.time || b.id.localeCompare(a.id));
    const parents = new Map<string, string>();
    for (const [id, entry] of runs) {
      if (entry.root || !entry.custody) continue;
      const candidates = index.get(indexKey(entry.custody.scope, entry.custody.parent));
      if (!candidates || entry.time === undefined) { incomplete(); continue; }
      const time = entry.time;
      let lo = 0, hi = candidates.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (candidates[mid].time <= time) lo = mid + 1; else hi = mid;
      }
      let parent = candidates[lo - 1];
      if (parent?.id === id) parent = candidates[lo - 2];
      if (!parent) { incomplete(); continue; }
      let cursor: string | undefined = parent.id;
      const visited = new Set([id]);
      while (cursor && !visited.has(cursor)) { visited.add(cursor); cursor = parents.get(cursor); }
      if (cursor) { incomplete(); continue; }
      parents.set(id, parent.id); parent.run.children.push(entry.run);
    }
    for (const [id, entry] of runs) {
      if (parents.has(id)) continue;
      let task: ProgressTask | undefined;
      if (plan && entry.root) {
        const b = entry.binding;
        const matches = plan.tasks.filter((t: any) => b !== undefined
          ? object(b) && b.planId === plan!.planId && b.authority?.sessionId === plan!.authority.sessionId
            && b.authority?.branchInstanceId === plan!.authority.branchInstanceId && b.taskId === t.taskId
            && t.attempts.some((a: any) => a.attemptId === b.attemptId)
          : t.attempts.some((a: any) => a.runIds.includes(id)));
        if (matches.length === 1) task = tasksById.get(matches[0].taskId);
      }
      (task?.runs ?? view.unassigned).push(entry.run);
    }
    if (runs.size) {
      if (!anchors.length) incomplete();
      notices.add("Saved/assigned evidence only; results require parent review, not acceptance");
    }
  } catch { notices.add("Progress evidence unavailable or incomplete"); }
  if (notices.size) view.notice = [...notices].join("; ");
  const watches = [...targets].flatMap(([directory, names]) => [...names].map(filename => ({ directory, filename })));
  return { view, watches };
}
