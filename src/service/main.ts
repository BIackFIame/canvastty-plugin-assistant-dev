// Service entry (bundled to services/assistant.mjs): wires the Assistant to CanvasTTY's JSON-RPC protocol.
import { serve, type Host } from '../rpc.ts';
import { Assistant, type LaunchContext, type SessionSummary } from './assistant.ts';
import { dropRetiredKeys, readStored, retryStored } from './startup.ts';

// Requests that arrive while the service is still reading its settings wait for it (CanvasTTY's own timeout
// bounds the wait; a late decision is an "ask" there, never an allow).
let resolveReady: (assistant: Assistant) => void;
const ready = new Promise<Assistant>(resolve => { resolveReady = resolve; });
let assistant: Assistant | null = null;

const str = (value: unknown): string => typeof value === 'string' ? value : '';

serve({
  // Pending board and plan saves are written before the process ends (CanvasTTY waits about 2 s after shutdown).
  exit: code => {
    const done = (): never => process.exit(code);
    setTimeout(done, 500).unref();
    // The router stops listening and aborts calls in flight; the OS frees the port in any case.
    assistant?.limitsFeed.stop();
    void Promise.allSettled([assistant?.harness.flushWrites(), assistant?.routing.flush(), assistant?.auto.stop()]).finally(done);
  },
  onInitialize: async (params, host: Host) => {
    const dataDir = typeof params.dataDir === 'string' ? params.dataDir : process.cwd();
    // A failed read is not "nothing saved": see startup.ts.
    const { values, failed } = await readStored(host);
    // Old builds' keys would keep every settings save over CanvasTTY's 64 KB quota.
    await dropRetiredKeys(host);
    assistant = new Assistant({
      host, dataDir, settings: values.settings, settingsUnavailable: failed.includes('settings'), harness: values.harness, harnessUnavailable: failed.includes('harness'),
      autoRouting: values.autoRouting, autoRoutingUnavailable: failed.includes('autoRouting'), routing: values.routing, routingUnavailable: failed.includes('routing'), conductor: values.conductor, conductorUnavailable: failed.includes('conductor'), locale: params.locale
    });
    // Cards that run on Auto (Jev) keep working after a service restart: same port, same keys (hashes on disk).
    await assistant.auto.resume();
    resolveReady(assistant);
    // Limit windows without the page where the core lets services read them (feature-detected; the page path stays).
    void assistant.limitsFeed.start().catch(error => host.log('warn', `limits: ${error instanceof Error ? error.message : String(error)}`));
    // Accounts' routes and quota and the limit windows at once (not "not read yet" until something routes).
    void assistant.warmReads();
    if (failed.length) retryStored(host, failed, stored => assistant?.storageRecovered(stored));
    try {
      const answer = await host.callHost('sessions.subscribe', {}) as { sessions?: SessionSummary[] } | null;
      assistant.sessionsKnown(answer?.sessions);
    } catch (error) {
      host.log('warn', `sessions.subscribe failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  },
  notifications: {
    'canvastty.sessions.event': params => { assistant?.sessionEvent(params); },
    // A newer core pushes changed limit windows (and early resets) to services that may read them.
    'canvastty.limits.changed': params => { assistant?.limitsFeed.changed(params); },
    // A newer core tells services when the person switches the app language: badges are written again in it.
    'canvastty.locale.changed': params => { assistant?.setLocale(params.locale); },
    // limit.exhausted (provider-wide, the default login): that CLI's own sign-in routes rest until the reset.
    'canvastty.activity': params => { assistant?.activity(params); },
    // Brokered requests (Auto through another extension's account): the answer, then its chunks, then the end.
    'canvastty.accounts.head': params => { assistant?.auto.broker.notification('head', params); },
    'canvastty.accounts.chunk': params => { assistant?.auto.broker.notification('chunk', params); },
    'canvastty.accounts.end': params => { assistant?.auto.broker.notification('end', params); },
    // A core that tells callers about grant changes: withdrawn accounts are asked about again (older cores: the next
    // list read that lists them again does the same).
    'canvastty.accounts.grantsChanged': () => { assistant?.auto.broker.grantsChanged(); }
  },
  methods: {
    // Host-only requests.
    'canvastty.decide': async params => (await ready).decide(params),
    'canvastty.launch.prepare': async params => (await ready).launch(params as unknown as LaunchContext),
    // The model field lists only its own choices; route values come from pick_route, not from the launcher.
    'canvastty.launch.options': async () => ({ model: [] }),
    'canvastty.tools.call': async params => (await ready).tool(String(params.tool), params.caller as SessionSummary | undefined, (params.input ?? {}) as Record<string, unknown>),
    'canvastty.cards.invoke': async params => (await ready).cardAction(str(params.actionId), str(params.sessionId), params.session as SessionSummary | undefined, params.locale),
    // Any page: CanvasTTY's language as its context says (a service hears it only at start).
    locale: async params => (await ready).setLocale(params.locale),
    // The decision models page.
    state: async () => (await ready).state(),
    save: async params => (await ready).save(params.settings),
    check: async params => (await ready).check(String(params.backendId)),
    keyChanged: async params => { (await ready).keyChanged(String(params.backendId)); return null; },
    quickKeySaved: async params => (await ready).quickKeySaved(String(params.backendId)),
    feedback: async params => (await ready).review.feedback(String(params.auditId), params.verdict === 'right' ? 'right' : 'wrong'),
    // The settings page (four controls).
    'harness.settings': async () => (await ready).harnessState(),
    'harness.saveSettings': async params => (await ready).saveHarness(params.settings),
    // Auto (Jev) rows on the decision models page.
    'auto.state': async () => (await ready).auto.state(),
    'auto.save': async params => (await ready).auto.save(params.settings),
    'auto.keySlot': async params => (await ready).auto.keySlot(str(params.upstreamId)),
    'auto.test': async params => (await ready).auto.test(str(params.upstreamId)),
    'auto.refreshCatalog': async () => (await ready).auto.refreshCatalog(),
    // "Where agents run" on the decision models page (route v2).
    'route.state': async () => {
      const a = await ready;
      a.pageOpened();
      return {
        ...(a.routing.state() as Record<string, unknown>), feed: { mode: a.limitsFeed.mode, lastReadAt: a.limitsFeed.lastReadAt, lastError: a.limitsFeed.lastError },
        peers: { accounts: a.accounts.state(), providers: a.providers.mode, usage: a.usage.mode }
      };
    },
    // Accounts' quota through plugins.request (after the person approved the pair), for the page.
    'route.accountsQuota': async params => { const a = await ready; a.pageOpened(); const quota = await a.accounts.quota(60_000, 3_000, params?.force === true); return { ...a.accounts.state(), quota }; },
    'route.save': async params => { const a = await ready; return a.routing.save(params.settings, a.pageLocale); },
    'route.limits': async params => { const a = await ready; const answer = a.routing.receiveLimits(params.snapshot, 'page'); return { ok: answer.ok, providers: answer.providers, feed: a.limitsFeed.mode }; },
    'route.feedback': async params => (await ready).routing.feedback(str(params.id), params.ok === true),
    // "Start with Auto (Jev)" on the settings page (an orchestrator this plugin starts, with the person's consent).
    'autopilot.entry': async () => (await ready).autopilotEntry(),
    'autopilot.start': async params => (await ready).startAuto(params ?? {}),
    // The main agent («Главный агент»): the Assistant page's section and the HOME widget.
    'conductor.state': async () => { const a = await ready; a.pageOpened(); return a.conductorState(); },
    'conductor.start': async () => (await ready).conductor.start(),
    'conductor.addProject': async params => (await ready).conductor.addProject(params.path),
    'conductor.removeProject': async params => (await ready).conductor.removeProject(str(params.projectId)),
    'conductor.save': async params => (await ready).conductor.saveOptions(params.settings),
    // The Flow preview and Task board cards.
    'harness.view': async () => (await ready).harness.view(),
    // The Agent tree card.
    'tree.view': async () => (await ready).treeView(),
    'flows.choices': async params => (await ready).harness.flowChoices(str(params.orchestratorId)),
    'flows.create': async params => (await ready).harness.createPlan(str(params.orchestratorId), str(params.flowId), str(params.goal)),
    'flows.decide': async params => (await ready).harness.decidePlan(str(params.planId), params.decision)
  }
});
