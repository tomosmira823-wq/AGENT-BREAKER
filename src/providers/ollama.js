import { fetchJson } from './http.js';

// Local models through Ollama's /api/chat with tools. Needs a model that
// supports tool calling (llama3.1, qwen2.5, mistral-nemo, etc).
export function ollamaProvider(spec, env) {
  const baseUrl = (env.OLLAMA_HOST || 'http://127.0.0.1:11434').replace(/\/$/, '');
  const model = spec.model || 'llama3.1';
  let counter = 0;

  function toTools(tools) {
    return tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
  }

  function toMessages(history) {
    const out = [];
    for (const m of history) {
      if (m.role === 'system') out.push({ role: 'system', content: m.content });
      else if (m.role === 'user') out.push({ role: 'user', content: m.content });
      else if (m.role === 'assistant') {
        const msg = { role: 'assistant', content: m.content || '' };
        if (m.toolCalls?.length) msg.tool_calls = m.toolCalls.map((c) => ({ function: { name: c.name, arguments: c.args || {} } }));
        out.push(msg);
      } else if (m.role === 'tool') out.push({ role: 'tool', content: String(m.content) });
    }
    return out;
  }

  return {
    async step(history, tools) {
      const res = await fetchJson(`${baseUrl}/api/chat`, {
        body: { model, messages: toMessages(history), tools: toTools(tools), stream: false },
        timeoutMs: 600000,
      });
      const msg = res.message || {};
      const toolCalls = (msg.tool_calls || []).map((c) => ({ id: `call_${++counter}`, name: c.function.name, args: c.function.arguments || {} }));
      return { content: msg.content || '', toolCalls };
    },
  };
}
