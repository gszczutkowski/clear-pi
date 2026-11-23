# clear-pi

Global Pi extension that folds AI tool calls in the interactive transcript and **replaces the entire built-in footer** with two main lines:

1. Full cwd (Windows drive/UNC paths use backslashes), followed by `(\uEC6F branch)` when a Git branch is available.
2. Model ID, thinking level, cumulative sent/received tokens, context utilization, and remaining Codex quota bars with reset countdowns.

The icon escapes above and below denote actual Unicode characters, not literal escape text. The footer uses U+E28C (model), U+EC59 (thinking), U+F0552 (sent), U+F01DA (received), U+F0238 (context), and U+F0450 (reset). U+F0450 is a valid supplementary private-use codepoint and is retained exactly as requested; whether it has a glyph depends on the installed Nerd Font/version. Pi's width helpers measure rendered columns, but font-specific glyph appearance needs terminal verification.

Other extensions' nonempty `setStatus` texts appear on one optional third line; clear-pi does not modify their statuses. There is no duplicate built-in cwd/model/footer line. Rendering uses the default terminal foreground throughout, with ANSI-aware width helpers. Context icon/value turn orange above 50% and red at 80% or higher. Thinking icon/value are light blue for off/minimal/low, default for medium, and red for high/xhigh/max. Thicker centered quota segments (`▰`/`▱`, with font-dependent dimensions rather than pixel sizing), followed by a `•` separator before the reset icon, are green above 40% remaining, orange from 10% through 40%, and red below 10%. Other extension status colors are stripped for a uniform base foreground. Narrow terminals first shorten the model ID and bars, then tighten spacing; any remaining overflow is ellipsized, so some fields can be hidden at small widths. Git changes request a render through `footerData.onBranchChange`. Countdown/cache checks run once per second without forcing network requests. Shutdown restores the built-in footer and disposes the subscription, timer, client and pending UI updates.

Run `/reload` in an existing interactive Pi session to load it. No settings changes or runtime dependencies are required.

## Configuration

Edit [`config.json`](./config.json) next to `index.ts`, then run `/reload`. This file is extension-wide, not read from the current working directory. Missing or invalid fields fall back to the defaults; a malformed file produces a warning.

| `frames` key | Default title | Border and title color |
| --- | --- | --- |
| `userPrompt` | `User prompt` | Dark gray (`#595959`) |
| `agentActivity` | `Agent activity` | Blue (`#4DA3FF`) |
| `agentAnswer` | `Agent answer` | Green (`#2F9E5D`) |
| `subagentMessage` | `Message from {sender}` | Amber (`#D69E2E`) |

Each frame supports `enabled` (`true`/`false`), `title`, and `color` (`#RRGGBB`). Disabling a frame keeps the original content visible. The activity frame groups progress updates and tool calls; the answer frame encloses the final assistant text separately. Other Pi notices remain in order and may split activity frames. The colors and markup inside frames still follow Pi's theme.

The original amber renderer is in `pi-herdr-subagents/pi-extension/subagents/frame.ts` (`framedMessage` / `OPEN_ACCENT`), called by the `subagent_result` renderer in `pi-extension/subagents/index.ts`. With clear-pi loaded, `frames.subagentMessage` controls this result card's appearance without duplicating the report or replacing its expandable details. The subagent extension keeps its own fallback renderer when clear-pi is not loaded.

The `footer` object contains independent switches: `cwd`, `gitBranch`, `model`, `thinking`, `sent`, `received`, `context`, `codexQuota`, and `extensionStatuses`. Set a field to `false` to hide it. Empty lines are omitted. Turning off `codexQuota` also disables quota fetching, including `/clear-pi refresh`.

## Collapsible AI tool calls

The arrow appears next to the AI’s own visible progress text, for example `▸ Checking loader return types`. Consecutive tool calls without a new visible update stay under the same arrow. Updates with no tools have no arrow. A group with no suitable visible title uses `▸ AI tools` as a fallback.

- In Pi's **fullscreen** TUI, click the arrow to expand or collapse just that group. The original Pi cards show the commands or other tool arguments, output and errors. Switch modes in `/settings` or launch with `--tui-mode fullscreen`.
- Use Pi's **Ctrl+O** (`app.tools.expand` by default) to expand or collapse all groups, including in regular mode where the terminal handles the mouse.
- Groups are a presentation of Pi's existing transcript, including resumed sessions. They do not change execution, exports, or model context, store a second log, or capture commands run manually via `!`. Work invisible to Pi's transcript (such as shell subprocesses inside a tool, or calls in a separate agent session) does not get a separate card here. Individual expansion choices aren't saved across transcript rebuilds.

The grouping adapter targets the Pi 1.5 interactive document layout. If that layout is not found, it leaves the native tool display unchanged.

## Metric meanings

- **Sent** sums `usage.input + usage.cacheRead + usage.cacheWrite`; **received** sums `usage.output`. These are cumulative reported model-token counts, not network bytes, unique prompt tokens, or quota consumption. Cache hits are intentionally included; repeated context is counted on each model request. `totalTokens` is never added, avoiding double counting.
- Only `ctx.sessionManager.getBranch()` is scanned, so abandoned branches do not contribute. Like the installed Pi footer's accounting conventions, separately recorded tool-result usage (including nested model usage), usage entries, compaction usage and branch-summary usage are included in addition to assistant usage. These totals survive compaction for entries remaining on the active branch; they are not limited to the current model/provider or the post-compaction context. Entries without usage contribute nothing; a new empty branch shows zero.
- **Context** is the current `ctx.getContextUsage().percent`, not cumulative sent tokens divided by context size. Pi estimates trailing messages and can return unknown after compaction. Missing/null/nonfinite percentages display `?%`, not zero. Thinking uses the current `ctx.thinkingLevel`.
- **Quota** is separate account-level Codex usage, not session token usage. Each returned window is labeled by server duration (for example `5h`, `7d0h`); missing durations use `primary`/`secondary`. Bars fill in proportion to **remaining** quota, with an explicit percentage. The group is labeled `Codex`, without a `left` suffix. Percentages are rounded.
- Reset countdowns use minutes/hours/days. Unknown resets show `?`; a passed reset shows `due`, never fabricated replenishment. `limited` reflects the server's account-limit flag. Cache expiry, reset expiry and transient failures explicitly mark data `stale`, with sanitized failure reasons when available. Missing data displays loading/error/unsupported states, never unlimited or zero usage.

## Commands and refresh

- `/clear-pi` shows the current cached status without sending a model message or fetching again.
- `/clear-pi refresh` requests a snapshot. Concurrent requests share one refresh; manual attempts have a 10-second minimum interval.
- With an active `openai-codex` model in **TUI mode**, startup fetches automatically. The timer and agent settlement check the five-minute cache. Failures retry at most once per minute automatically.
- Other providers show `unsupported provider` without polling. Switching between Codex models preserves cache and in-flight requests. Print/JSON/RPC modes do not install a footer, poll or resolve credentials; in RPC the command reports `TUI only`.

## Security and limitations

The unchanged `UsageClient` uses the **unofficial**, undocumented endpoint `https://chatgpt.com/backend-api/wham/usage`. It may change, return incomplete windows, be unavailable for an account, or reject access. This is not an official OpenAI usage integration, a billing balance, or a guarantee of available requests. Missing/invalid windows are never interpreted as zero usage or unlimited access. Credits, plan names, balances, account identifiers and unrelated response fields are neither displayed nor persisted.

Authentication comes only from Pi's public `ctx.modelRegistry.getProviderAuth("openai-codex")`, allowing Pi to handle OAuth refresh and normal credential storage. The extension does not read/write credential files or perform its own OAuth refresh. It accepts a JWT-shaped access token with the same account claim used by Pi's Codex transport; decoding is not signature verification. Plain API keys and non-ChatGPT auth base-URL overrides are unsupported. Custom auth headers are never forwarded. Only the bearer token and derived account header go to the fixed HTTPS endpoint, with redirects disabled. A project or response cannot configure the endpoint.

Each attempt is bounded to eight seconds, including auth resolution, fetching and body parsing. Fetch receives an abort signal; response bodies are limited to 64 KiB. Pi's auth API takes no cancellation signal: a timed-out operation may continue inside Pi, but cannot start a late usage request. Its pending promise is reused to avoid overlapping extension-initiated auth resolutions. Shutdown/provider changes abort active work and discard the in-memory quota cache. Multiple Pi processes maintain independent caches.

Network/HTTP/schema failures show only fixed sanitized labels. Authentication/access failures clear cached quota; transient failures retain it as stale. No credentials, raw responses, exceptions or quota snapshots are logged, written to files, appended to session history or sent to a model by this extension. Pi itself remains responsible for its normal auth persistence and logging.

## Verification

Requires Node.js with native TypeScript stripping (tested with Node 24.21.0) and an installed Pi:

```sh
cd ~/.pi/agent/extensions/clear-pi
npm test
```

The test-only resolver uses Pi from `npm root -g`, or `PI_PACKAGE_DIR` if supplied, to exercise its actual TUI width helpers and tool cards without installing another copy. Tests cover independent groups, streaming updates, mouse routing, global toggling, transcript rebuilds, narrow widths and cleanup. The explicit package manifest exposes only `index.ts`; helper files and tests are not extension entry points.

Mock-only tests cover quota parsing/security/cache/timeouts, actual footer component creation/rendering, requested Unicode, ANSI/wide glyphs and widths 0–250, context unknown/zero, branch accounting, Git/session branch changes, provider switching, timer repaint, commands, subscription cleanup, shutdown and late completion. No credentials are read and no real endpoint is probed. The installed Pi extension loader also loaded the entry point without errors, invoked the footer factory/render with a mocked context, and verified shutdown restoration/unsubscription. Mock verification does not establish live endpoint availability, account quota accuracy, or the font's visual rendering; those require independent terminal/account review. The test suite uses native TypeScript stripping; `npm test` does not perform a static type check.

Implementation references: installed Pi `docs/extensions.md`, `docs/tui.md`, `examples/extensions/custom-footer.ts`, `dist/core/extensions/types.d.ts`, and `dist/modes/interactive/components/footer.js`.
