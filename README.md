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

## Relevo suggests: the right model for each task

While you type, a bar above the composer suggests **subscription · model · reasoning level** and explains why, for example: "Hard task (debugging) · Opus 5.5 is among the most capable · Claude personal has 77% of its weekly quota left, resetting Thu 1:00". Accept it with **Usar** (⇧⌘U). In Settings › General you can turn it off or have it applied automatically (with undo).

- **Classification:** an instant, free local heuristic as you type. After a pause, the same utility model used for titles (DeepSeek Flash, Haiku 4.5 or Gemini Flash Low) returns the level (`trivial`, `normal` or `dificil`) and the kind of task. The result is reused while the text doesn't change much.
- **Catalog as data** (`Store/ModelCatalog.swift`): `pattern → power 1–10` rules matched against "provider id name", the ideal power per task level, preferred reasoning levels per task level, and models that are never suggested. Only the newest version of each family counts (Opus 5.5 hides Opus 5 and 4.8). Any field can be overridden in `~/Library/Application Support/Relevo/model-tiers.json` (the **Personalizar…** button).
- **Scoring:** fit for the task (too strong wastes quota; too weak is penalized more) and free quota. Quota only matters when it's scarce, with a bonus for weekly quota that resets within 48 h and would otherwise be lost. Pay-per-use comes last. Each provider can declare which quota windows a model consumes (`usageWindows`): Antigravity separates Gemini from Claude/GPT, and Claude separates "Week · Opus".
- **Mid-thread**, staying on the same agent weighs more, so the context isn't handed off and the cache isn't broken. It only suggests switching when it's worth it.
- **Learns from the trace:** the `outcomes` table in `memory.sqlite` stores the level, provider, model and result of each turn: `ok`, `error`, `limit`, `stopped` or `switched` (set when you change model by hand right after a turn). With 3 or more cases, the success rate raises or lowers the score ("solved 4 of 4 similar tasks"). Limits and stops don't count against the model.

Headless check against your real state (preferably on a copy of the data folder):

```sh
RELEVO_DATA_DIR=/tmp/relevo-copy .build/debug/Relevo --selftest suggest ai - "explain what parse does" "redesign the session lifecycle"
RELEVO_DATA_DIR=/tmp/relevo-copy .build/debug/Relevo --selftest suggest local codex:gpt-6.1-sol "…"   # mid-thread
```

## Work trace (SQLite): where the agent was

The main case is **an account running out of quota in the middle of a task**. At that point the agent can no longer summarize anything, so Relevo doesn't ask it to: it records the trace **live and without spending tokens** in `~/Library/Application Support/Relevo/memory.sqlite` (WAL + FTS5):

- `events`: requests, tools (with their input and a summarized output; for failed ones it keeps the end, where the error usually is), agent replies, permissions, errors, limits and handoffs.
- `plans`: the agent's live plan. It comes from Claude's `TaskCreate`/`TaskUpdate`/`TodoWrite` (Relevo sets `CLAUDE_CODE_ENABLE_TODO_TOOLS=1`, since they're off in headless mode), from Codex's `turn/plan/updated` and from ACP's `plan`.
- `files`: files created or edited in the thread.
- `checkpoints`: the reason for each stop (limit, error, stopped, turn completed, handoff) and the `HEAD` commit the thread started from.
- `outcomes`: per-turn results used by Relevo suggests (no content, just level/provider/model/result).

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

Requirements: macOS 14 or later and Xcode / Swift 5.10 or later.

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

## Data

- `~/Library/Application Support/Relevo/state.json`: subscriptions, projects and settings.
- `~/Library/Application Support/Relevo/threads/*.json`: threads.
- `~/Library/Application Support/Relevo/handoffs/*.md`: handoff transcripts.
- Z.ai: Relevo writes the selected model to `~/.zcode/cli/config.json` (`model` key), because the ZCode CLI doesn't accept `--model`.

## One subscription per provider

Relevo supports a single account per provider: rotating several accounts of the same provider to stack limits goes against their terms (OpenAI forbids "circumventing limits", Anthropic assumes "ordinary, individual usage", and Z.ai requires personal use). What it is designed for is **switching provider** when one runs out.

Optionally, each subscription can use its own configuration folder (`CLAUDE_CONFIG_DIR` or `CODEX_HOME`) to isolate it from the CLI you use outside Relevo. For example, your personal Claude in Relevo and your work Claude in the terminal, without interfering with each other.
