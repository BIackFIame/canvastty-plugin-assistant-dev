// An OpenAI-compatible upstream on 127.0.0.1:0 for the Auto (Jev) router tests. Each model id gets a scripted
// behaviour; every request is recorded (method, path, auth header, body) and every byte it streamed is kept, so a
// test can check the router passed the stream through unchanged. No network beyond loopback.
import { createServer } from 'node:http';

export const sse = value => `data: ${typeof value === 'string' ? value : JSON.stringify(value)}\n\n`;

/** A streamed answer with text, a tool call split over deltas, and the usage chunk (with OpenRouter's cost). */
export function streamChunks(model, { cost = 0.000123, text = 'Hello', toolCall = true } = {}) {
  const base = { id: 'chatcmpl-1', object: 'chat.completion.chunk', created: 1, model };
  if (!toolCall) return [
    sse({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] }),
    sse({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
    sse({ ...base, choices: [], usage: { prompt_tokens: 90, completion_tokens: 3, total_tokens: 93, cost } }),
    sse('[DONE]')
  ];
  return [
    sse({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] }),
    sse({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'read', arguments: '{"pa' } }] }, finish_reason: null }] }),
    sse({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"a.txt"}' } }] }, finish_reason: null }] }),
    sse({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }),
    sse({ ...base, choices: [], usage: { prompt_tokens: 120, completion_tokens: 7, total_tokens: 127, cost } }),
    sse('[DONE]')
  ];
}

/**
 * behaviours: { [modelId]: 'stream' | 'json' | 'text' | 'text-slow' | 'cut' | 'hang' | 'slow-first' | number (an HTTP status) | { status, headers, body } }
 * A model without a behaviour streams: a tool call while tools are offered, plain text after a tool result.
 */
export async function startFakeUpstream({ behaviours = {}, key = 'up-key', firstChunkDelayMs = 0 } = {}) {
  const requests = [];
  const sent = [];
  const sockets = new Set();
  const server = createServer((request, response) => {
    let raw = '';
    request.setEncoding('utf8');
    request.on('data', chunk => { raw += chunk; });
    request.on('end', async () => {
      let json = null;
      try { json = JSON.parse(raw); } catch { /* not JSON */ }
      const entry = { method: request.method, path: request.url, auth: request.headers.authorization ?? null, raw, json, model: json?.model ?? null };
      requests.push(entry);
      if (key && request.headers.authorization !== `Bearer ${key}`) {
        response.writeHead(401, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'No auth credentials found', code: 401 } }));
        return;
      }
      if (request.url.endsWith('/models')) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ data: Object.keys(behaviours).map(id => ({ id })) }));
        return;
      }
      const behaviour = behaviours[entry.model] ?? 'stream';
      if (typeof behaviour === 'number' || (behaviour && typeof behaviour === 'object')) {
        const { status, headers = {}, body } = typeof behaviour === 'number' ? { status: behaviour } : behaviour;
        response.writeHead(status, { 'content-type': 'application/json', ...headers });
        response.end(JSON.stringify(body ?? { error: { message: `scripted ${status} for ${entry.model}: SECRET-UPSTREAM-DETAIL`, code: status } }));
        return;
      }
      if (behaviour === 'hang') return;
      if (behaviour === 'text' || behaviour === 'text-slow') {
        // A text answer even with tools offered; a judge's request (it carries the drafts) gets a merged answer.
        const last = json?.messages?.at(-1);
        const said = typeof last?.content === 'string' ? last.content : '';
        const drafts = (said.match(/--- Draft \d+ ---/gu) ?? []).length;
        const text = drafts ? `MERGED ANSWER from ${drafts} drafts` : `Draft from ${entry.model}`;
        if (json?.stream === false) {
          const body = JSON.stringify({ id: 'chatcmpl-3', object: 'chat.completion', model: entry.model, choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 50, completion_tokens: 9, cost: 0.0002 } });
          sent.push({ model: entry.model, bytes: body });
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(body);
          return;
        }
        response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        const record = { model: entry.model, bytes: '' };
        sent.push(record);
        if (behaviour === 'text-slow') await new Promise(resolve => setTimeout(resolve, 400));
        for (const chunk of streamChunks(entry.model, { toolCall: false, text, cost: 0.0002 })) {
          if (response.destroyed) return;
          record.bytes += chunk;
          response.write(chunk);
          await new Promise(resolve => setImmediate(resolve));
        }
        response.end();
        return;
      }
      if (behaviour === 'json') {
        response.writeHead(200, { 'content-type': 'application/json' });
        const body = JSON.stringify({ id: 'chatcmpl-2', object: 'chat.completion', model: entry.model, choices: [{ index: 0, message: { role: 'assistant', content: 'Hi' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2, cost: 0.00001 } });
        sent.push({ model: entry.model, bytes: body });
        response.end(body);
        return;
      }
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      // After a tool result (or with no tools offered) the answer is plain text, so an agent's loop ends.
      const last = json?.messages?.at(-1);
      const chunks = streamChunks(entry.model, { toolCall: last?.role !== 'tool' && Array.isArray(json?.tools) && json.tools.length > 0, text: last?.role === 'tool' ? 'DONE-AFTER-TOOL' : 'Hello' });
      const record = { model: entry.model, bytes: '' };
      sent.push(record);
      if (behaviour === 'slow-first' || firstChunkDelayMs) await new Promise(resolve => setTimeout(resolve, behaviour === 'slow-first' ? 400 : firstChunkDelayMs));
      for (const [index, chunk] of chunks.entries()) {
        if (behaviour === 'cut' && index === 2) { response.socket.destroy(); return; }
        record.bytes += chunk;
        response.write(chunk);
        await new Promise(resolve => setImmediate(resolve));
      }
      response.end();
    });
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}/v1`, port, requests, sent, behaviours,
    posts: () => requests.filter(entry => entry.method === 'POST'),
    async close() { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); }
  };
}
