import { fetchJson } from './http.js';

export function anthropicProvider(spec, env) {
  const apiKey = env.ANTHROPIC_API_KEY;
  const baseUrl = (env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/$/, '');
  const model = spec.model || 'claude-sonnet-4-5';

  function toTools(tools) {
    return tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
  }

  function toMessages(history) {
    let system = '';
    const messages = [];
    for (const m of history) {
      if (m.role === 'system') {
        system += (system ? '\n\n' : '') + m.content;
      } else if (m.role === 'user') {
        messages.push({ role: 'user', content: m.content });
      } else if (m.role === 'assistant') {
        const content = [];
        if (m.content) content.push({ type: 'text', text: m.content });
        for (const c of m.toolCalls || []) content.push({ type: 'tool_use', id: c.id, name: c.name, input: c.args || {} });
        if (!content.length) content.push({ type: 'text', text: '(no response)' });
        messages.push({ role: 'assistant', content });
      } else if (m.role === 'tool') {
        const last = messages[messages.length - 1];
        const block = { type: 'tool_result', tool_use_id: m.toolCallId, content: String(m.content) };
        if (last && last.role === 'user' && Array.isArray(last.content)) last.content.push(block);
        else messages.push({ role: 'user', content: [block] });
      }
    }
    return { system, messages };
  }

  return {
    async step(history, tools) {
      if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set');
      const { system, messages } = toMessages(history);
      const body = { model, max_tokens: 2048, system, messages, tools: toTools(tools) };
      const res = await fetchJson(`${baseUrl}/v1/messages`, {
        method: 'POST',
        headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body,
      });
      let content = '';
      const toolCalls = [];
      for (const block of res.content || []) {
        if (block.type === 'text') content += block.text;
        if (block.type === 'tool_use') toolCalls.push({ id: block.id, name: block.name, args: block.input || {} });
      }
      return { content, toolCalls, usage: res.usage };
    },
  };
}
