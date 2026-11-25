# clear-pi

Global Pi extension that folds AI tool calls in the interactive transcript and **replaces the entire built-in footer** with two main lines:

1. Full working directory (Windows drive/UNC paths use backslashes), followed by the Git branch when available.
2. Model ID, thinking level, cumulative sent/received tokens, context utilization, and remaining Codex quota bars with reset countdowns.

Footer icons are configurable in `config.json`. The default symbols use Nerd Font code points; glyph availability depends on the installed font. The configuration accepts either Unicode characters or JSON `\u` escapes.

Other extensions' nonempty `setStatus` texts appear on one optional third line; clear-pi does not modify their statuses. There is no duplicate built-in cwd/model/footer line. Rendering uses the default terminal foreground throughout, with ANSI-aware width helpers. Context icon/value turn orange above 50% and red at 80% or higher. Thinking icon/value are light blue for off/minimal/low, default for medium, and red for high/xhigh/max. Thicker centered quota segments (`▰`/`▱`, with font-dependent dimensions rather than pixel sizing), followed by a `•` separator before the reset icon, are green above 40% remaining, orange from 10% through 40%, and red below 10%. Other extension status colors are stripped for a uniform base foreground. Narrow terminals first shorten the model ID and bars, then tighten spacing; any remaining overflow is ellipsized, so some fields can be hidden at small widths. Git changes request a render through `footerData.onBranchChange`. When Codex quota is enabled, a single timer wakes for the next quota fetch or visible countdown/status change; there is no periodic repaint on other providers. Shutdown restores the built-in footer and disposes the subscription, timer, client and pending UI updates.

For a global installation, place the `clear-pi` directory under `~/.pi/agent/extensions/` (or configure it as an extension path), then start Pi 1.6.0 or run `/reload` in an existing interactive session. No additional runtime packages are required beyond Pi and its bundled libraries.

## Installation and releases

Install a versioned release directly in Pi (replace `2.0.0` with an existing release):

```sh
pi install git:github.com/gszczutkowski/clear-pi@v2.0.0
```

Do not also load a manual copy under `~/.pi/agent/extensions/`: that would load the extension twice. Pi 1.6.0 is the supported host. Node.js 24 or later is required by this package.

Every PR must increase the stable SemVer version in `package.json` and `package-lock.json` and add a matching entry to `CHANGELOG.md`. Use patch for fixes/maintenance (including docs/CI-only PRs), minor for compatible features and major for breaking changes. See [AGENTS.md](./AGENTS.md). CI checks that the version is greater than the latest `main`; if another PR takes your version first, update your PR before merging.

Every push to `main`, including a PR merged using GitHub's merge, squash or rebase option, runs `.github/workflows/release.yml`. It verifies and packages **exactly that event's commit**, creates `vX.Y.Z` from the reviewed package version and publishes a GitHub Release with `clear-pi-X.Y.Z.tgz`. It never changes files, commits or pushes to `main`, and does not apply an additional version bump. The Git tag, manifest, changelog and tarball therefore share the same version. Each event gets its own run, without replacing pending releases.

Keep **Restrict deletions**, **Require a pull request before merging** and **Block force pushes** enabled for `main`. No branch bypass or GitHub App is needed. Under the PR rule, require the **verify** check from the **CI** workflow and enable **Require branches to be up to date before merging** (under required status checks). This ensures a second PR cannot reuse a version after the first merges. Run CI once if the check is not yet available to select.

GitHub Actions needs `contents: write` (declared in the release workflow) to create tags and Releases. Repository/organization policy must allow that permission; if needed, select **Read and write permissions** under **Settings → Actions → General**. Any separate tag ruleset must allow Actions to create `v*` tags. Do not grant permission to force-update or delete release tags. No npm credentials or permission to create/approve PRs are needed.

CI also runs on pull requests and uploads a preview `.tgz` artifact. Release tarballs contain the TypeScript runtime sources (Pi loads them directly), configuration, README and changelog, not tests, development dependencies or CI files. To use a downloaded tarball without Git:

```sh
mkdir clear-pi-release
tar -xzf clear-pi-2.0.0.tgz -C clear-pi-release
pi install ./clear-pi-release/package
```

Keep the extracted directory: local Pi installations reference it rather than copying it. Review the package before installing, as extensions execute code.

To prepare a PR, run `npm version patch --no-git-tag-version` (or `minor` / `major`) and add the changelog entry. To verify locally, run `git fetch origin main`, `npm ci`, `npm run check:version -- --base origin/main`, `npm run typecheck`, `npm test`, `npm run check:package`, then `npm run pack`. No compilation step is necessary.

Packages include the `pi-package` discovery keyword and an explicit Pi extension manifest. This workflow does **not** publish to npm or automatically list the project in the pi.dev gallery. Publishing to npm (after checking name availability and configuring registry authentication) is a separate opt-in step; GitHub-tag installation works without it.

If publication fails, rerun the failed release job in GitHub Actions. It keeps the same version and source SHA, accepts an existing tag only when it points to that SHA, and creates the Release or replaces its package asset. It never moves an existing tag to another commit. A version collision with different source fails explicitly and must be resolved in a new PR with a higher version, not by deleting or moving the old tag.

## Configuration

Edit [`config.json`](./config.json) next to `index.ts`, then run `/reload`. This file is extension-wide, not read from the current working directory. Missing or invalid values fall back to the defaults. Pi shows a warning for malformed files and unknown keys, including typos in nested options.

| `frames` key | Default title | Shipped color | Fallback color |
| --- | --- | --- | --- |
| `userPrompt` | `User prompt` | `#4DA3FF` | `#595959` |
| `agentActivity` | `Agent activity` | `#A78BCA` | `#4DA3FF` |
| `agentAnswer` | `Agent answer` | `#3FBF78` | `#2F9E5D` |
| `subagentMessage` (legacy; recognized messages now use `agentActivity`) | — | — | — |

Each frame supports `enabled` (`true`/`false`), `title`, and `color` (`#RRGGBB`). Disabling a frame keeps the original content visible. The activity frame groups progress updates and tool calls; the answer frame encloses the final assistant text separately. Other Pi notices remain in order and may split activity frames. The prompt uses the terminal's default text and background colors. The activity body uses a single gray on the default background, with different shades for light and dark themes; its border keeps the configured color. The answer keeps Pi's styling. All clear-pi frames reserve two columns on the right for Pi's scrollbar/terminal edge. Native text is measured after tab expansion and removal of cursor/erase controls, so the right border stays aligned; hyperlinks and image transport are preserved.

`transcriptNotices.skill` supports `enabled`, `title`, and `color`, defaulting to an orange (`#FF9F43`) `Skill invoked` card. Setting `enabled` to `false` restores its native rendering. Legacy `transcriptNotices.help` and `frames.subagentMessage` settings remain accepted, but recognized subagent messages now use the activity frame instead of separate cards. Unrecognized messages retain their native renderer.

Each `footer` field (`cwd`, `gitBranch`, `model`, `thinking`, `sent`, `received`, `context`, `codexQuota`, `extensionStatuses`) has `enabled` and `icon`. For example, `"cwd": { "enabled": true, "icon": "📁" }`. Set `"icon": ""` to keep the text without its icon, or `"enabled": false` to hide the field. Older `true`/`false` values still work and use the default icon. The `codexQuota` icon marks the reset countdown; disabling that field also stops quota fetching.

## Main Agent progress dashboard

The **Main Agent** panel displays saved work observed by `pi-herdr-subagents`. The same bounded run graph selects the mode in each view:

| Mode | Summary | Full report and HTML |
| --- | --- | --- |
| Solo | Hidden, including for task-only plans. The native plan widget is untouched. | Formal tasks and their recorded states; no invented runs. |
| Agents | Root delivery counts and two-line rows, including run name, delivery, any reported outcome, associated task state, and saved runtime. | One formal state per task, then flat run cards with parent labels for descendants. |
| Coordinated | Accepted/total tasks, observed agent count, task and unassigned rows, and role icons in saved depth-first order. | Task/coordinator hierarchy and a separate section for unassigned runs. |

In Coordinated mode, group feedback comes from the last nonempty coordinator report in traversal order, not timestamp order. Problem icons identify the specific run reporting trouble; a normal role icon does not certify success. Counts include observed descendants independently of display limits; `+` and the incomplete-evidence notice indicate lower bounds, while `+?` marks an incomplete row scan. A missing run name falls back to assignment text where available.

| Command | Effect (UI only, no model turn) |
| --- | --- |
| `/clear-progress` or `/clear-progress expand` | Open a scrollable summary overlay within the configured limits; no overlay in Solo. |
| `/clear-progress full` | Open the detailed overlay, capped at 100 tasks and 100 run cards. |
| `/clear-progress compact` | Enable the compact panel, capped at ten lines plus a command hint. |
| `/clear-progress off` | Hide the panel and stop its file watchers. |
| `/clear-progress refresh` | Enable the panel and reread available records. |
| `/clear-progress export` | Save the cached full report as standalone HTML using the configured task and run limits. |

`expand` and `full` leave the compact panel and watcher settings unchanged. They wait for a fresh read if a change has been observed or watcher coverage is incomplete. When the panel is off, each request rereads the available records without starting watchers. Scroll with arrows, Page Up/Down, Home/End, or the fullscreen mouse wheel. Escape or Enter closes the overlay. For users upgrading from the old commands: use `/clear-progress full` for what `expand` previously opened. `/clear-pi-progress` and `/clear-pi` are no longer registered; entering either as an old-style TUI command shows a local migration notice rather than sending a prompt. Quota refresh is automatic.

`progress.enabled` defaults to `true`. `progress.maxTasks` (12) and `progress.maxRuns` (20) accept integers 1–100 and apply to summary and export; the full TUI overlay has its separate 100/100 limits. In Agents summaries `maxRuns` caps root rows; in Coordinated summaries it caps unassigned root rows, while `maxTasks` caps task rows. Descendant role strips are clipped to available width. In detail views the run limit is global, counting cards at every depth. Legacy `progress.details` is ignored.

**Icons.** Edit `progress.icons` in [`config.json`](./config.json): `main`, `agents`, `info`, `runtime`, `checked`, `unchecked`, `status.<state>`, and `roles.<role>.{normal,problem}`. The file lists every built-in state and role. Custom role keys are supported (spaces and underscores normalize to hyphens); recognized aliases fall back to their base role, and unknown roles use `other`. Set one-column symbols or `""` to hide them. The TUI uses `footer.model.icon` and `footer.thinking.icon` for the same fields in the footer, summary and full report. Their `enabled` flags only affect the footer; empty icons hide the symbols but keep the values. `transcriptIcons` configures `activity`, `collapsed` and `expanded`; arrows must occupy one column and remain clickable, while the activity marker can be empty.

**Evidence semantics.** Formal `accepted` comes only from the active plan. `Delivery: completed` means a report arrived, not that the work passed. `Outcome` is the agent's stated result. A recognized structured status takes precedence. Otherwise, the report uses an opening standalone outcome or an explicit `Verdict`/`Status` outside fenced code. Herdr reviewer verdicts `APPROVED` and `NEEDS CHANGES` are shown as reported `complete` and `changes required`, not as formal plan states. Neither delivery nor outcome establishes acceptance or process liveness. Nested v1 history stores a flattened excerpt of at most 320 bytes, labelled `Excerpt`, not a structured result. A surviving Markdown verdict can be recognized; otherwise the outcome is `not recorded`. Native results preserve line breaks, with a preview of up to 320 UTF-16 code units and a Full/HTML limit of 4096; `…` marks truncation. Neither view opens the child's transcript. Runtime metadata is saved launch/delivery data, not a guarantee of what ran. At narrow widths the full report wraps runtime below the heading to preserve the run title and uses parent labels where further nesting would make cards unreadable.

**HTML export.** Export writes one unique UTF-8 file under the session's `artifacts/<session-id>/clear-progress/` directory and shows its path. It uses the full renderer at 140 columns with portable checkboxes and `Model:`/`Thinking:` labels instead of Nerd Font glyphs. The file contains no external assets or scripts; text is escaped, and terminal hyperlinks keep visible labels but discard their destinations. Export never rereads history, starts watchers, or launches a browser. If the current session/branch snapshot is unavailable, it asks you to refresh first. Review reports before sharing.

**Scope and integration.** This read-only adapter uses herdr's saved v1 contracts, not a public versioned API. It uses explicit plan bindings, run references and authorized lineage; it does not guess from task wording or scan unrelated session directories. Valid sibling records in a shared history directory are excluded from the current scope without marking its counts incomplete. Unknown or corrupt evidence is not counted as success. Refreshes use native events and debounced, filename-filtered watchers; unchanged history files reuse parsed contents and are revalidated for the current branch. No extra tools, prompts, model requests or session entries are introduced. The summary panel hides herdr's redundant `subagent-plan` widget while visible; `/plan-view` restores the native view when the panel is off. An explicitly opened `/subagents-tree expand` history frame is left alone; use `/subagents-tree off` to close it. Older herdr installs may still show an automatic tree. Existing **Agent activity** tool groups remain in the transcript and are not duplicated in the dashboard.

## Collapsible AI tool calls

The arrow appears next to the AI’s own visible progress text, for example `▸ Checking loader return types`. Consecutive tool calls without a new visible update stay under the same arrow. By default, updates with no tools use the Nerd Font U+F449 marker instead of an arrow. Markers and arrows sit on the first line; continuation lines align with the text (two columns after the marker position, three including the frame padding). When tools arrive, the marker becomes an expandable arrow without moving to the last wrapped line. The first group without a suitable visible title in each **Agent activity** frame uses `▸ Agent research`; subsequent groups without a title still use `▸ AI tools`.

- In Pi's **fullscreen** TUI, click the arrow to expand or collapse just that group. The original Pi cards show the commands or other tool arguments, output and errors. Switch modes in `/settings` or launch with `--tui-mode fullscreen`.
- Use Pi's **Ctrl+O** (`app.tools.expand` by default) to expand or collapse all groups, including in regular mode where the terminal handles the mouse.
- Groups are a presentation of Pi's existing transcript, including resumed sessions. They do not change execution, exports, or model context, store a second log, or capture commands run manually via `!`. Work invisible to Pi's transcript (such as shell subprocesses inside a tool, or calls in a separate agent session) does not get a separate card here. Individual expansion choices aren't saved across transcript rebuilds.

**Extension names.** The collapsed `[Extensions]` startup/reload list shows names only: npm scopes, versions, entry-point suffixes (`:dist`, `:src/...`) and JavaScript/TypeScript file extensions are removed generically, without a package allowlist. Expanded resource details retain their original paths and sources. Names are not deduplicated; different extensions with the same short name remain separate entries. This display-only adapter targets Pi 1.6.0's private resource component layout, leaves unrecognized layouts untouched, and does not change loading, package metadata or model context. Future Pi compatibility is not guaranteed without a public resource-rendering API.

The grouping adapter uses Pi’s private interactive document layout. **Pi 1.6.0** is the supported version, verified in regular and fullscreen modes; other versions are not verified. If the adapter does not recognize the layout, it leaves the native transcript unchanged. Completed transcript fragments cache their rendered lines. Opening a single group leaves unrelated cached fragments intact; the current turn and expanded native tools remain live.

### Expanding skill and help cards

The orange **Skill invoked** card starts with its name and description; expanding shows the saved instructions.

Subagent results and help requests appear inside **Agent activity** as `▸ I have received message from Worker: preview`. Assignments and follow-up messages use `▸ I have sent the message to Worker: preview`. Click a message row in fullscreen to reveal its full multiline content independently of tools and other messages. Unknown message schemas keep their native rendering.

In either TUI mode, Pi's **Ctrl+O** (`app.tools.expand`) expands or collapses all groups and resets individual choices. Expansion only changes the display; it does not run a skill, send a reply, or resume a session.

## Metric meanings

- **Sent** sums `usage.input + usage.cacheRead + usage.cacheWrite`; **received** sums `usage.output`. These are cumulative reported model-token counts, not network bytes, unique prompt tokens, or quota consumption. Cache hits are intentionally included; repeated context is counted on each model request. `totalTokens` is never added, avoiding double counting.
- Only `ctx.sessionManager.getBranch()` is scanned, so abandoned branches do not contribute. Like the installed Pi footer's accounting conventions, separately recorded tool-result usage (including nested model usage), usage entries, compaction usage and branch-summary usage are included in addition to assistant usage. These totals survive compaction for entries remaining on the active branch; they are not limited to the current model/provider or the post-compaction context. Entries without usage contribute nothing; a new empty branch shows zero.
- **Context** is the current `ctx.getContextUsage().percent`, not cumulative sent tokens divided by context size. Pi estimates trailing messages and can return unknown after compaction. Missing/null/nonfinite percentages display `?%`, not zero. Thinking uses the current `ctx.thinkingLevel`.
- **Quota** is separate account-level Codex usage, not session token usage. Each returned window is labeled by server duration (for example `5h`, `7d0h`); missing durations use `primary`/`secondary`. Bars fill in proportion to **remaining** quota, with an explicit percentage. The group is labeled `Codex`, without a `left` suffix. Percentages are rounded.
- Reset countdowns use minutes/hours/days. Unknown resets show `?`; a passed reset shows `due`, never fabricated replenishment. `limited` reflects the server's account-limit flag. Cache expiry, reset expiry and transient failures explicitly mark data `stale`, with sanitized failure reasons when available. Missing data displays loading/error/unsupported states, never unlimited or zero usage.

## Automatic quota refresh

Quota status appears in the footer; there is no quota command.
- With an active `openai-codex` model in **TUI mode**, startup fetches automatically and subsequent fetches follow the five-minute cache. Failures retry no more than once per minute automatically.
- Other providers show `unsupported provider` without polling. Switching between Codex models preserves cache and in-flight requests. Print/JSON/RPC modes do not install a footer, poll or resolve credentials.

## Security and limitations

`UsageClient` uses the **unofficial**, undocumented endpoint `https://chatgpt.com/backend-api/wham/usage`. It may change, return incomplete windows, be unavailable for an account, or reject access. This is not an official OpenAI usage integration, a billing balance, or a guarantee of available requests. Missing/invalid windows are never interpreted as zero usage or unlimited access. Credits, plan names, balances, account identifiers and unrelated response fields are neither displayed nor persisted.

Authentication comes only from Pi's public `ctx.modelRegistry.getProviderAuth("openai-codex")`, allowing Pi to handle OAuth refresh and normal credential storage. The extension does not read/write credential files or perform its own OAuth refresh. It accepts a JWT-shaped access token with the same account claim used by Pi's Codex transport; decoding is not signature verification. Plain API keys and non-ChatGPT auth base-URL overrides are unsupported. Custom auth headers are never forwarded. Only the bearer token and derived account header go to the fixed HTTPS endpoint, with redirects disabled. A project or response cannot configure the endpoint.

Each attempt is bounded to eight seconds, including auth resolution, fetching and body parsing. Fetch receives an abort signal; response bodies are limited to 64 KiB. Pi's auth API takes no cancellation signal: a timed-out operation may continue inside Pi, but cannot start a late usage request. Its pending promise is reused to avoid overlapping extension-initiated auth resolutions. Shutdown/provider changes abort active work and discard the in-memory quota cache. Multiple Pi processes maintain independent caches.

Network/HTTP/schema failures show only fixed sanitized labels. Authentication/access failures clear cached quota; transient failures retain it as stale. No credentials, raw responses, exceptions or quota snapshots are logged, written to files, appended to session history or sent to a model by this extension. Pi itself remains responsible for its normal auth persistence and logging.

## Verification

Requires Node.js with native TypeScript stripping (tested with Node 24.21.0) and an installed Pi:

```sh
cd ~/.pi/agent/extensions/clear-pi
npm ci
npm run typecheck
npm test
```

The test-only resolver uses `PI_PACKAGE_DIR` if supplied, then local Pi from `npm ci`, then Pi from `npm root -g`. The integration test uses the installed Pi 1.6.0 agent loop and TUI with an offline streaming provider and simulated terminal. It covers the native `read` card, fullscreen mouse input, branch navigation, Ctrl+O, expanding saved skill and help cards, and fallback when the document layout is unrecognized. Herdr history and delivery are tested with fixtures matching the producer's contracts and reviewer format, not by running the herdr extension. `npm run bench:transcript`, `npm run bench:progress` and `npm run bench:progress-view` measure synthetic transcript rendering, snapshot reads and report rendering respectively. The explicit package manifest exposes only `index.ts`; helper files and tests are not extension entry points.

Mock-only tests cover quota parsing/security/cache/timeouts, actual footer component creation/rendering, requested Unicode, ANSI/wide glyphs and widths 0–250, context unknown/zero, branch accounting, Git/session branch changes, provider switching, timer repaint, commands, subscription cleanup, shutdown and late completion. No credentials are read and no real endpoint is probed. The installed Pi extension loader also loaded the entry point without errors, invoked the footer factory/render with a mocked context, and verified shutdown restoration/unsubscription. Mock verification does not establish live endpoint availability, account quota accuracy, or the font's visual rendering; those require independent terminal/account review. The test suite uses native TypeScript stripping. `npm run typecheck` separately checks the extension sources in strict mode.

Implementation references: installed Pi `docs/extensions.md`, `docs/tui.md`, `examples/extensions/custom-footer.ts`, `dist/core/extensions/types.d.ts`, and `dist/modes/interactive/components/footer.js`.
