# clear-pi

Global Pi extension that folds AI tool calls in the interactive transcript and **replaces the entire built-in footer** with two main lines:

1. Full working directory (Windows drive/UNC paths use backslashes), followed by the Git branch when available.
2. Model ID, thinking level, cumulative sent/received tokens, context utilization, and remaining Codex quota bars with reset countdowns.

Footer icons are configurable in `config.json`. The default symbols use Nerd Font code points; glyph availability depends on the installed font. The configuration accepts either Unicode characters or JSON `\u` escapes.

Other extensions' nonempty `setStatus` texts appear on one optional third line; clear-pi does not modify their statuses. There is no duplicate built-in cwd/model/footer line. Rendering uses the default terminal foreground throughout, with ANSI-aware width helpers. Context icon/value turn orange above 50% and red at 80% or higher. Thinking icon/value are light blue for off/minimal/low, default for medium, and red for high/xhigh/max. Thicker centered quota segments (`▰`/`▱`, with font-dependent dimensions rather than pixel sizing), followed by a `•` separator before the reset icon, are green above 40% remaining, orange from 10% through 40%, and red below 10%. Other extension status colors are stripped for a uniform base foreground. Narrow terminals first shorten the model ID and bars, then tighten spacing; any remaining overflow is ellipsized, so some fields can be hidden at small widths. Git changes request a render through `footerData.onBranchChange`. When Codex quota is enabled, a single timer wakes for the next quota fetch or visible countdown/status change; there is no periodic repaint on other providers. Shutdown restores the built-in footer and disposes the subscription, timer, client and pending UI updates.

Run `/reload` in an existing interactive Pi session to load it. No settings changes or runtime dependencies are required.

## Configuration

Edit [`config.json`](./config.json) next to `index.ts`, then run `/reload`. This file is extension-wide, not read from the current working directory. Missing or invalid fields fall back to the defaults; a malformed file produces a warning.

| `frames` key | Default title | Border and title color |
| --- | --- | --- |
| `userPrompt` | `User prompt` | Dark gray (`#595959`) |
| `agentActivity` | `Agent activity` | Blue (`#4DA3FF`) |
| `agentAnswer` | `Agent answer` | Green (`#2F9E5D`) |
| `subagentMessage` | `Message from {sender}` | Amber (`#D69E2E`) |

Each frame supports `enabled` (`true`/`false`), `title`, and `color` (`#RRGGBB`). Disabling a frame keeps the original content visible. The activity frame groups progress updates and tool calls; the answer frame encloses the final assistant text separately. Other Pi notices remain in order and may split activity frames. The prompt and amber subagent message use the terminal's default text and background colors. The activity body uses a single gray on the default background, with different shades for light and dark themes; its border keeps the configured color. The answer keeps Pi's styling. All clear-pi frames reserve two columns on the right for Pi's scrollbar/terminal edge. Native text is measured after tab expansion and removal of cursor/erase controls, so the right border stays aligned; hyperlinks and image transport are preserved.

The original amber renderer is in `pi-herdr-subagents/pi-extension/subagents/frame.ts` (`framedMessage` / `OPEN_ACCENT`), called by the `subagent_result` renderer in `pi-extension/subagents/index.ts`. With clear-pi loaded, `frames.subagentMessage` controls this result card's appearance without duplicating the report or replacing its expandable details. The subagent extension keeps its own fallback renderer when clear-pi is not loaded.

Each `footer` field (`cwd`, `gitBranch`, `model`, `thinking`, `sent`, `received`, `context`, `codexQuota`, `extensionStatuses`) has `enabled` and `icon`. For example, `"cwd": { "enabled": true, "icon": "📁" }`. Set `"icon": ""` to keep the text without its icon, or `"enabled": false` to hide the field. Older `true`/`false` values still work and use the default icon. The `codexQuota` icon marks the reset countdown; disabling that field also stops quota fetching, including `/clear-pi refresh`.

## Main Agent progress dashboard

When `pi-herdr-subagents` has recorded a plan or delegated work, a **Main Agent** panel appears above the editor. `Stages:` lists recorded plan tasks even when the main agent completes them without subagents. When there is delegated work, runs are indented beneath their stage, with role and model/thinking when recorded. With a plan, unbound runs appear under `Unassigned runs`. Without a plan, a single run with no nested runs uses a short `Plan  ·  None` layout with its status and runtime. Several runs use `Operations` with a status breakdown. The `/clear-progress expand — full view` hint sits below the frame. The expanded report adds notices, counts and rounded task/coordinator/worker/reviewer/tester cards with result excerpts. Use arrows, Page Up/Down, Home/End, or the fullscreen mouse wheel to scroll; Escape/Enter closes it. Existing **Agent activity** tool groups remain in the transcript, not duplicated into the dashboard.

| Command | Effect (UI only, no model turn) |
| --- | --- |
| `/clear-progress` or `/clear-progress expand` | Open scrollable nested run cards |
| `/clear-progress compact` | Keep the compact stages and runs panel |
| `/clear-progress off` | Hide panel and stop its file watchers |
| `/clear-progress refresh` | Reread the available records |
| `/clear-progress export` | Save the cached expanded report as a standalone HTML file |

Export writes a unique UTF-8 `.html` file under the current session's `artifacts/<session-id>/clear-progress/` directory and shows its full path. Open it in any browser: a monospace `<pre>` preserves nested frames and spacing, with horizontal scrolling and light/dark support. It uses the same expanded renderer and task/run limits at a fixed 140-column width, without viewport clipping. Portable `☐` / `☑` replace Nerd Font checkboxes so no custom font download is needed. Content is HTML-escaped, scripts/network requests are blocked, and the file contains no external assets. This is one local write from the cached snapshot—no history rescan, model request, watcher activation or automatic browser launch. If the snapshot is missing or belongs to a different session or branch leaf, export refuses to write a file and prompts you to run `/clear-progress refresh`. Terminal hyperlink destinations are discarded; their visible labels are kept. Reports may contain task feedback; review them before sharing.

`/clear-pi-progress` remains a backwards-compatible alias. While the panel is visible, clear-pi hides herdr's redundant `subagent-plan` widget; its underlying data and tools are unchanged. With this panel off, `/plan-view` restores herdr's plan view.

With the on-demand tree support in `pi-herdr-subagents`, routine progress appears only in **Main Agent**. Use `/subagents-tree expand` to open the separate amber history frame (including an empty-state message if the current branch has no saved history), or `/subagents-tree off` to close it. The **Main Agent** panel does not remove a tree opened this way. Older herdr installs can still show their original automatic tree; update the herdr extension to get the on-demand behavior.

`config.json` has an independent `progress` object: `enabled` (default `true`), `details` (default `false`), `maxTasks` (default `12`) and `maxRuns` (default `20`). Numeric settings accept integers 1–100. Run limits apply across each view; full-report counts include observed descendants even when their cards are hidden. Omitted entries are marked. The editor panel is capped at ten lines, plus the full-view hint below its bottom border, so large plans cannot consume the working area. `details` is retained for configuration compatibility; the main panel is always compact and the expanded report always includes details. The scrollable full view honors the configured task/run limits too. Command choices last until reload/session replacement; edit the file for persistent defaults.

**Meaning and limits:**

- Plan checkboxes use Nerd Font U+F0131 (unchecked) and U+F0C52 (checked). A checked stage means the plan explicitly records `accepted`. A checked run in the compact panel, including `[✓] … · completed` for a single standalone operation, means a result was reported, not that it passed review or that its stage was accepted. A `saved` or `assigned` operation does not imply that it is still running.
- Features come from the latest active-branch `pi-subagents-plan/v1` entry. UUID task IDs are displayed as `T1`, `T2`, … in plan order (presentation labels only). Work is associated through explicit plan bindings/run references and coordinator ancestry, never guessed from task wording. Unbound work has a separate section. Without a recorded plan there is no invented feature list.
- Nested history supplies observed worker/reviewer/tester runs and short feedback; the panel does not ask agents to produce another report. Counts refer to recorded runs, not OS processes or all underlying model requests. Missing/legacy/incomplete history can only give a partial picture.
- Saved assignments and launch phases are **not live process status**. Results are reported feedback, not verified acceptance; missing role/model/result fields stay unknown. Model/thinking metadata describes the saved launch when available, not a guarantee of the effective runtime.
- This is a read-only adapter for herdr's current v1 source contracts, not a public versioned dashboard API. Unsupported/corrupt records are unavailable rather than silently treated as success. Session navigation reconstructs from the selected branch; referenced descendant history is scoped to its explicit lineage anchors.
- Descendants are attached only to a confirmed parent run that had already started. If none is known, the run stays unassigned and the report marks the evidence incomplete.
- Refresh uses existing Pi boundaries and debounced, filename-filtered watchers. It checks files asynchronously, reuses unchanged event contents, and revalidates their lineage for the current branch. Late reads cannot update a different branch or reopen a disabled panel. No extra tools, prompts, model requests, session entries or network calls are introduced; explicit export alone writes a report. Unrelated/global session directories are not scanned. Watcher failures may require a native event or manual refresh.

## Collapsible AI tool calls

The arrow appears next to the AI’s own visible progress text, for example `▸ Checking loader return types`. Consecutive tool calls without a new visible update stay under the same arrow. Updates with no tools have no arrow. The first group without a suitable visible title in each **Agent activity** frame uses `▸ Agent research`; subsequent groups without a title still use `▸ AI tools`.

- In Pi's **fullscreen** TUI, click the arrow to expand or collapse just that group. The original Pi cards show the commands or other tool arguments, output and errors. Switch modes in `/settings` or launch with `--tui-mode fullscreen`.
- Use Pi's **Ctrl+O** (`app.tools.expand` by default) to expand or collapse all groups, including in regular mode where the terminal handles the mouse.
- Groups are a presentation of Pi's existing transcript, including resumed sessions. They do not change execution, exports, or model context, store a second log, or capture commands run manually via `!`. Work invisible to Pi's transcript (such as shell subprocesses inside a tool, or calls in a separate agent session) does not get a separate card here. Individual expansion choices aren't saved across transcript rebuilds.

The grouping adapter uses Pi’s private interactive document layout. **Pi 1.6.0** is the supported version, verified in regular and fullscreen modes; other versions are not verified. If the adapter does not recognize the layout, it leaves the native transcript unchanged. Completed transcript fragments cache their rendered lines; the current turn and expanded native tools remain live.

## Metric meanings

- **Sent** sums `usage.input + usage.cacheRead + usage.cacheWrite`; **received** sums `usage.output`. These are cumulative reported model-token counts, not network bytes, unique prompt tokens, or quota consumption. Cache hits are intentionally included; repeated context is counted on each model request. `totalTokens` is never added, avoiding double counting.
- Only `ctx.sessionManager.getBranch()` is scanned, so abandoned branches do not contribute. Like the installed Pi footer's accounting conventions, separately recorded tool-result usage (including nested model usage), usage entries, compaction usage and branch-summary usage are included in addition to assistant usage. These totals survive compaction for entries remaining on the active branch; they are not limited to the current model/provider or the post-compaction context. Entries without usage contribute nothing; a new empty branch shows zero.
- **Context** is the current `ctx.getContextUsage().percent`, not cumulative sent tokens divided by context size. Pi estimates trailing messages and can return unknown after compaction. Missing/null/nonfinite percentages display `?%`, not zero. Thinking uses the current `ctx.thinkingLevel`.
- **Quota** is separate account-level Codex usage, not session token usage. Each returned window is labeled by server duration (for example `5h`, `7d0h`); missing durations use `primary`/`secondary`. Bars fill in proportion to **remaining** quota, with an explicit percentage. The group is labeled `Codex`, without a `left` suffix. Percentages are rounded.
- Reset countdowns use minutes/hours/days. Unknown resets show `?`; a passed reset shows `due`, never fabricated replenishment. `limited` reflects the server's account-limit flag. Cache expiry, reset expiry and transient failures explicitly mark data `stale`, with sanitized failure reasons when available. Missing data displays loading/error/unsupported states, never unlimited or zero usage.

## Commands and refresh

- `/clear-pi` shows the current cached status without sending a model message or fetching again.
- `/clear-pi refresh` requests a snapshot. Concurrent requests share one refresh; manual attempts have a 10-second minimum interval.
- With an active `openai-codex` model in **TUI mode**, startup fetches automatically and subsequent fetches follow the five-minute cache. Failures retry no more than once per minute automatically.
- Other providers show `unsupported provider` without polling. Switching between Codex models preserves cache and in-flight requests. Print/JSON/RPC modes do not install a footer, poll or resolve credentials; in RPC the command reports `TUI only`.

## Security and limitations

`UsageClient` uses the **unofficial**, undocumented endpoint `https://chatgpt.com/backend-api/wham/usage`. It may change, return incomplete windows, be unavailable for an account, or reject access. This is not an official OpenAI usage integration, a billing balance, or a guarantee of available requests. Missing/invalid windows are never interpreted as zero usage or unlimited access. Credits, plan names, balances, account identifiers and unrelated response fields are neither displayed nor persisted.

Authentication comes only from Pi's public `ctx.modelRegistry.getProviderAuth("openai-codex")`, allowing Pi to handle OAuth refresh and normal credential storage. The extension does not read/write credential files or perform its own OAuth refresh. It accepts a JWT-shaped access token with the same account claim used by Pi's Codex transport; decoding is not signature verification. Plain API keys and non-ChatGPT auth base-URL overrides are unsupported. Custom auth headers are never forwarded. Only the bearer token and derived account header go to the fixed HTTPS endpoint, with redirects disabled. A project or response cannot configure the endpoint.

Each attempt is bounded to eight seconds, including auth resolution, fetching and body parsing. Fetch receives an abort signal; response bodies are limited to 64 KiB. Pi's auth API takes no cancellation signal: a timed-out operation may continue inside Pi, but cannot start a late usage request. Its pending promise is reused to avoid overlapping extension-initiated auth resolutions. Shutdown/provider changes abort active work and discard the in-memory quota cache. Multiple Pi processes maintain independent caches.

Network/HTTP/schema failures show only fixed sanitized labels. Authentication/access failures clear cached quota; transient failures retain it as stale. No credentials, raw responses, exceptions or quota snapshots are logged, written to files, appended to session history or sent to a model by this extension. Pi itself remains responsible for its normal auth persistence and logging.

## Verification

Requires Node.js with native TypeScript stripping (tested with Node 24.21.0) and an installed Pi:

```sh
cd ~/.pi/agent/extensions/clear-pi
npm test
```

The test-only resolver uses Pi from `npm root -g`, or `PI_PACKAGE_DIR` if supplied. The integration test uses the installed Pi 1.6.0 agent loop and TUI with an offline streaming provider and simulated terminal. It covers the native `read` card, fullscreen mouse input, branch navigation, native Ctrl+O, and fallback when the document layout is unrecognized. `npm run bench:transcript` and `npm run bench:progress` run the synthetic performance checks. The explicit package manifest exposes only `index.ts`; helper files and tests are not extension entry points.

Mock-only tests cover quota parsing/security/cache/timeouts, actual footer component creation/rendering, requested Unicode, ANSI/wide glyphs and widths 0–250, context unknown/zero, branch accounting, Git/session branch changes, provider switching, timer repaint, commands, subscription cleanup, shutdown and late completion. No credentials are read and no real endpoint is probed. The installed Pi extension loader also loaded the entry point without errors, invoked the footer factory/render with a mocked context, and verified shutdown restoration/unsubscription. Mock verification does not establish live endpoint availability, account quota accuracy, or the font's visual rendering; those require independent terminal/account review. The test suite uses native TypeScript stripping; `npm test` does not perform a static type check.

Implementation references: installed Pi `docs/extensions.md`, `docs/tui.md`, `examples/extensions/custom-footer.ts`, `dist/core/extensions/types.d.ts`, and `dist/modes/interactive/components/footer.js`.
