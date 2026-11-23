import assert from "node:assert/strict";
import test from "node:test";
import { CACHE_MS, MIN_REFRESH_MS, USAGE_URL, UsageClient, parseUsage } from "../usage.ts";

const token = (account = "mock-account") => `header.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: account } })).toString("base64url")}.signature`;
const auth = async () => ({ auth: { apiKey: token(), headers: { "X-Secret": "never-forward" } } });
const payload = (used = 25) => ({ rate_limit: { allowed: true, primary_window: { used_percent: used, limit_window_seconds: 18000, reset_after_seconds: 3600 }, secondary_window: { used_percent: 60, limit_window_seconds: 604800, reset_at: 1900000000 } }, credits: { ignored: true } });
const response = () => Response.json(payload());
const setup = (fetcher = async () => response(), timeoutMs = 100) => {
  let now = 1800000000000;
  const calls: { url: unknown; init: RequestInit | undefined }[] = [];
  const client = new UsageClient({ now: () => now, timeoutMs, fetch: (async (url, init) => { calls.push({ url, init }); return fetcher(); }) as typeof fetch });
  return { client, calls, advance: (ms: number) => { now += ms; } };
};

test("parses both windows, reset seconds and timestamps; ignores unrelated fields", () => {
  const parsed = parseUsage(payload(), 1000);
  assert.deepEqual(parsed, { at: 1000, blocked: false, windows: [{ used: 25, seconds: 18000, resetAt: 3601000 }, { used: 60, seconds: 604800, resetAt: 1900000000000 }] });
});
test("accepts zero/full usage and partial windows; rejects malformed quotas", () => {
  for (const used of [0, 100]) assert.equal(parseUsage({ rate_limit: { secondary_window: { used_percent: used } } }, 0).windows[0].used, used);
  for (const used of [-1, 101, "20", null, NaN, Infinity]) assert.throws(() => parseUsage({ rate_limit: { primary_window: { used_percent: used } } }, 0), /unsupported response/);
  for (const value of [null, {}, { rate_limit: {} }]) assert.throws(() => parseUsage(value, 0));
});
test("trusted endpoint, minimal headers, no redirects, normalized footer", async () => {
  const { client, calls } = setup();
  await client.refresh(auth);
  assert.equal(calls[0].url, USAGE_URL);
  assert.equal(calls[0].init?.redirect, "error");
  assert.deepEqual(Object.keys(calls[0].init!.headers!).sort(), ["Accept", "Authorization", "ChatGPT-Account-Id"]);
  assert.match(client.status(), /5h 75% left ↻1h/);
  assert.match(client.status(), /7d0h 40% left/);
  assert.doesNotMatch(client.status(), /mock-account|signature|credits/);
  client.dispose();
});
test("cache, force cooldown and shared in-flight refresh", async () => {
  let release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const { client, calls, advance } = setup(async () => { await waiting; return response(); });
  const first = client.refresh(auth);
  assert.equal(first, client.refresh(auth, true));
  release(); await first;
  await client.refresh(auth); await client.refresh(auth, true);
  assert.equal(calls.length, 1);
  advance(MIN_REFRESH_MS); await client.refresh(auth, true);
  assert.equal(calls.length, 2);
  advance(CACHE_MS); await client.refresh(auth);
  assert.equal(calls.length, 3);
  client.dispose();
});
test("network failure keeps snapshot explicitly stale without leaking errors", async () => {
  let fail = false;
  const { client, advance } = setup(async () => { if (fail) throw new Error("secret raw payload"); return response(); });
  await client.refresh(auth); fail = true; advance(CACHE_MS);
  await client.refresh(auth);
  assert.match(client.status(), /75% left.*stale \(unavailable\)/);
  assert.doesNotMatch(client.status(), /secret/);
  client.dispose();
});
for (const [code, label] of [[401, "login required"], [403, "access denied"], [429, "rate limited"], [500, "unavailable"]] as const) {
  test(`sanitized HTTP ${code}`, async () => {
    const { client } = setup(async () => new Response("secret response", { status: code }));
    await client.refresh(auth);
    assert.equal(client.status(), `Codex usage: ${label}`);
    client.dispose();
  });
}
test("unsupported credentials and proxy overrides never issue a request", async () => {
  for (const resolved of [undefined, { auth: { apiKey: "api-key" } }, { auth: { apiKey: token(), baseUrl: "https://proxy.invalid" } }]) {
    const { client, calls } = setup();
    await client.refresh(async () => resolved);
    assert.equal(calls.length, 0);
    assert.match(client.status(), /login required|unsupported auth/);
    client.dispose();
  }
});
test("malformed and oversized bodies fail safely", async () => {
  for (const body of ["not json", JSON.stringify({ private: "ignored" }), " ".repeat(65537)]) {
    const { client } = setup(async () => new Response(body));
    await client.refresh(auth);
    assert.equal(client.status(), "Codex usage: unsupported response");
    client.dispose();
  }
});
test("bounded auth timeout reuses pending auth and prevents late fetch", async () => {
  const { client, calls, advance } = setup(undefined, 10);
  let release!: (value: Awaited<ReturnType<typeof auth>>) => void;
  let authCalls = 0;
  const waiting = new Promise<Awaited<ReturnType<typeof auth>>>(resolve => { release = resolve; });
  const resolver = () => { authCalls++; return waiting; };
  await client.refresh(resolver);
  assert.equal(client.status(), "Codex usage: timeout");
  advance(CACHE_MS);
  await client.refresh(resolver);
  assert.equal(authCalls, 1);
  release(await auth());
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, 0);
  client.dispose();
});
test("timeout aborts fetch and shutdown prevents late updates", async () => {
  let signal: AbortSignal | undefined;
  const client = new UsageClient({ now: Date.now, timeoutMs: 10, fetch: (async (_url, init) => {
    signal = init?.signal as AbortSignal;
    return new Promise(() => {});
  }) as typeof fetch });
  await client.refresh(auth);
  assert.equal(signal?.aborted, true);
  assert.equal(client.status(), "Codex usage: timeout");
  client.dispose();
  let release!: (value: Response) => void;
  const delayed = setup(() => new Promise(resolve => { release = resolve; }));
  const flight = delayed.client.refresh(auth);
  await new Promise(resolve => setImmediate(resolve));
  delayed.client.dispose(); release(response()); await flight;
  assert.equal(delayed.client.snapshot, undefined);
});
test("account changes cannot display previous account's stale snapshot", async () => {
  let fail = false;
  const { client, advance } = setup(async () => { if (fail) throw new Error(); return response(); });
  await client.refresh(auth); advance(CACHE_MS); fail = true;
  await client.refresh(async () => ({ auth: { apiKey: token("different-account") } }));
  assert.equal(client.snapshot, undefined);
  client.dispose();
});
test("display deadlines match hourly, minute, stale and reset-due transitions", () => {
  const { client } = setup();
  const resetAt = 25 * 60 * 60_000;
  client.snapshot = { at: 0, blocked: false, windows: [{ used: 25, resetAt }] };
  assert.equal(client.nextDisplayChangeAt(0), 60_000); // 1d1h → 1d0h.
  assert.equal(client.nextDisplayChangeAt(60_000), CACHE_MS);
  assert.equal(client.nextDisplayChangeAt(CACHE_MS), 61 * 60_000); // Days/hours → minutes.
  assert.equal(client.nextDisplayChangeAt(61 * 60_000), 62 * 60_000);
  assert.equal(client.nextDisplayChangeAt(resetAt - 1), resetAt);
  assert.equal(client.nextDisplayChangeAt(resetAt), Infinity);
  client.dispose();
});

test("reset expiry is stale, never fabricated as a replenished quota", async () => {
  const { client, advance } = setup();
  await client.refresh(auth); advance(3600001);
  assert.match(client.status(), /75% left reset due.*stale/);
  client.dispose();
});
