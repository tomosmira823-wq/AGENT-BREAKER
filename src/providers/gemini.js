import { fetchJson } from './http.js';
import { withModelHint } from './diagnose.js';

// Google Gemini generateContent with function declarations.
export function geminiProvider(spec, env) {
  const apiKey = env.GEMINI_API_KEY || env.GOOGLE_API_KEY;
  const baseUrl = (env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/$/, '');
  const model = spec.model || 'gemini-3.8-flash';
  let counter = 0;

  function toTools(tools) {
    return [{ functionDeclarations: tools.map((t) => ({ name: t.name, description: t.description, parameters: stripSchema(t.parameters) })) }];
  }

  function toContents(history) {
    let system = '';
    const contents = [];
    for (const m of history) {
      if (m.role === 'system') system += (system ? '\n\n' : '') + m.content;
      else if (m.role === 'user') contents.push({ role: 'user', parts: [{ text: m.content }] });
      else if (m.role === 'assistant') {
        // Gemini 3 signs its tool calls (thoughtSignature) and rejects the next
        // request if the signature is not echoed back. The exact parts the model
        // returned are kept on the first tool call and replayed verbatim.
        const raw = m.toolCalls?.[0]?._geminiParts;
        if (raw) { contents.push({ role: 'model', parts: raw }); continue; }
        const parts = [];
        if (m.content) parts.push({ text: m.content });
        (m.toolCalls || []).forEach((c, i) => {
          const part = { functionCall: { name: c.name, args: c.args || {} } };
          if (c.thoughtSignature) part.thoughtSignature = c.thoughtSignature;
          else if (i === 0) part.thoughtSignature = 'skip_thought_signature_validator'; // history not produced by this API
          parts.push(part);
        });
        if (!parts.length) parts.push({ text: '(no response)' });
        contents.push({ role: 'model', parts });
      } else if (m.role === 'tool') {
        const part = { functionResponse: { name: m.name, response: { result: String(m.content) } } };
        const last = contents[contents.length - 1];
        if (last && last.role === 'user' && last.parts[0]?.functionResponse) last.parts.push(part);
        else contents.push({ role: 'user', parts: [part] });
      }
    }
    return { system, contents };
  }

  return {
    async step(history, tools) {
      if (!apiKey) throw new Error('GEMINI_API_KEY is not set');
      const { system, contents } = toContents(history);
      const listModels = async () => {
        const r = await fetchJson(`${baseUrl}/models?key=${apiKey}&pageSize=100`, { method: 'GET', retries: 0 });
        return (r.models || []).filter((m) => (m.supportedGenerationMethods || []).includes('generateContent')).map((m) => m.name.replace(/^models\//, ''));
      };
      const res = await fetchJson(`${baseUrl}/models/${model}:generateContent?key=${apiKey}`, {
        body: {
          systemInstruction: { parts: [{ text: system }] },
          contents,
          tools: toTools(tools),
        },
      }).catch((e) => withModelHint(e, listModels, model));
      const parts = res.candidates?.[0]?.content?.parts || [];
      let content = '';
      const toolCalls = [];
      for (const p of parts) {
        if (p.text && !p.thought) content += p.text;
        if (p.functionCall) toolCalls.push({ id: `call_${++counter}`, name: p.functionCall.name, args: p.functionCall.args || {}, thoughtSignature: p.thoughtSignature });
      }
      // keep the model turn exactly as returned so signatures survive the round trip
      if (toolCalls.length) Object.defineProperty(toolCalls[0], '_geminiParts', { value: parts, enumerable: false });
      return { content, toolCalls, usage: res.usageMetadata };
    },
  };
}

// Gemini's schema subset dislikes a few JSON schema keywords.
function stripSchema(schema) {
  if (!schema || typeof schema !== 'object') return schema;
  const out = {};
  for (const [k, v] of Object.entries(schema)) {
    if (k === 'additionalProperties' || k === 'default') continue;
    if (k === 'properties') {
      out.properties = {};
      for (const [pk, pv] of Object.entries(v)) out.properties[pk] = stripSchema(pv);
      if (!Object.keys(out.properties).length) {
        // Gemini rejects empty object properties; declare a dummy optional field.
        out.properties = { _: { type: 'string', description: 'unused' } };
      }
    } else if (k === 'type' && v === 'object' && !schema.properties) {
      out.type = 'object';
      out.properties = { _: { type: 'string', description: 'unused' } };
    } else out[k] = typeof v === 'object' && !Array.isArray(v) ? stripSchema(v) : v;
  }
  return out;
}
