# CanvasTTY Assistant

> **Requires CanvasTTY 1.8 or later** (plugin API v2: plugin services, launch contributors, decision hooks with the `profile`/`canAsk` fields, plugin tools, session events, card badges and actions). It uses only host APIs CanvasTTY has; nothing in the core is specific to this plugin. CanvasTTY 1.7.0 and earlier do not have these extension points, so installing it there fails the manifest check.

[English](README.md) · [Русский](README.ru.md)

The Assistant («Помощник») for [CanvasTTY](https://github.com/howdeploy/CanvasTTY): a small decision model that
reviews agents' commands before they run, triages the task you give a card, and helps orchestrators (routing, flows,
a task board, loop alerts, session reports). Once you trust its native code it works by itself: command review starts
on Warn (hard rules only; nothing else enforced) and no model is called unless you set one up.

## Settings

Settings → Plugins → CanvasTTY Assistant → **Settings** has four controls:

| Control | Values | Default |
|:--|:--|:--|
| Command review | Strict (anything but read-only commands goes to you) · Warn (hard rules deny; suggestions show on the card) · Off | Warn |
| Automatic routing | on/off: the `route` tool suggests provider, model and effort | on |
| Loop alerts | on/off: a `loop?` badge when an agent repeats a command without changing files | on |
| Flows | on/off: the flow tools and the Flow preview card | on |

Decision models are optional and have their own page (**Decision models…** at the bottom).

## For orchestrators

Nothing is added to HOME, the dock, the launcher or CanvasTTY's own settings. Orchestrators get these tools
(`canvastty-assistant__<name>`), the cards get three menu actions, and the plugin has two canvas cards you open from
Settings → Plugins → CanvasTTY Assistant.

- **`route`** `{ task, providers? }`: provider, model and effort for a subagent. Pass `list_providers().providers` so it
  picks from what is installed and signed in; pass the answer's `spawn` values to CanvasTTY's `spawn_agent`. The
  difficulty comes from a decision model when one is set up, else from word rules. Accounts stay with the accounts
  plugin: when `launchOptionTools` lists its `pick_account`, the answer names it.
- **Flows**: `flows_list`, `flow_plan { flow, goal }`, `flow_status { planId? }`. A plan waits for you in the
  **Flow preview** card (roles, provider/model, tasks; built-in flows in your language, flows from the project's
  `.canvastty/flows/*.json|yaml` marked "From this project" and shown as written). Only after **Start** does
  `flow_status` give the orchestrator what to pass to `spawn_agent`; the roles are added to its task board. The card
  menu action **Plan from flow…** points the preview at that orchestrator, so you can choose a flow yourself.
- **Task board**: `task_add` (orchestrator), `task_update` and `task_list` (orchestrator and its subagents; a subagent
  changes only its own tasks or claims a free one). The **Task board** card shows them by status; the orchestrator
  card shows `tasks 2/5`, and its menu action **Task board** points the card at it.
- **Loop alerts**: every shell command reaches the plugin before it runs. The same command five times in one turn with
  no file write in between puts `loop?` on the card; it clears when the next turn starts. Advisory only.
- **Report** (card menu, every agent): start time, working time, turns, status and exit code, subagents, commands seen
  and what review declined or sent to you, loop alerts and tasks. Token use and cost are not available to plugins.

A card has one badge per plugin; the most important signal is shown (loop, flow waiting, review, tasks, triage).

## What it does

- **Command review** (decision hook). Before a local agent's shell command or file write runs, CanvasTTY's base
  protection answers first; then the Assistant: a read-only allow list (`git status`, `ls`, `rg`…), a small model's
  nine yes/no questions about the command, and on a disputed case a larger second model that also reads the scripts
  or diff the command runs; otherwise you. A script the agent wrote in this session is never allowed without you.
- **Modes** per use case: Off, Learning (answers are only recorded), Suggest (shown as a card badge, nothing
  enforced), Auto (may ask you or decline; allows only outcomes that qualified on your own ✓/✗ labels, and only when
  you let the plugin allow in CanvasTTY). Every error, timeout or missing key ends with you deciding, never in an allow.
- **Launch triage**: type the card's task in the launcher (Advanced → Use CanvasTTY Assistant). The Assistant reads
  it, marks risky tasks for strict review and shows its advice as a badge (difficulty, category, worktree or
  container, strong model).
- **Orchestrator tools**: `canvastty-assistant__recommend` (advice before `spawn_agent`) and
  `canvastty-assistant__review_status`.
- **Agents that cannot ask**: only Claude Code can put a question in front of you from the hook. For every other agent
  an Auto review that would ask you answers a deny with its reason and what to do instead; a review that could not
  finish in a card whose profile still asks you (normal, plan) leaves the call to the CLI's own prompt.
- YOLO and isolation are CanvasTTY's own rules (your acknowledgement per CLI, the isolation layer for non-manual
  agents); the former "YOLO only isolated" option, which counted a worktree as isolated, is gone.
- **Data checks**: Strict, Warn only or Off; what may leave this computer (code facts only, texts up to D1 or D2);
  your trust per remote model. A local Ollama model gets everything; keys are redacted before anything is sent.

## Decision models

- **Jev** through TypeSafe, OpenRouter (zero data retention enforced) or Vercel: needs a key.
- **Laya** and an **Eikos** `serve.py` server on your computer or over https.
- **Ollama**: any local instruct model (for example `qwen3.5:9b`), read through its option-letter logprobs; a larger
  local model (for example `gpt-oss:20b`) as the second reviewer.

Keys are written from the settings page straight into the plugin's secrets and never shown again; only the service
reads them, at call time, bound to the address they were saved for, and CanvasTTY masks them in everything agents read.
**Check** («Проверить») runs a fixed synthetic battery (no data of yours).

## Limits

- Budgets per minute, per day and in USD per day for cloud calls. A cloud call holds an upper estimate of its cost
  against the USD cap while it runs, so parallel calls cannot pass the cap together; the real cost replaces it.
- A failing model server opens a circuit breaker; late answers to calls admitted before it opened change nothing, and
  only the one probe call closes it again.
- A model server on this computer (loopback, confirmed local) gets one request at a time with a queue of 4; the
  second reviewer shares that slot.
- Memory: statistics keep what the log keeps (`logRetentionDays`, at most 100 000 decisions); per-session review state
  is kept for at most 512 sessions, least recently used dropped first.
- Between the service and CanvasTTY a frame is at most 1 MiB, a host call fails after 30 s or past 64 in flight, and
  while CanvasTTY is not reading, waiting events and logs are capped at 8 MiB (answers are never dropped).

## Needs

CanvasTTY with plugin services and the Assistant extension points (`secrets.get` for services, `decide.timeoutMs`,
the `profile` and `canAsk` decide fields). Trust the plugin's native code in Settings → Agents → Extension native code, and turn on
**May allow agent actions** if the Assistant may allow commands on its own.

## Build

```sh
npm install        # esbuild, typescript
npm run build      # bundles the service and the pages, stamps the manifest
npm test
CANVASTTY_REPO=/path/to/CanvasTTY npm test   # also: CanvasTTY's validator and an install into its PluginManager
```

The end-to-end test needs a CanvasTTY checkout with its `node_modules` and runs with
`NODE_OPTIONS='--experimental-strip-types --experimental-sqlite'`.
