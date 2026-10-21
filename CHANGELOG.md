# Changelog

## Next

- **Auto (Jev) on your plan accounts from Accounts, without their keys** (CanvasTTY with brokered requests; feature-detected, an older CanvasTTY lists none and nothing changes): a new upstream kind, *Account in another extension*, added from the Decision models page's *Accounts from other extensions* once you allow Assistant on the account in CanvasTTY. Its turns go through CanvasTTY (`accounts.request`), which adds the key; the router streams them back, fails over and cools down exactly as for a direct upstream (a used-up plan or the local rate limit is a 429, a missing grant a 403), and a flat-rate plan costs nothing per token in the caps. OpenRouter is never one. New permission: `accounts:broker`. This is what lets a person-started OpenCode card on Auto run when the only model keys live in Accounts.
- **Reads what it routes on itself** (each feature-detected, older CanvasTTY keeps the old path): Accounts' accounts, pools and quotas through a shared read once you approve it in Settings → Agents → Extension native code (orchestrators no longer pass `list_routes` rows; the settings page says when approval is missing); Accounts pools (`pool:<agent>`) are subscription routes with their own quota, for subagents and for “Start with Auto (Jev)”; installed and signed-in CLIs from CanvasTTY's `providers.list` (new permission `providers:read`); measured tokens of the Assistant's own cards (`usage:read`) instead of ~2 % per launch between limit reads, and in the agent tree (paid routes at the catalog price, plans as a share, OpenCode's own estimate labelled as one); badges and card-action toasts follow a language switch; `limit.exhausted` rests that CLI's own sign-in until the reset; with servers on, your declared servers that CanvasTTY offers subagents (by name) come with each route answer.
- **Auto (Jev) autopilot, phase 2** (feature-detected; older CanvasTTY keeps phase 1): the Assistant declares a scoped launch policy (`own-trees`: only subagents in its own trees, never a launch the person starts; a core without the scoped form gets no policy at all); where CanvasTTY shows a launch's requested model, effort, plugins and shared peer fields, a subagent of an Auto tree must match its single-use `pick_route` decision (CLI, model, effort, the Accounts account once Accounts shares it); children on another CLI that skip the Assistant (also under a Claude orchestrator without a declared plan), grandchildren on another CLI and subagents of a leaf are refused with what to do. **Start with Auto (Jev)** on the settings page: Jev chooses the CLI, sign-in, model and effort (and a server when servers are on) and the Assistant starts the orchestrator with `sessions.create {role: "orchestrator"}`, bound to that decision, with the plan as its first prompt; it needs the person's "May start orchestrators", and without it the page says how to start Auto instead.
- **Subscription quotas without the page**: on a CanvasTTY that lets services read limits, the Assistant subscribes and reads them itself on its own schedule (just after predicted resets, often while routes rest) and takes the core's push; older cores keep the page forwarding. Windows survive restarts with their age. Early resets (a clear drop of the used share before the announced reset, with a new or the old reset time shown) end rests at once and are logged with their details; limit messages name the rest's end; own launches count between reads; Accounts' per-account quota is used.
- **Agent tree** (new canvas card and card action): who started whom, with each card's model, status (Running / Waiting / Needs approval / Done / Failed), task, route cost (dollars for paid routes; plans as a share of the window or launches, never dollars), elapsed time and child count (of the autopilot plan's); branches fold; a click shows the card on the canvas through CanvasTTY's `sessions.focus` (new permission `sessions:read`). Uses the launch `model` from session summaries when CanvasTTY sends it.
- **Auto (Jev) autopilot, phase 1**: Auto on Claude Code's and Codex's own sign-in (model and effort chosen, vendor endpoint pinned); every subagent of an Auto card bound to a single-use `pick_route` decision (no launch policy); `autopilot_plan` with the new `task.shape` question set; OpenCode plan routes pinned to one provider; leaf tasks on declared servers (off by default; new permissions `sessions:launch`, `sessions:control`).
- **OpenRouter serves only Jev** (owner's rule): no Auto upstream, consensus draft or judge, or agent-level route on openrouter.ai; enforced in settings, the inventory, route candidates and again by the router on every call (host rule plus OpenRouter's resolved addresses for literal IPs; no redirects). The Jev key no longer creates an Auto upstream; the short view calls it "Jev key (OpenRouter)".
- **Live run 15 / re-audit**: stalled streams end (keep-alive is not progress; a turn deadline) and are counted at an estimate; compound `;`/`&&` commands and OpenCode's edit (with its old text) under the trust chain; today's calls and the last decisions survive a restart; triage badges follow a language switch; plainer Advanced.
- **Simpler pages** (UI audit 2026-10-19): the Decision models page opens on a short view (Auto on/off, one OpenRouter
  key, Cheaper/Balanced/Better, daily limit, today's spend and last turns) with everything else under Advanced; the
  key sets up Jev and Auto's OpenRouter upstream; no horizontal overflow; data classes by name; one line per control
  with the numbers in README "How Auto decides"; the service follows CanvasTTY's language when a page reports it;
  launcher fields "Model: Agent's own / Auto (Jev)", "Task (for review)", "Data class".
- **Trust chain: inspection and own files** (live run 14): plain read-only inspection inside the project, and rewrites
  of a file the card wrote whole earlier and nobody changed since, reviewed as the whole resulting file.
- **Trust chain for tests** (live run 13): with the trust chain on, a subagent may run a plain known test runner when
  every file it runs or imports was allowed whole in this card (same content now) or is committed and unchanged.
- **Several models on hard turns** (Model: Auto (Jev), request level): consensus Off / Auto (default, only when its
  expected value beats one strong model) / Always, K 2–3, best of N (off by default), a cap per turn. Drafts from
  diverse vendors, buffered and reserved against the caps; a strong judge's merged answer is streamed; a tool call
  passes the single model's answer through; failed or late drafts and a failed judge degrade to what answered.
- **Measured speed**: Artificial Analysis's output speed and first-chunk time per variant are kept with the catalog
  (bundled for the rows its page states) and used for plan time on the routing page; unknown speed is neutral.
- **Trust chain** (command review, off by default, the person's switch on the settings page): a subagent may create
  new files in the project without asking when its orchestrator's task was typed by the person and the review is at
  least 95% sure the file serves it. Never for overwrites, partial edits, paths outside the project, secrets,
  protected paths, commands, cut or oversized content. A file the trusted task names, in the subagent's folder or a
  folder the task names, needs 75% with every other risk low (live run 10: 0.83 for the named module).
- **Prefer plans for small tasks** (on, 30 points): a confidently small task goes to a plan or subscription within 30
  points of the best (by its overall score when it has none for the task type) before paid routes.
- **Plan cost by quota and speed**: on subscriptions, coding plans and flat-rate accounts a model costs the quota it
  uses (expected tokens, ×1.2 for small models until outcomes say otherwise, times a quota weight: the API price
  ratio to the plan's top model, or the person's) and, with known speeds, its time ("value speed"). Within the
  quality window the cheapest wins small and medium tasks; large and risky tasks stay quality-first. Plans can count
  quota by tokens, prompts or not known. `route_outcome` takes `tokens`. The first compact `pick_route` answer says
  how to send a digest next time.
- **Route v2** (agent-level routing, no core change): `route` and its alias `pick_route` choose where a subagent runs —
  your subscriptions on their own CLIs, coding plans through OpenCode, the Accounts plugin's model accounts, Model:
  Auto, or a CLI's own default last — by the Auto catalog's score for the task type within the preference's quality
  window, then price or subscription window share (free with headroom above your reserve, priced as it burns,
  unavailable at 0, unknown after 30 min), at most 2 routed children per subscription, trust under Strict/Warn/Off,
  tunnels to one model with per-route demotion, and a new-model policy (wait for a score; provisional scores mapped
  through anchor models; optional exploration). Every answer names each model-setting plugin for CanvasTTY 1.8.2's
  inheritance rules and passes core's own spawn_agent checks in tests. `route_outcome` records how a routed child
  ended. **Where agents run** on the Decision models page (en/ru) declares subscriptions and plans and shows recent
  route decisions; it forwards CanvasTTY's limit windows (new permission `limits:read`).
- **Model: Auto (Jev)** for OpenCode: a launch option (delegable) that points OpenCode at a router inside the
  Assistant's service on 127.0.0.1 (a key per launch, hashes only, Origin/Host checks). One decision per user turn
  (Jev's task triage within 2.5 s, else word rules), tool steps keep it, titles use the cheapest model; tiers and a
  cheap/balanced/best preference over your own allow-list of OpenRouter or OpenAI-compatible models; failover before
  the first byte with cooldowns; per-card and daily USD caps; a log without text. OpenCode Zen and other providers are
  disabled for the card; a project config that picks models, containers and remote hosts are refused. `route` hands
  Auto to OpenCode subagents of an orchestrator on Auto. Rows on the Decision models page (en/ru) and a model badge.
- **Auto (Jev) chooses from data**: Jev's per-turn triage now gives the task type (coding, review, research, writing,
  chat) as well as the difficulty ("small" only at ≥ 0.9); the router scores the allowed, healthy models with the
  public catalog (models.dev, Artificial Analysis, LiveBench; ported from the experimental catalog: fixed HTTPS
  sources, atomic cache, background and manual refresh, no score transfer between variants, unknown stays unknown,
  old prices not compared) and picks the best score for the type, the cheaper on a tie; cheap/balanced/best set the
  score that may be given up only on a confidently small turn (10/3/0). OpenRouter upstreams offer OpenRouter's whole
  model list with its prices and context (cached), with effort variants Auto sends; OpenAI-compatible upstreams take
  your ids, priced from models.dev by address. Manual tiers stay as an override. The Decision models page shows the
  catalog's freshness with Refresh now, a model table per upstream (price, context, score read-only; exclude, tier,
  effort) and decisions with type, difficulty, model, score, price and reason. A labelled RU/EN task set
  (`tests/fixtures/auto/jev-labelled-tasks.json`, 40 tasks) and `scripts/jev-labels.mjs` score a later live Jev run.
- Tests check the manifest against a core without localized manifest strings by dropping only those keys.
- **After the first live run of Auto (Jev)**: an OpenRouter 400 "is not a valid model ID" fails over and cools that
  model down for 15 min; command review checks a card's actions against its own task (each new user turn the Auto
  router sees; a subagent's task counts as the person's only when typed word for word, else its parent's person
  request applies), so a subagent's requested writes are no longer denied as "not asked for"; "small" from Jev at
  p ≥ 0.5 (chosen on the 40 labelled live answers, now a test fixture); price counts on every turn: the cheapest
  model within 8 / 5 / 3 points (balanced; cheap 15 / 10 / 5) of the best, lower effort preferred except on large
  turns, the trade-off shown per decision; Jev's task triage is limited per card (10 a minute) under a ceiling of 60;
  storage keys earlier versions left (`model-route-history`, `model-discovery`) are dropped at start; a partial
  Artificial Analysis page no longer drops known scores.
- **After live run 2**: a write whose whole new content is in the call (whole-file Write, add-only patch) is not held
  by `effect_hidden`; with no second reviewer set up, the reason says so (en/ru) instead of "could not review it in
  time"; a partial Artificial Analysis page also restores the bundled snapshot's rows; research and review turns
  need p(small) ≥ 0.7 and an orchestrator card's turns are never small.

## 0.2.0

Runs on CanvasTTY 1.8 with the host APIs it has; nothing in the core is specific to this plugin.

- Installs on CanvasTTY main: no `model:route` permission and no calls to host methods CanvasTTY does not have.
- A settings page with four controls: command review (Strict, Basic rules, Off; anything else shows as Custom, read-only), automatic routing, loop alerts and flows. Decision models moved to their own optional page.
- Command review starts Off on a fresh install and on an update; the person turns it on. A storage error at start is not taken for a first run: review stays Off, nothing is saved over the stored settings, and they are read again.
- Orchestrator tools: `route` (provider, model and effort for `spawn_agent`, from a decision model or word rules), `flows_list`, `flow_plan`, `flow_status`, `task_add`, `task_update`, `task_list` (the last two for subagents too).
- Flow preview card: a proposed flow's roles, provider/model and tasks for the person to approve; Start or Cancel. A request to the orchestrator, not a lock. `flow_plan` returns only the plan id and role names; spawn values come from `flow_status` after Start. Start is held briefly after a plan shows and a replaced plan is marked; `flow_plan` is rate-limited per orchestrator. Built-in flows in English and Russian; flows from a real `.canvastty/flows` folder (no links), invisible characters removed, refused files named with fixed reasons.
- Task board card, fed by the task tools and approved flows; a `tasks n/m` badge on the orchestrator.
- Loop alerts: a `loop?` badge when a card runs the same command five times in one turn with no file edit seen (shell edits count, polling does not); it clears on the next turn.
- Card menu actions: Plan from flow…, Task board (orchestrators) and Report (every agent).
- Badges and toasts follow CanvasTTY's language; the pages follow its palette.
- In Russian the card menu shows План по сценарию…, Доска задач and Отчёт (`title.ru` on each card action). A core that does not accept `title.ru` on card actions (before the localized card action titles) rejects the manifest.
- The settings page puts a row's control under its description when the row is too narrow for both, for example at a UI scale of 1.25.

## Unreleased

Requires the CanvasTTY core with plugin API v2 and the `profile`/`canAsk` decide fields: the upcoming release after 1.7.0.

### What you'll notice

- The daily USD cap holds under load: parallel cloud calls can no longer pass it together.
- A model server that failed and came back is judged by the one probe call, not by late answers to calls from before it failed.
- The service's memory no longer grows for as long as CanvasTTY runs: statistics are bounded by the log's retention, and state for sessions whose close never arrived is dropped past 512 sessions.
- Parallel reviews no longer send your local model several requests at once; the second reviewer waits in the same queue of 4.
- Agents other than Claude Code cannot put a question in front of you from the hook; when a review would ask, they now get a deny with the Assistant's reason and what to do instead.
- The "YOLO only isolated" option is gone: YOLO and isolation are CanvasTTY's own rules now. A saved value is ignored.
- The settings page no longer loses a change made while another one is saving, and keeps a pasted key in its field when storing it fails.

### Budgets, breaker and reviews

- A cloud call holds an upper estimate of its cost (price table, request size, batches, retries) against the day's USD cap while it runs; the real cost replaces it, and an unknown cost counts as the estimate.
- A call whose signal is already aborted is never queued for the local backend, and the abort listener is removed once the call is admitted.
- The circuit breaker tags admissions with a generation: a late success or failure of a call admitted before it last opened changes nothing; only the half-open probe closes it.
- Referenced files that are unreadable, cut or past the file limit mark the set incomplete, and command review leaves the command to you.
- An Auto decision rechecks cancellation and the settings epoch after reading the log for its statistics.
- Field names that reach an object prototype are refused by the privacy gate.
- The review answers agents that cannot ask with a deny and its reason; a review that could not finish in a card whose profile still asks you (normal, plan) answers nothing, so the CLI's own prompt decides.

### Memory

- Statistics in memory follow `logRetentionDays`: older decisions and labels are swept hourly, and at once past 100 000 decisions. The first read of the log uses the same window instead of a fixed 400 days.
- The smart verifier takes the local backend slot (one request at a time, a queue of 4); a call that never got its turn gives its budget slot back.
- The denial circuit and the session write tracker keep at most 512 sessions (least recently used dropped), and forget sessions the review service evicts.

### Service transport

- Host calls fail after 30 s and past 64 in flight; all pending calls fail when the host closes the connection.
- Incoming frames are cut from raw bytes at the host's 1 MiB limit; an oversized frame is skipped to its newline. Requests beyond 64 running handlers are answered busy.
- A frame over 1 MiB is never written (an answer becomes an error, a host call fails, an event is dropped with a warning). While the host is not reading, frames wait for `drain` and waiting events and logs are capped at 8 MiB, oldest first; answers and host calls are never dropped.
- On shutdown or end of input the service takes no new work and lets running handlers answer during a short drain.
