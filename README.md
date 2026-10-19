# CanvasTTY Assistant

> **Requires CanvasTTY 1.8 or later** (plugin API v2: plugin services, launch contributors, decision hooks with the `profile`/`canAsk` fields, plugin tools, session events, card badges and actions). It uses only host APIs CanvasTTY has; nothing in the core is specific to this plugin. CanvasTTY 1.7.0 and earlier do not have these extension points, so installing it there fails the manifest check.

[English](README.md) · [Русский](README.ru.md)

The Assistant («Помощник») for [CanvasTTY](https://github.com/howdeploy/CanvasTTY): a small decision model that
reviews agents' commands before they run, triages the task you give a card, and helps orchestrators (routing, flows,
a task board, loop alerts, session reports). You decide what it enforces: command review starts **Off**, on a fresh
install and on an update alike, and no model is called unless you set one up. If the saved settings cannot be read at
start, review stays Off, nothing is saved over them, and the Assistant reads them again by itself.

## Settings

Settings → Plugins → CanvasTTY Assistant → **Settings** has five controls:

| Control | Values | Default |
|:--|:--|:--|
| Command review | Strict (anything but read-only commands waits for you) · Basic rules (blocks what the hard rules forbid: elevation, piping downloads into a shell, deleting or writing outside the project; the rest runs with a hint on the card) · Off. Settings that are none of these exactly (for example an older version's Learning mode) show as **Custom**, read-only, until you pick a level. | Off |
| Trust the orchestrator's task for its subagents' new files | on/off: the **trust chain** (below) | off |
| Automatic routing | on/off: the `route` tool suggests provider, model and effort | on |
| Loop alerts | on/off: a `loop?` badge when a card repeats the same command in one turn with no file edits seen | on |
| Flows | on/off: the flow tools and the Flow preview card | on |

Decision models are optional and have their own page (**Decision models…** at the bottom).

**Trust chain.** With it on, a subagent may create a new file inside the project without asking you when:
- the task of the orchestrator above it is yours;
- the file is new and its whole content is visible;
- it is not a secret, not a protected path and not a command;
- the review is sure enough the file serves the task: at least 95%, or 75% when the trusted task names the file and it lands in the subagent's folder (or a folder the task names) with every risk low.

The Assistant only knows the orchestrator's task as **yours** from what reaches it:
- the launcher's **Task** field (Advanced → CanvasTTY Assistant). CanvasTTY limits it to 200 characters;
- or the turns of an orchestrator on Model: Auto (Jev).

**Tests under the trust chain.** It also lets such a subagent run its tests when the command is a plain known runner (`node --test <files>`, `pytest <files>`, or `npm`/`pnpm`/`yarn test` whose package.json the review saw or git tracks unchanged, with a plain runner as its test script and no pre/post scripts or package-manager config) and every file it runs or imports is one the review allowed whole in this card (same content now) or is committed and unchanged; the review must be at least 75% sure it serves the task, every risk but a hidden effect at most 10%. Shell syntax, packages, dynamic imports, `go test` and `cargo test` still go to you. The review log says `trust-chain-test`.

For a longer task, put its first line in the Task field (with the file names the subagents will create) and the details in your first message to the orchestrator. Without the Task field, an orchestrator on a model account or its own sign-in gets no trust chain, and its subagents' writes go to you as before.

## For orchestrators

Nothing is added to HOME, the dock, the launcher or CanvasTTY's own settings. Orchestrators get these tools
(`canvastty-assistant__<name>`), the cards get three menu actions, and the plugin has two canvas cards you open from
Settings → Plugins → CanvasTTY Assistant.

- **`route`** (also **`pick_route`**, the name `list_providers().note` points to) `{ task, providers?, accountRoutes?,
  prefer?, orchestrate? }`: where a subagent runs — CLI, sign-in (your subscription on that CLI, a coding plan, a model
  account, Model: Auto), model and effort — plus up to two alternatives, each with `spawn` values for CanvasTTY's
  `spawn_agent`, a why-line and an estimate (USD, or the share of a subscription window). Pass
  `list_providers().providers` and the Accounts plugin's `list_routes` rows. Models are compared by the Auto catalog's
  measured score for the task type (Jev reads the task when it is set up, else word rules), then by price or window
  share; a subscription with headroom above your reserve is free and preferred within the quality window. The spawn
  values name every plugin that sets a model (`canvastty-assistant`, `canvastty-accounts`), so nothing is inherited by
  accident. Declare subscriptions and plans under **Where agents run** on the Decision models page; nothing declared,
  a CLI's own default is the last fallback (never OpenCode's own default).
- **`route_outcome`** `{ decisionId | sessionId, status, exitLines?, ok? }`: how a routed subagent ended. A usage-limit
  exit rests that route until its window resets; failures demote a route that does clearly worse than the other routes
  to the same model.
- **Flows**: `flows_list`, `flow_plan { flow, goal }`, `flow_status { planId? }`. `flow_plan` returns only the plan id
  and the role names; the plan waits for you in the **Flow preview** card (roles, provider/model, tasks; built-in flows
  in your language, flows from the project's `.canvastty/flows/*.json|yaml` marked "From this project" and shown as
  written, without invisible characters). Only after **Start** does `flow_status` give the orchestrator what to pass to
  `spawn_agent`; the roles are added to its task board. Start is held for a moment after a plan shows, a plan that
  replaced the one on screen says so, and an orchestrator can propose at most three plans a minute. The card menu
  action **Plan from flow…** points the preview at that orchestrator, so you can choose a flow yourself.
  **This is a request to the orchestrator, not a lock**: the plugin starts nothing and cannot stop an orchestrator that
  calls `spawn_agent` without a plan. Enforcing it needs a host API (see Needs).
  Project flows are read only from a real `.canvastty/flows` folder inside the project (a linked folder or file is
  refused, files are opened without following links); a refused file is named with a fixed reason, never its content.
  The orchestrator gets project flow text marked as quoted data, not instructions.
- **Task board**: `task_add` (orchestrator), `task_update` and `task_list` (orchestrator and its subagents; a subagent
  changes only its own tasks or claims a free one). The **Task board** card shows them by status; the orchestrator
  card shows `tasks 2/5`, and its menu action **Task board** points the card at it.
- **Loop alerts**: every shell command reaches the plugin before it runs. The same command (spacing, numbers and a
  trailing `| tail -50`-style filter aside) five times in one turn with no file edit seen in between puts `loop?` on the
  card; it clears when the next turn starts (not on a brief status flicker). Edits made through the shell (`sed -i`,
  redirections and heredocs into files, `tee`, `cp`/`mv`, formatters…) count as edits; polling (`sleep`, `watch`,
  `git status`, `gh pr checks`…) is not counted. Outcomes are not visible to plugins, and providers without the decision
  hook are not seen. Advisory only.
- **Report** (card menu, every agent): start time, working time, turns, status and exit code, subagents, commands seen
  and what review declined or sent to you, loop alerts and tasks. Token use and cost are not available to plugins.

A card has one badge per plugin; the most important signal is shown (loop, flow waiting, review, tasks, triage).

**What is stored**: in the plugin's data folder, `harness/plans.json` and `harness/boards.json` hold flow plans (goal,
role titles and tasks) and task boards (titles, details, notes) in plain text: your own and your agents' words, as
written. Plans go after a day, when their orchestrator card closes, or when CanvasTTY no longer lists that card;
boards go with their orchestrator. An approval is never read back from disk: after a restart a plan must be approved
again. Loop alerts keep hashes only; reports keep counts, no command text.

## What it does

- **Command review** (decision hook). Before a local agent's shell command or file write runs, CanvasTTY's base
  protection answers first; then the Assistant: a read-only allow list (`git status`, `ls`, `rg`…), a small model's
  nine yes/no questions about the command, and on a disputed case a larger second model that also reads the scripts
  or diff the command runs; otherwise you. A script the agent wrote in this session is never allowed without you.
  The review checks the action against the card's task: the one typed in the launcher, and on Model: Auto (Jev) each
  new user turn the router sees (memory only, under the card's data class). A subagent's task counts as yours only
  when you typed it word for word; otherwise it is checked against your request to the card above it.
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

## Model: Auto (Jev) (OpenCode)

In the launcher, **Advanced → Use CanvasTTY Assistant → Model: Auto (Jev)** runs an OpenCode card on a model the
Assistant picks for each new turn from your own allow-list. Leave the launcher's **Model** at Default and choose no
model account (an account and Auto on one launch are refused: both configure OpenCode).

- **Where it runs**: while a card uses Auto, the Assistant's service listens on **127.0.0.1 only** (a port it keeps
  between restarts). Each launch gets its own random `sk-ctty-…` key; the service stores only its hash; the key stops
  working when the card closes or restarts, and the port closes when no card uses Auto. Requests from web pages
  (an `Origin` header) or for another host name are refused.
- **OpenCode** gets a config file in the run's own folder: one provider pointing at that port, `model` and
  `small_model` on it, and `enabled_providers` limited to it, so OpenCode Zen and any other provider in your own
  config are not used. A project whose own OpenCode config chooses models or providers is refused instead (OpenCode
  lets the project config win). Containers and remote hosts are refused (they cannot reach this computer's
  127.0.0.1); other CLIs come later.
- **Decision, from data**: for each new user turn, Jev (task triage, while it is Suggest or Auto on the Decision models
  page) reads the latest user text within 2.5 s and returns the **task type** (coding, review, research, writing,
  chat) and the **difficulty** (small, medium, large); "small" needs ≥ 0.5 probability on the two easiest levels
  (chosen on 40 labelled tasks of a live run: no medium or large task became small; 0.7 for research and review,
  and an orchestrator card's turns are never small), otherwise it is medium. Without
  Jev, word rules give both (never "sure"). Among the models you allow that are healthy now (not cooling down,
  trusted with the card's data class, large enough for the request, within the caps), the **cheapest model whose
  catalog score for that task type is within a few points of the best** answers: **Balanced** 8 / 5 / 3 points on
  small / medium / large turns, **Cheap** 15 / 10 / 5, **Best** none; within those points a lower effort is preferred
  too, except on large turns. Jev answers at most 10 turns a minute per card (60 for all cards), word rules beyond. A model with
  no score never beats one with a score; when nothing has a score, your manual tiers decide, else the known model of
  middle price. Tool steps keep the turn's model; titles and summaries use the cheapest model and ask nobody — about
  one decision per turn, not per model call. Each decision is logged with type, difficulty, model, effort, score and
  its source, price, a reason code and the trade-off (the best-scored model, its score and price, the points allowed)
  — no text.
- **Catalog**: models.dev (models, prices, limits), Artificial Analysis and LiveBench (measured scores per exact model
  and effort) and OpenRouter's model list, read from fixed HTTPS addresses (no task text, no key), cached on disk and
  refreshed in the background (weekly; OpenRouter's list daily) while an upstream is on, or with **Refresh now**. A
  score belongs to one exact model and effort and never moves to another variant; a model without its own row stays
  unknown. Old scores still count (marked old); prices older than 7 days are not compared. Measured rows ship with the
  plugin for a computer that never went online. Artificial Analysis's page now carries full rows only for the models
  of its default chart, so a refresh with fewer than half the known rows keeps the earlier ones it lacks.
- **Upstreams** (Decision models page): **OpenRouter** (its own key or the Jev · OpenRouter key) offers its whole list of
  suitable models (tools, text, a fixed price; no `:free` variants) with OpenRouter's context and prices; a model with
  measured efforts is offered at each of them, and Auto sends that effort (`reasoning.effort`) unless the CLI set one.
  **OpenAI-compatible** base URLs take your exact model ids; prices come from models.dev when it lists that address,
  or from you. Each model row shows its context, price and score (read-only), with an exclude toggle and an optional
  manual tier and effort. Your trust per upstream: D0–D2; D3 only for a server on this computer. Keys are write-only,
  bound to the upstream's address. The request is passed on with only `model` changed (plus the effort above); a
  404/408/409/425/429/5xx, a connect error or a timeout **before the first byte** moves to the next model and cools the
  failed one down (429 honours `Retry-After`); so does a 400 that names an unknown model id (OpenRouter's "is not a
  valid model ID", cooled down 15 min); any other bad request (400) is returned; a stream that fails midway ends with an
  error and is never replayed.
- **Caps**: per card and per day in USD, held before each call so parallel calls cannot pass them; counted from the
  cost the upstream reports (OpenRouter does) or your prices. A spent cap answers 402.
- **Several models on hard turns** (Decision models page; consensus **Auto** by default, best of N **off**): a hard
  text turn (design-level, or research/review/writing at the large level; never a tool step, a title, an orchestrator
  card or a conversation that already called tools) may go to 2–3 slightly weaker models of different vendors (other
  upstreams first; an address marked flat-rate on the routing page takes at most 2 at once) whose drafts a strong
  model merges, streamed to the CLI. On Auto only when that pays: the judge's score + 1.5 points per extra vendor (at
  most 3) − the single model's score − cost (Cheap ×3, Balanced ×1, Best ×0 per doubling) − wait (½ per doubling, only
  with known speeds) > 0; **Always** skips that test. **Best of N** compares and keeps one draft. All drafts and the
  judge are reserved against the caps and a cap per turn ($1) first. A draft that calls a tool makes the turn a
  normal one (the single model's answer, unchanged; the others stop); a failed or late draft is dropped; a failed
  judge leaves the best draft. Each decision records the drafts' outcomes (no text); a route failing half of ≥ 10
  fan-outs is not asked again.
- **Speed**: Artificial Analysis's measured output speed and time to first chunk per exact model and effort are kept
  with the catalog (OpenRouter's public list states none). They feed plan time on the routing page and the wait in
  the rule above; an unknown speed is neutral.
- **Subagents**: Auto is one of `route`'s routes for OpenCode subagents (`launchOptions: {"canvastty-assistant": {"model":
  "auto"}}`, no model); a subagent's data class is never below its parent's.
- **Privacy**: prompts go only to the upstream that answers; Jev gets only the latest user text, through the same data
  checks as everything else. The routing log keeps hashes, models, tiers, statuses, tokens and cost — no text. The
  card's badge shows the current model when it changes (any other Assistant signal wins the badge).
- **Known limit**: the agent's own shell can read its key and call the router itself; it then spends at most that
  card's cap through the same allow-list.

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

Not available to plugins yet, so not done: enforcing an approved flow (CanvasTTY would need to tell `launch.prepare`
the parent card and role of a spawn, and let a launch policy refuse spawns outside an approved plan); opening a plugin
card from a card action; tool outcomes, token use and cost; localized card-action titles.

## Build

```sh
npm install        # esbuild, typescript
npm run build      # bundles the service and the pages, stamps the manifest
npm test
CANVASTTY_REPO=/path/to/CanvasTTY npm test   # also: CanvasTTY's validator and an install into its PluginManager
```

The end-to-end test needs a CanvasTTY checkout with its `node_modules` and runs with
`NODE_OPTIONS='--experimental-strip-types --experimental-sqlite'`.
