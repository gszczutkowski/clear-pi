// Only the normalized quota snapshot survives a request. Never retain response bodies.
export const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
export const CACHE_MS = 5 * 60_000;
export const RETRY_MS = 60_000;
export type Auth = { auth: { apiKey?: string; baseUrl?: string } } | undefined;
export type Window = { kind: "primary" | "secondary"; used: number; seconds?: number; resetAt?: number };
export type Snapshot = { windows: Window[]; at: number; blocked: boolean };
type Failure = "login required" | "unsupported auth" | "unsupported response" | "access denied" | "rate limited" | "unavailable" | "timeout";
class UsageError extends Error {
  reason: Failure;
  constructor(reason: Failure) { super(reason); this.reason = reason; }
}
const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

export function parseUsage(data: unknown, now: number): Snapshot {
  const limit = record(record(data)?.rate_limit);
  const windows: Window[] = [];
  for (const kind of ["primary", "secondary"] as const) {
    const item = record(limit?.[`${kind}_window`]);
    if (!item) continue;
    if (!finite(item.used_percent) || item.used_percent < 0 || item.used_percent > 100) continue;
    const seconds = finite(item.limit_window_seconds) && item.limit_window_seconds > 0 ? item.limit_window_seconds : undefined;
    let resetAt: number | undefined;
    if (finite(item.reset_at) && item.reset_at >= 0 && item.reset_at <= 8.64e12) resetAt = item.reset_at * 1000;
    else if (finite(item.reset_after_seconds) && item.reset_after_seconds >= 0 && item.reset_after_seconds <= 31536000)
      resetAt = now + item.reset_after_seconds * 1000;
    windows.push({ kind, used: item.used_percent, seconds, resetAt });
  }
  if (!windows.length) throw new UsageError("unsupported response");
  return { windows, at: now, blocked: limit?.allowed === false || limit?.limit_reached === true };
}

function requestIdentity(resolved: Auth): { token: string; account: string } {
  if (!resolved?.auth.apiKey) throw new UsageError("login required");
  // Reject proxy overrides; never forward their headers or credentials to a chosen URL.
  if (resolved.auth.baseUrl) {
    try {
      const url = new URL(resolved.auth.baseUrl);
      if (url.origin !== "https://chatgpt.com" || url.username || url.password) throw new Error();
    } catch { throw new UsageError("unsupported auth"); }
  }
  const token = resolved.auth.apiKey;
  try {
    const parts = token.split(".");
    if (parts.length !== 3 || token.length > 32768 || /\s/.test(token)) throw new Error();
    const payload = record(JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")));
    const account = record(payload?.["https://api.openai.com/auth"])?.chatgpt_account_id;
    if (typeof account !== "string" || !/^[a-zA-Z0-9_-]{1,256}$/.test(account)) throw new Error();
    return { token, account };
  } catch { throw new UsageError("unsupported auth"); }
}

async function readUsage(response: Response): Promise<unknown> {
  if (!response.body) throw new UsageError("unsupported response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 65536) throw new UsageError("unsupported response");
      chunks.push(value);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
    catch { throw new UsageError("unsupported response"); }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

const MINUTE_MS = 60_000;
const durationMinutes = (ms: number) => Math.max(0, Math.ceil(ms / MINUTE_MS));

export function duration(ms: number): string {
  const minutes = durationMinutes(ms);
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h${minutes % 60 ? `${minutes % 60}m` : ""}`;
  return `${Math.floor(minutes / 1440)}d${Math.floor(minutes % 1440 / 60)}h`;
}

export class UsageClient {
  snapshot?: Snapshot;
  failure?: Failure;
  private account?: string;
  private lastAttempt = -Infinity;
  private pending?: Promise<void>;
  private authPending?: Promise<Auth>;
  private controller?: AbortController;
  private disposed = false;
  private deps: { fetch: typeof fetch; now: () => number; timeoutMs?: number };
  constructor(deps: { fetch: typeof fetch; now: () => number; timeoutMs?: number }) { this.deps = deps; }

  nextRefreshAt(): number {
    if (this.disposed || this.pending) return Infinity;
    return this.lastAttempt + (this.failure ? RETRY_MS : CACHE_MS);
  }

  nextDisplayChangeAt(now: number): number {
    const snapshot = this.snapshot;
    if (!snapshot) return Infinity;
    const expiry = snapshot.at + CACHE_MS;
    const alreadyStale = this.failure || snapshot.windows.some(w => w.resetAt !== undefined && w.resetAt <= now);
    let next = !alreadyStale && expiry > now ? expiry : Infinity;
    for (const { resetAt } of snapshot.windows) {
      if (resetAt === undefined || resetAt <= now) continue;
      const minutes = durationMinutes(resetAt - now);
      // The display omits minute precision while it shows days and hours.
      const bucketStart = minutes >= 1440 ? Math.floor(minutes / 60) * 60 : minutes;
      next = Math.min(next, resetAt - (bucketStart - 1) * MINUTE_MS);
    }
    return next;
  }

  refresh(resolveAuth: () => Promise<Auth>): Promise<void> {
    if (this.pending) return this.pending;
    const now = this.deps.now();
    if (now < this.nextRefreshAt()) return Promise.resolve();
    this.lastAttempt = now;
    this.controller = new AbortController();
    const signal = this.controller.signal;
    this.pending = this.load(resolveAuth, signal).finally(() => { this.pending = undefined; });
    return this.pending;
  }

  private async load(resolveAuth: () => Promise<Auth>, signal: AbortSignal): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cancelled = new Promise<never>((_, reject) => {
      signal.addEventListener("abort", () => reject(new UsageError("timeout")), { once: true });
      timer = setTimeout(() => this.controller?.abort(), this.deps.timeoutMs ?? 8000);
    });
    try {
      const work = async () => {
        // Public Pi auth resolution has no AbortSignal argument. Reuse an unresolved
        // resolution after timeout rather than launching overlapping token refreshes.
        this.authPending ??= Promise.resolve().then(resolveAuth).finally(() => { this.authPending = undefined; });
        const resolved = await this.authPending;
        signal.throwIfAborted();
        const { token, account } = requestIdentity(resolved);
        if (this.account !== account) this.snapshot = undefined;
        this.account = account;
        const response = await this.deps.fetch(USAGE_URL, {
          method: "GET", redirect: "error", cache: "no-store", signal,
          headers: { Authorization: `Bearer ${token}`, "ChatGPT-Account-Id": account, Accept: "application/json" },
        });
        signal.throwIfAborted();
        if (!response.ok) {
          await response.body?.cancel().catch(() => {});
          throw new UsageError(response.status === 401 ? "login required" : response.status === 403 ? "access denied" : response.status === 429 ? "rate limited" : "unavailable");
        }
        const snapshot = parseUsage(await readUsage(response), this.deps.now());
        signal.throwIfAborted();
        this.snapshot = snapshot;
        this.failure = undefined;
      };
      await Promise.race([work(), cancelled]);
    } catch (error) {
      if (!this.disposed) {
        this.failure = error instanceof UsageError ? error.reason : "unavailable";
        if (this.failure === "login required" || this.failure === "unsupported auth" || this.failure === "access denied") this.snapshot = undefined;
      }
    } finally { clearTimeout(timer); }
  }

  dispose(): void {
    this.disposed = true;
    this.controller?.abort();
    this.snapshot = undefined;
    this.account = undefined;
  }
}
