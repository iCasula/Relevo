# Relevo

Native macOS app (SwiftUI) for working with **all your AI subscriptions at once**: see each one's 5-hour and weekly limits, work in projects and threads, and switch provider or model whenever you want **without losing context**. When one agent hits its limit, another one picks up where it left off.

The interface follows the Codex and Claude Code apps: a sidebar with projects, threads and limits; the chat in the middle; and a composer with subscription, model and permission pickers. The app UI is in Spanish.

## Providers (OAuth sign-in, no API keys)

Relevo doesn't store tokens or call model APIs on its own: it drives each provider's **official CLI**, which uses your subscription.

| Provider | Agent it runs | Protocol | Limits | Sign-in |
|---|---|---|---|---|
| Claude (Pro/Max/Team) | Claude Code `claude` | `-p` stream-json + `can_use_tool` control | `get_usage` (5 h, week, per model) | `claude auth login` |
| ChatGPT (Plus/Pro) | Codex `codex app-server` | JSON-RPC v2 | `account/rateLimits/read` | ChatGPT in the browser |
| Google (Gemini) | Antigravity CLI `agy` | `-p` stream-json + `--conversation` | `agy -p=/usage` (weekly) | `agy` |
| Kimi Code | Kimi Code CLI `kimi` | ACP (`kimi acp`) | the CLI's local server (`kimi web` → `/oauth/usage`: 5 h, 7 days, month) | `kimi login` (device code) |
| Z.ai GLM Coding Plan | ZCode CLI (`ZCode.app`) | `-p` stream-json + `--resume` | `monitor/usage/quota/limit` | `zcode login zai` |
| DeepSeek (API) | Claude Code against the Anthropic-compatible API | stream-json | balance (`/user/balance`) | API key (pay-per-use; no subscription or OAuth) |

> Google no longer supports Gemini CLI with personal accounts ("migrate to Antigravity"), and in 2026 it suspended accounts that reused its OAuth tokens outside its own clients. That's why Relevo uses **only** the official Antigravity CLI and never reads or refreshes Google tokens.

**Models.** Each subscription's model list comes from its provider: Claude Code's `list_models`, Codex's `model/list`, `agy models`, the API's `/models` for DeepSeek, and the ZCode app's bundled list for Z.ai. It's fetched again every time Relevo starts and with every quota check, and new models are pointed out ("Nuevo" in Settings, and a note when they appear). In Settings › Suscripciones › a subscription › **Modelos** you can untick the ones you don't use: they're left out of the thread's model menu (Mac and iPhone), handoffs, comparisons and suggestions, while threads already on one keep it.

When a provider says you're signed in but your plan doesn't cover the service (for example, a lapsed Kimi Code membership), Relevo shows it as **"plan without access"**: it's not a login problem, and that account is left out of handoffs and suggestions until it reports quota again.

## How context handoff works

- Each thread belongs to a **project** (a folder) and is split into **segments**: stretches handled by one subscription and model.
- **Same provider, different model**: the switch happens inside the native session (`set_model` in Claude, per-turn `model` in Codex, `--model` in Antigravity), so the context is kept intact.
- **Different provider**: Relevo builds a handoff package (transcript with messages, tools used, trimmed outputs and errors) and sends it as the first message to the new agent. The full transcript is also saved in `~/Library/Application Support/Relevo/handoffs/`.
- **When a limit is reached** (or the model is overloaded), a banner lists the other subscriptions, sorted by free quota. One click resends the last request with all the context. Settings has an **automatic handoff** option.
- **Shared memory** (optional, per project): `AGENTS.md`, plus `CLAUDE.md` and `GEMINI.md` pointing to it (`@AGENTS.md`), so every agent reads the same conventions.

## Provider architecture

Adding or removing a provider doesn't touch the rest of the app:

- **`Sources/Relevo/Providers/`**: one file per provider implementing `Provider`. It holds its metadata (name, icon, color, sign-in type, isolation folder), how to find the executable, which protocol adapter it uses (`makeSession`), how to read limits (`probe`), how to sign in (`login`) and, optionally, its cheap model for utility tasks (`quickCompletion`) and which quota windows each model consumes (`usageWindows`).
- **`Sources/Relevo/Agents/`**: reusable protocol adapters (Claude Code stream-json, Codex `app-server`, generic ACP, Antigravity and ZCode). A new agent that speaks ACP only needs an `ACPConfig`.
- **`ProviderRegistry`** (in `Provider.swift`) is the single list of providers. `ProviderKind` is just a persisted identifier (`"claude"`, `"kimi"`…), so removing a provider doesn't break saved threads (they show as "unavailable").
- **Anthropic-compatible API providers without code**: DeepSeek is an entry in `AnthropicAPIConfig.builtIn`. You can add others in `~/Library/Application Support/Relevo/providers.json`:

```json
[{ "id": "minimax", "displayName": "MiniMax (API)", "shortName": "MiniMax", "symbol": "m.circle.fill", "tint": "#E5484D",
   "baseURL": "https://api.minimax.io/anthropic", "keyURL": "https://platform.minimax.io",
   "models": [{ "id": "MiniMax-M3", "name": "MiniMax M3" }], "mainModel": "MiniMax-M3", "fastModel": "MiniMax-M3" }]
```

## Automatic titles

When you send a message, a cheap model with no reasoning sets the thread's **topic** as its title in the list. By default it picks, in this order, a pay-per-use API (DeepSeek Flash), Claude Haiku 4.5 without reasoning, or Gemini Flash Low. If the first message gives no context ("hola"), it waits for the next one (up to 3 attempts). You can change the model or turn it off in Settings › General. Right-click a thread to rename it or regenerate its title with AI.

## Working with a running agent

- **Queue**: messages sent while the agent works wait and go out one per finished turn. After an error, a limit or a stop the queue pauses instead of firing at the wrong moment; a handoff resumes it.
- **Send now** (⚡, ⌘↩ on the Mac, long-press on the iPhone): interrupts the agent and sends the message right away in the same conversation, to redirect it. The rest of the queue continues afterwards.
- **Questions**: Claude Code's `AskUserQuestion` shows up as a card with the options (single or multiple choice) and a free answer; answers go back as `updatedInput.answers`.
- **Stops** say where they came from in the thread and the trace ("desde el iPhone", "desde el Mac", "con ⌘.", "para relevar a otro agente", "para enviar tu mensaje ya").
- **Images and paths** in replies: thumbnails under the message; paths in links, code spans or plain text open in Quick Look (folders in Finder). The iPhone fetches images from the Mac and can open other paths there — only files the thread mentions.
- **Robustness**: if an agent's CLI exits between turns it is reopened resuming the same conversation; after 2 quiet minutes the status line says so (or which long command is running).

## Relevo suggests: the right model for each task

While you type, a bar above the composer suggests **subscription · model · reasoning level** and explains why, for example: "Hard task (debugging) · Opus 5.5 is among the most capable · Claude personal has 77% of its weekly quota left, resetting Thu 1:00". Accept it with **Usar** (⇧⌘U). In Settings › General you can turn it off or have it applied automatically (with undo).

- **Classification:** an instant, free local heuristic as you type. After a pause, the same utility model used for titles (DeepSeek Flash, Haiku 4.5 or Gemini Flash Low) returns the level (`trivial`, `normal` or `dificil`) and the kind of task. The result is reused while the text doesn't change much.
- **Catalog as data** (`Store/ModelCatalog.swift`): `pattern → power 1–10` rules matched against "provider id name", the ideal power per task level, preferred reasoning levels per task level, and models that are never suggested. Only the newest version of each family counts (Opus 5.5 hides Opus 5 and 4.8). Any field can be overridden in `~/Library/Application Support/Relevo/model-tiers.json` (the **Personalizar…** button).
- **Scoring:** fit for the task (too strong wastes quota; too weak is penalized more) and free quota. Quota only matters when it's scarce, with a bonus for weekly quota that resets within 48 h and would otherwise be lost. Pay-per-use comes last. Each provider can declare which quota windows a model consumes (`usageWindows`): Antigravity separates Gemini from Claude/GPT, and Claude separates "Week · Opus".
- **Mid-thread**, staying on the same agent weighs more, so the context isn't handed off and the cache isn't broken. The penalty grows with the size of the context, and when it still suggests a switch it says how much context the new model would process again ("switching now re-processes up to 180k tokens of context (≈ $0.72)").
- **Learns from the trace:** the `outcomes` table in `memory.sqlite` stores the level, provider, model and result of each turn: `ok`, `error`, `limit`, `stopped` or `switched` (set when you change model by hand right after a turn). With 3 or more cases, the success rate raises or lowers the score ("solved 4 of 4 similar tasks"). Limits and stops don't count against the model.

Headless check against your real state (preferably on a copy of the data folder):

```sh
RELEVO_DATA_DIR=/tmp/relevo-copy .build/debug/Relevo --selftest suggest ai - "explain what parse does" "redesign the session lifecycle"
RELEVO_DATA_DIR=/tmp/relevo-copy .build/debug/Relevo --selftest suggest local codex:gpt-6.1-sol "…"   # mid-thread
```

## Token usage and cost

Relevo records what every turn consumes, per model, from what each CLI reports:

| Agent | Source | What it gives |
|---|---|---|
| Claude Code | `result` (`model_usage_since_last_result`, else the change in `modelUsage`) | input, cache read/write, output, thinking and its list-price `costUSD`, per model (subagents included) |
| Codex | `thread/tokenUsage/updated` (cumulative: the turn's share is the change since it started) | input (cached included), output (reasoning included), context window |
| Antigravity | `result.usage` | input, cache read, output, thinking |
| ZCode (Z.ai) | `turn.completed.usage` (or `tokenCount`) | input, cache, output, reasoning |
| ACP (Kimi) | `usage_update`, prompt `usage` when present | context size only (Kimi sends no per-turn tokens) |

Counts are normalized (`Usage/TokenUsage.swift`): `input` is the prompt read without cache, `cacheRead`/`cacheWrite` the cached parts, `output` includes reasoning.

- **Per message:** under each reply, a line with tokens, the share read from cache and the cost (click for the breakdown). Toggle it in Agentes › Mostrar consumo de cada mensaje (and in the iPhone's Settings).
- **Cost:** Claude uses the CLI's own list-price figure; the rest is estimated with a price table kept as data (`Usage/ModelPricing.swift`, rules `pattern → $/M input, output, cache read, cache write`, first match wins). Add or correct rules in `~/Library/Application Support/Relevo/model-prices.json` (**Editar precios…**). For subscriptions it's an API equivalent to compare models, not what you pay; for pay-per-use APIs it estimates real spend.
- **What switching costs:** a turn that starts cold is labelled with why: a model change, a relay to another agent, a reasoning change, a reopened agent, or a pause longer than the cache's lifetime (the last three only when the tokens show it). Its overhead is the tokens processed without cache beyond what a normal turn of that model processes (median of recent turns), capped at the previous context, priced at the cold rate minus the cache-read rate. It shows on the reply, on the switch notice ("re-procesó 38k tokens sin caché (≈ $0.15)") and in the stats.
- **Consumo window** (⌥⌘U, or the chart button in the sidebar): totals, conclusions, per day by provider, a weekday × hour heatmap, per model (turns, tokens, cache, cost, cost per turn, success rate), what the switches cost, and **tasks a cheaper model could have done**. The thread toolbar's **Consumo** button shows the same for one thread and its context fill.
- **Cheaper models:** finished turns of simple tasks (by the same classifier as Relevo suggests, few tool calls, a short answer) done with a model well above what they needed are matched with the cheapest sufficient model of the same subscription. The alternative cost includes switching: the context loaded cold on the cheaper model, and warming the original one again when the thread went on with it. In long threads that usually eats the saving, and the stats say so instead of suggesting it. **Revisar con IA** asks the utility model which of them really could have used the cheaper one.
- **History:** on first launch Relevo imports the turns made before it recorded tokens from the transcripts Claude Code keeps for each Relevo session (accounts with their own config folder only; read-only).

Charts use a fixed colour per provider from a validated palette (colour-blind safe, separate light and dark steps) and a one-hue scale for the heatmap.

```sh
RELEVO_TEST_CONFIG_DIR=~/.relevo/accounts/claude-personal .build/debug/Relevo --selftest tokens /tmp/x   # Haiku ×2, then Sonnet
RELEVO_DATA_DIR=/tmp/relevo-copy .build/debug/Relevo --selftest usagereport                            # import + report on a copy
RELEVO_DATA_DIR=/tmp/relevo-copy .build/debug/Relevo --selftest usageui /tmp/usage                     # window PNGs, light and dark
```

## When the quota runs out

Each thread can say what to do when its agent runs out of quota (or the service isn't available), from the model menu on the Mac or the iPhone; threads that don't say use the default in Settings › General:

- **Avisarme y decidir yo:** the limit banner offers the other subscriptions.
- **Pasar a la suscripción con más cuota.**
- **Pasar a las que elija, en orden:** one subscription · model, or a list ("Varias, en orden…"); the ones that are also out are skipped.
- **Esperar a que se reinicie y seguir:** at the reset time (or as soon as the quota is back, when the provider doesn't say when), the same agent is asked to carry on where it left off. Its session keeps the whole conversation, half-done work included, and the queue goes on after it. The wait survives restarting Relevo; if the Mac was asleep, it carries on when it wakes.

Before relaying, the banner says where the thread is going, with 10 seconds to stop it ("No relevar") or do it now; while waiting it says when it will carry on, with "Retomar ahora" and "No esperar". A list with nothing left, or no other subscription with quota, falls back to waiting.

## Background tasks

When a Claude agent leaves something running after its turn (tests, a build, a server, with Claude Code's background commands), the thread says it's **waiting**, not working: "Esperando a una tarea en segundo plano", with what and for how long, on the Mac (transcript and sidebar) and the iPhone. When the task ends the agent picks up on its own; Relevo shows that turn as working, notes why it started, and records its usage and changes like any other. Closing the agent's session (relaying it to another subscription, for instance) ends its background tasks too, and the thread says so.

## Worktrees, parallel agents and reviewing changes

- **A worktree per thread** (⌥⌘N, or the project's context menu): the thread gets its own folder under `~/.relevo/worktrees/<project>/` and its own branch `relevo/t-xxxxxx`, from the project's current commit (uncommitted changes in the project stay there). Several agents can then work on the same repository without stepping on each other. The **Git** toolbar menu merges the branch back into the one it came from (aborting on conflicts), opens the folder, or removes the worktree.
- **The same task on several agents** (**Varios agentes** in the toolbar): pick 2–5 subscription · model pairs (by default up to three subscriptions the Advisor would use for the task, each with its strongest model of its own family) and Relevo creates one thread per agent, each in a worktree from the same commit; if launched from a thread, its conversation is handed to all of them. The sheet shows what starting each one costs (the context it has to read cold). **Comparación** then shows each agent's status, files changed, tokens and cost; **Quedarme con este** commits that agent's changes on its branch and merges it where the comparison started, optionally removing the other worktrees.
- **What each turn changed:** before and after every turn Relevo snapshots the working folder into a commit kept under `refs/relevo/<thread>/` (built with a scratch index, so the agent's index, branch and stash are never touched; ignored files are left out). A line under the reply shows "3 ficheros · +40 −12"; it opens the diff, where you can click any line to leave a comment and send all of them to the agent in one message, or **restore** the files to before that turn (what's there is saved first, so it can be undone, and the agent is told with your next message). **Git › Cambios del hilo** shows the whole thread.
- **Commit, push and PR** (**Git › Commit…**): changed files, a message the utility model writes in English (no co-author lines or mentions of AI; they're stripped anyway), then commit, commit and push, or commit, push and open a PR with `gh` (title and body from the message, plus the checks the agent ran).
- **Watching a PR:** every two minutes Relevo looks at it with `gh pr view` and wakes the thread's agent when checks fail (again, after a push that doesn't fix them), someone comments or reviews, or the branch has conflicts; it tells you when everything is green and stops when the PR is merged or closed.

## Quick actions

Per-project commands (builds, tests, code generators) in the thread toolbar's **Acciones** menu and the **Acciones** menu bar (⌃1…⌃9), run with your login shell in the thread's folder (its worktree, if it has one). Their output is kept per thread and can be sent to the agent in one click, which is handy for build errors. An action can also run automatically when a worktree is created (`xcodegen generate`, `npm install`…).

## Window capture

Off by default (Settings › Integraciones). With ⌃⌥⌘C from any app, Relevo captures the window in front of you with ScreenCaptureKit and adds it to the message you're writing. With Accessibility allowed, it also writes the window's text and controls with their positions, so the agent knows what each part of the screenshot is. Captures live in `~/Library/Application Support/Relevo/captures/`; the message carries their paths, which Claude Code, Codex and the others can open.

## MCP server for outside agents

Off by default (Settings › Integraciones). Relevo serves MCP over Streamable HTTP on `http://127.0.0.1:47821/mcp`, only on this Mac and only with its bearer token (stored in the Keychain; **Nuevo token** revokes the old one). Requests from web pages of other origins are refused.

- **Read-only (default):** `list_projects`, `list_threads`, `read_thread`, `get_usage`, `list_accounts`.
- **Full access:** also `create_thread` (optionally in a worktree), `send_message` (queued if the agent is busy, or `now` to interrupt), `stop_thread` and `relay_thread`.

Settings copies the command for Claude Code (`claude mcp add --transport http relevo … --header "Authorization: Bearer …"`) and the `config.toml` snippet for Codex.

```sh
.build/debug/Relevo --selftest workspace /tmp/ws         # worktree, snapshots, diff, restore, commit, merge (RELEVO_WORKTREES_DIR to keep it out of ~/.relevo)
RELEVO_MCP_TOKEN=test .build/debug/Relevo --selftest mcp # initialize, tools, a call, read-only refusal, wrong token
.build/debug/Relevo --selftest turnchanges /tmp/tc       # a real agent's turn: changes recorded, restored, agent told, undone
.build/debug/Relevo --selftest prwatch                   # the PR watcher's decisions over a sequence of PR states
.build/debug/Relevo --selftest background /tmp/bg        # a Claude agent waiting on a background command, then resuming on its own
.build/debug/Relevo --selftest limitplan /tmp/lp         # simulated limits: list in order, most quota, nothing left, wait and carry on
.build/debug/Relevo --selftest models                    # each subscription's saved model list against what its provider gives now
.build/debug/Relevo --selftest followscroll              # the transcript follows the last line and lets go when you scroll up (RELEVO_BOTTOM_INSET=150 for a composer below)
.build/debug/Relevo --selftest commitmsg /tmp/cm         # commit message and PR body from the utility model
.build/debug/Relevo --selftest workspaceui /tmp/ui /tmp/ui/ws   # diff, commit, comparison, actions and settings rendered to PNGs
RELEVO_MCP_TOKEN=test .build/debug/Relevo --selftest mcpserve 120 [full]   # keep the MCP server up for a real client
```

## Work trace (SQLite): where the agent was

The main case is **an account running out of quota in the middle of a task**. At that point the agent can no longer summarize anything, so Relevo doesn't ask it to: it records the trace **live and without spending tokens** in `~/Library/Application Support/Relevo/memory.sqlite` (WAL + FTS5):

- `events`: requests, tools (with their input and a summarized output; for failed ones it keeps the end, where the error usually is), agent replies, permissions, errors, limits and handoffs.
- `plans`: the agent's live plan. It comes from Claude's `TaskCreate`/`TaskUpdate`/`TodoWrite` (Relevo sets `CLAUDE_CODE_ENABLE_TODO_TOOLS=1`, since they're off in headless mode), from Codex's `turn/plan/updated` and from ACP's `plan`.
- `files`: files created or edited in the thread.
- `checkpoints`: the reason for each stop (limit, error, stopped, turn completed, handoff) and the `HEAD` commit the thread started from.
- `outcomes`: per-turn results used by Relevo suggests (no content, just level/provider/model/result).
- `token_usage`: tokens, cost and switch overhead per turn and model (kept when a thread is deleted, without its text); `usage_imports` marks imported Claude sessions.

On each handoff, the new agent first receives a **work state**:

- the request in progress;
- the plan, with the step that was **IN PROGRESS**;
- where it stopped: the reason, actions left half-done, the latest actions and the agent's last message;
- the files touched;
- the git state at that moment: branch, commits made during the thread and uncommitted changes;
- older history related to the request, found with FTS5 search.

The transcript comes after that. You can see the same state in the app with the **Traza** button in the toolbar, and the exact package sent on each handoff with **Ver traspaso**.

## Reasoning level

The 🧠 picker in the composer only appears when the model supports it:

- **Claude**: `--effort` (low, medium, high, xhigh, max). Changing it restarts the CLI, resuming the same session.
- **Codex**: per-turn `effort`, with the levels each model declares.
- **Antigravity**: `--effort`.
- **Z.ai**: each GLM model's `reasoningLevel`.

## Build and install

Requirements: macOS 15 or later and Xcode / Swift 5.10 or later.

```sh
./scripts/build-app.sh          # release build, generates the icon and installs ~/Applications/Relevo.app
```

During development:

```sh
swift build
.build/debug/Relevo --selftest usage [kind]                            # limits and models of each subscription (or just one)
.build/debug/Relevo --selftest agent claude haiku /path/project ask "…" # one turn against the real CLI
.build/debug/Relevo --selftest relay claude haiku codex gpt-6-luna /path "fact" "question"  # tests the handoff
.build/debug/Relevo --selftest handoff claude haiku gemini gemini-3.8-flash-low /path/repo  # stops mid-plan and hands off
```

Use `RELEVO_DATA_DIR=/tmp/x` to keep your real data untouched, and `RELEVO_SNAPSHOT=/tmp/snap` to make the app save screenshots of its own windows (debugging). With `RELEVO_SNAPSHOT` set, the app also accepts actions through the `app.relevo.snapshot` distributed notification (`new`, `select:<title>`, `draft:<text>`, `accept`, `toggle:<n>`…) and captures itself after each one.

## Relevo Companion (iPhone)

`Companion/` is a native iOS app (SwiftUI, iOS 26, MVVM) to follow and drive Relevo from your iPhone: threads by project with live transcripts, permission requests with big Allow/Deny buttons, the composer with subscription · model · reasoning · permission pickers, "Relevo suggests", one-tap handoffs when a limit is hit, and every subscription's limits.

**How it connects.** Nothing goes through a server:

- The Mac advertises a Bonjour service (`_relevo._tcp`, default port 47820) only when **Settings › iPhone › Allow controlling Relevo from the iPhone** is on (off by default: from the phone you can run agents with full access).
- Pairing: the Mac generates a 256-bit secret (Keychain) and shows it as a QR code / `relevocompanion://pair?...` link. Scan it with the iPhone Camera (or inside the app) and the app stores it in the iPhone Keychain. **Desvincular iPhones…** on the Mac regenerates the secret and unpairs every phone.
- Transport: TLS 1.2 with a pre-shared key derived from that secret (HMAC-SHA256), so only a paired device can complete the handshake and all traffic is encrypted, with WebSocket framing for JSON messages (Network.framework on both ends).
- Outside your Wi-Fi, use a VPN such as Tailscale and set the Mac's address in Settings › iPhone (Mac) or Settings › Away from home (iPhone).

**Code layout.**

- `Shared/RelevoProtocol/`: Swift package used by both apps. `RelevoMarkdown` is the Markdown renderer both clients share (headings, nested/numbered/task lists, quotes, fenced code with copy, GFM tables with alignment), so replies look the same on Mac and iPhone. `RelevoProtocol` holds the transfer models (`RemoteAccount`, `RemoteThread`, `RemoteItem`…), messages (`ClientMessage` / `ServerMessage`), the pairing link and the transport (`CompanionTransport`, `MessageChannel`).
- `Sources/Relevo/Companion/` (Mac): `CompanionServer` (listener + one `CompanionPeer` per phone), `CompanionMapper` (Mac models → transfer objects) and `CompanionCredentials`. Each peer observes the app state with `withObservationTracking` and sends the snapshot when it changes, plus the transcript of the thread the phone is viewing as **patches** (only new or changed items).
- `Companion/RelevoCompanion/` (iPhone): `Services/CompanionClient` (connection, reconnection with backoff, state), `ViewModels/` (one `@Observable` view model per screen) and `Views/` (SwiftUI, Liquid Glass, SF Symbols, Dynamic Type).

**Tools.** The toolbar button (⌥⌘T on the Mac) shows or hides the commands and tools the agent runs: hidden, each run of them folds into one row ("4 acciones · Read, Edit, Bash", with failures marked) that expands on tap. Hidden by default on the iPhone, shown on the Mac.

**Live Activity.** The Lock Screen and Dynamic Island show the thread that matters most (needs you › hit a limit › working › just finished), with **Permitir / Denegar** buttons that answer a permission request without opening the app (a `LiveActivityIntent` that sends the answer to the Mac over a one-off connection). Tapping it opens the thread (`relevocompanion://thread/<id>`).

- The Mac computes the state (`CompanionMapper.activity`) and sends it over the connection while the app is open.
- With the app closed, iOS suspends it, so the Mac sends ActivityKit **push notifications itself** (`LiveActivityPusher`): provider token JWT (ES256, CryptoKit) signed with your own APNs key, HTTP/2 to APNs. It can also **start** the activity remotely (push-to-start) when an agent starts working or needs you. Minor updates are throttled; "needs you", limits and finished turns go out at once with an alert.
- Setup: create an APNs key at developer.apple.com › Keys (Apple Push Notifications service), then in Relevo for Mac › Settings › iPhone › Live Activities enter the Team ID and Key ID and choose the `.p8` file (stored in the Keychain). The iPhone registers its push tokens and bundle id automatically.

**Build.** The Xcode project is generated with [XcodeGen](https://github.com/yonaskolb/XcodeGen) (`brew install xcodegen`). Put your team (and, if you want, another bundle id) in `Companion/Config/Local.xcconfig`, which is not committed:

```sh
printf 'DEVELOPMENT_TEAM = ABCDE12345\n' > Companion/Config/Local.xcconfig
cd Companion && xcodegen generate && open RelevoCompanion.xcodeproj   # run on your iPhone
```

**Mac signing.** `scripts/build-app.sh` signs with the identity in `RELEVO_SIGN_IDENTITY` or the untracked `.signing-identity` file (e.g. the SHA-1 of your "Apple Development" certificate from `security find-identity -v -p codesigning`). With a stable identity the Keychain recognises every rebuild as the same app, so "Always Allow" is asked only once; ad-hoc signing makes it ask again after each build.

Headless checks of the Mac side: `--selftest companion` (pairs, connects over Bonjour + TLS-PSK, checks a wrong key is rejected and that a command comes back as a patch) and `--selftest serve [port] [seconds]` (only the server with in-memory credentials, prints a pairing link for the simulator). Debug builds of the iPhone app accept `-pairURL <link>`, `-tab limits|settings` and `-openThread <uuid>` launch arguments for simulator testing.

## Data

- `~/Library/Application Support/Relevo/state.json`: subscriptions, projects and settings.
- `~/Library/Application Support/Relevo/threads/*.json`: threads.
- `~/Library/Application Support/Relevo/handoffs/*.md`: handoff transcripts.
- `~/Library/Application Support/Relevo/model-prices.json`: optional price corrections for the usage stats.
- `~/Library/Application Support/Relevo/captures/`: window captures.
- `~/.relevo/worktrees/`: threads' worktrees.
- Z.ai: Relevo writes the selected model to `~/.zcode/cli/config.json` (`model` key), because the ZCode CLI doesn't accept `--model`.

## One subscription per provider

Relevo supports a single account per provider: rotating several accounts of the same provider to stack limits goes against their terms (OpenAI forbids "circumventing limits", Anthropic assumes "ordinary, individual usage", and Z.ai requires personal use). What it is designed for is **switching provider** when one runs out.

Optionally, each subscription can use its own configuration folder (`CLAUDE_CONFIG_DIR` or `CODEX_HOME`) to isolate it from the CLI you use outside Relevo. For example, your personal Claude in Relevo and your work Claude in the terminal, without interfering with each other.
