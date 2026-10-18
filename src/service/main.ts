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
      autoRouting: values.autoRouting, autoRoutingUnavailable: failed.includes('autoRouting'), routing: values.routing, routingUnavailable: failed.includes('routing'), locale: params.locale
    });
    // Cards that run on Auto (Jev) keep working after a service restart: same port, same keys (hashes on disk).
    await assistant.auto.resume();
    resolveReady(assistant);
    if (failed.length) retryStored(host, failed, stored => assistant?.storageRecovered(stored));
    try {
      const answer = await host.callHost('sessions.subscribe', {}) as { sessions?: SessionSummary[] } | null;
      assistant.sessionsKnown(answer?.sessions);
    } catch (error) {
      host.log('warn', `sessions.subscribe failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  },
  notifications: {
    'canvastty.sessions.event': params => { assistant?.sessionEvent(params); }
  },
  methods: {
    // Host-only requests.
    'canvastty.decide': async params => (await ready).decide(params),
    'canvastty.launch.prepare': async params => (await ready).launch(params as unknown as LaunchContext),
    'canvastty.tools.call': async params => (await ready).tool(String(params.tool), params.caller as SessionSummary | undefined, (params.input ?? {}) as Record<string, unknown>),
    'canvastty.cards.invoke': async params => (await ready).harness.cardAction(str(params.actionId), str(params.sessionId), params.session as SessionSummary | undefined),
    // The decision models page.
    state: async () => (await ready).state(),
    save: async params => (await ready).save(params.settings),
    check: async params => (await ready).check(String(params.backendId)),
    keyChanged: async params => { (await ready).keyChanged(String(params.backendId)); return null; },
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
    'route.state': async () => (await ready).routing.state(),
    'route.save': async params => { const a = await ready; return a.routing.save(params.settings, a.pageLocale); },
    'route.limits': async params => (await ready).routing.receiveLimits(params.snapshot),
    'route.feedback': async params => (await ready).routing.feedback(str(params.id), params.ok === true),
    // The Flow preview and Task board cards.
    'harness.view': async () => (await ready).harness.view(),
    'flows.choices': async params => (await ready).harness.flowChoices(str(params.orchestratorId)),
    'flows.create': async params => (await ready).harness.createPlan(str(params.orchestratorId), str(params.flowId), str(params.goal)),
    'flows.decide': async params => (await ready).harness.decidePlan(str(params.planId), params.decision)
  }
});
