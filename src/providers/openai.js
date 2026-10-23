import { fetchJson } from './http.js';

// OpenAI chat completions with function tools. Also works for any
// OpenAI-compatible endpoint (set OPENAI_BASE_URL).
export function openaiProvider(spec, env) {
  const apiKey = env.OPENAI_API_KEY;
  const baseUrl = (env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
  const model = spec.model || 'gpt-4o';

  function toTools(tools) {
    return tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
  }

  function toMessages(history) {
    const out = [];
    for (const m of history) {
      if (m.role === 'system') out.push({ role: 'system', content: m.content });
      else if (m.role === 'user') out.push({ role: 'user', content: m.content });
      else if (m.role === 'assistant') {
        const msg = { role: 'assistant', content: m.content || null };
        if (m.toolCalls?.length) {
          msg.tool_calls = m.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args || {}) } }));
        }
        out.push(msg);
      } else if (m.role === 'tool') out.push({ role: 'tool', tool_call_id: m.toolCallId, content: String(m.content) });
    }
    return out;
  }

  return {
    async step(history, tools) {
      if (!apiKey) throw new Error('OPENAI_API_KEY is not set');
      const res = await fetchJson(`${baseUrl}/chat/completions`, {
        headers: { authorization: `Bearer ${apiKey}` },
        body: { model, messages: toMessages(history), tools: toTools(tools), tool_choice: 'auto' },
      });
      const msg = res.choices?.[0]?.message || {};
      const toolCalls = (msg.tool_calls || []).map((c) => ({
        id: c.id,
        name: c.function.name,
        args: safeParse(c.function.arguments),
      }));
      return { content: msg.content || '', toolCalls, usage: res.usage };
    },
  };
}

function safeParse(s) {
  try {
    return JSON.parse(s || '{}');
  } catch {
    return { _raw: s };
  }
}
