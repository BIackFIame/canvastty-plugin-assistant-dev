// Small snapshots of the public catalog sources (models.dev, LiveBench, Artificial Analysis, OpenRouter's model list)
// in their real shapes, with made-up models: the parsers, the cache and the selection are tested on them offline.
import { ARTIFICIAL_ANALYSIS_URL } from '../../src/auto/catalog/artificialAnalysis.ts';
import { LIVEBENCH_INDEX_URL, MODELS_URL } from '../../src/auto/catalog/catalog.ts';
import { OPENROUTER_MODELS_URL } from '../../src/auto/catalog/openrouter.ts';

export const DAY = 24 * 3_600_000;

/** models.dev `api.json`: two providers, one with its API origin. */
export const modelsDev = () => ({
  direct: { id: 'direct', name: 'Direct', api: 'https://api.direct.example/v1', models: {
    'beta-2': { id: 'beta-2', name: 'Beta 2', tool_call: true, modalities: { input: ['text'], output: ['text'] }, cost: { input: 0.3, output: 1 }, limit: { context: 128_000, output: 16_000 } },
    'glm-5.3': { id: 'glm-5.3', name: 'GLM-5.3', tool_call: true, cost: { input: 1.4, output: 4.4 }, limit: { context: 200_000, output: 32_000 } }
  } },
  other: { id: 'other', name: 'Other', models: { 'alpha-1': { id: 'alpha-1', name: 'Alpha 1', tool_call: true } } }
});

/** LiveBench: the public folder listing, one dated table and its categories. */
export const livebenchListing = () => [{ name: 'table_2026_10_01.csv' }, { name: 'categories_2026_10_01.json' }, { name: 'table_2026_09_01.csv' }];
export const livebenchCategories = () => ({ Reasoning: ['r'], Coding: ['c'], 'Agentic Coding': ['a'], Language: ['l'], IF: ['i'], 'Data Analysis': ['d'] });
export const livebenchCsv = () => 'model,r,c,a,l,i,d\nalpha-1-high,80,70,60,75,70,65\nbeta-2,70,60,50,80,85,60\nepsilon-5-thinking-64k-high-effort,90,90,90,90,90,90\n';

/** An Artificial Analysis model page: the comparison dataset as RSC JSON in `self.__next_f.push`. */
const aaRow = (id, model, effort, index, terminal, sci, extra = {}) => ({
  id, slug: `${model}${effort ? `-${effort}` : ''}`, name: model, release: { slug: model, name: model },
  effort: effort ? { slug: effort } : null, suffix: effort, isReasoning: effort !== null,
  intelligenceIndex: index, intelligenceIndexIsEstimated: false, terminalBench40: terminal, scicode: sci, ...extra
});
export const aaRows = () => [
  aaRow('a1h', 'alpha-1', 'high', 50, 0.60, 0.50),
  aaRow('a1l', 'alpha-1', 'low', 40, 0.40, 0.40),
  aaRow('b2', 'beta-2', null, 45, 0.56, 0.52, { isReasoning: false }),
  aaRow('g3', 'gamma-3', null, 60, 0.70, 0.70, { isReasoning: true }), // reasoning setup not named: never scored
  aaRow('d4h', 'delta-4', 'high', 30, 0.20, 0.30),
  aaRow('glm', 'glm-5-3', 'max', 44.7, 0.42, 0.59),
  aaRow('est', 'zeta-6', 'high', 70, 0.9, 0.9, { intelligenceIndexIsEstimated: true, terminalBench40: null })
];
export const aaHtml = (rows = aaRows()) => `<html><p>Artificial Analysis Intelligence Index v4.3.2</p><script>self.__next_f.push(${JSON.stringify([1, `5:${JSON.stringify({ props: { models: rows } })}\n`])})</script></html>`;

/** OpenRouter `GET /api/v1/models`. Prices are USD per token, as strings. */
const orModel = (id, { prompt, completion, tools = true, reasoning = false, output = ['text'], context = 128_000, maxOut = 16_384 }) => ({
  id, name: id, context_length: context, architecture: { modality: `text->${output.join('+')}`, input_modalities: ['text'], output_modalities: output },
  pricing: { prompt, completion }, top_provider: { context_length: context, max_completion_tokens: maxOut },
  supported_parameters: [...(tools ? ['tools', 'tool_choice'] : []), ...(reasoning ? ['reasoning', 'include_reasoning'] : []), 'max_tokens']
});
export const openRouterList = () => ({ data: [
  orModel('vendor/alpha-1', { prompt: '0.000001', completion: '0.000004', reasoning: true, context: 400_000 }),
  orModel('vendor/alpha-1:free', { prompt: '0', completion: '0', reasoning: true }),
  orModel('vendor/beta-2', { prompt: '0.0000005', completion: '0.000002', context: 200_000 }),
  orModel('vendor/gamma-3', { prompt: '0.0000002', completion: '0.0000008', reasoning: true, context: 64_000 }),
  orModel('vendor/delta-4', { prompt: '0.0000001', completion: '0.0000004', reasoning: true, context: 32_000, maxOut: 4_096 }),
  orModel('openrouter/auto', { prompt: '-1', completion: '-1' }),
  orModel('vendor/painter', { prompt: '0.000001', completion: '0.000001', output: ['image'] }),
  orModel('vendor/no-tools', { prompt: '0.000001', completion: '0.000001', tools: false }),
  { id: 'not a valid id', pricing: {} }
] });

/** A fetch that answers the fixed source addresses from the fixtures and records every request. */
export function catalogTransport({ fail = new Set(), overrides = {} } = {}) {
  const calls = [];
  const fn = async (url, options = {}) => {
    calls.push({ url, method: options.method ?? 'GET', headers: options.headers ?? {}, body: options.body ?? null, redirect: options.redirect, credentials: options.credentials });
    const kind = url === MODELS_URL ? 'models.dev' : url === ARTIFICIAL_ANALYSIS_URL ? 'artificial-analysis' : url === OPENROUTER_MODELS_URL ? 'openrouter' : 'livebench';
    if (fail.has(kind)) throw new Error('PRIVATE-TRANSPORT-DETAIL');
    if (overrides[url]) return overrides[url]();
    if (url === MODELS_URL) return Response.json(modelsDev());
    if (url === ARTIFICIAL_ANALYSIS_URL) return new Response(aaHtml());
    if (url === OPENROUTER_MODELS_URL) return Response.json(openRouterList());
    if (url === LIVEBENCH_INDEX_URL) return Response.json(livebenchListing());
    if (url.endsWith('table_2026_10_01.csv')) return new Response(livebenchCsv());
    if (url.endsWith('categories_2026_10_01.json')) return Response.json(livebenchCategories());
    return new Response('not found', { status: 404 });
  };
  fn.calls = calls;
  return fn;
}
