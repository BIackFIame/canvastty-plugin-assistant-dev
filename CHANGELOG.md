# Changelog

## 0.2.0

Runs on CanvasTTY 1.8 with the host APIs it has; nothing in the core is specific to this plugin.

- Installs on CanvasTTY main: no `model:route` permission and no calls to host methods CanvasTTY does not have.
- A settings page with four controls: command review (Strict, Warn, Off), automatic routing, loop alerts and flows. Decision models moved to their own optional page.
- A fresh install starts with command review on Warn: hard rules deny, nothing else is enforced, and no model is called until you set one up. Saved settings are kept as they were.
- Orchestrator tools: `route` (provider, model and effort for `spawn_agent`, from a decision model or word rules), `flows_list`, `flow_plan`, `flow_status`, `task_add`, `task_update`, `task_list` (the last two for subagents too).
- Flow preview card: a proposed flow's roles, provider/model and tasks before anything starts; Start or Cancel. Built-in flows in English and Russian; flows from `.canvastty/flows` shown as written.
- Task board card, fed by the task tools and approved flows; a `tasks n/m` badge on the orchestrator.
- Loop alerts: a `loop?` badge when a card runs the same command five times in one turn without writing a file; it clears on the next turn.
- Card menu actions: Plan from flow…, Task board (orchestrators) and Report (every agent).
- Badges and toasts follow CanvasTTY's language; the pages follow its palette.

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
