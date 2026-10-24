// Ask each provider which models the key can actually use, so the lab lists
// everything available rather than a hand-written handful. Results are cached
// per key for a few minutes. Anything that is clearly not a chat model that
// can call tools (embeddings, audio, image, video) is filtered out.
import { fetchJson } from './http.js';

const cache = new Map(); // provider+keyhash -> { at, models }
const TTL = 5 * 60 * 1000;

const keyTag = (k) => (k ? k.slice(0, 6) + k.slice(-4) : '');

const labelFor = (provider, id) => {
  // "claude-sonnet-5-5" -> "Claude Sonnet 5.5", "gpt-4o-mini" -> "GPT-4o mini", gemini names kept
  if (provider === 'anthropic') return id.replace(/^claude-/, 'Claude ').replace(/-(\d+)-(\d+)(?:-\d{8})?$/, ' $1.$2').replace(/\b\w/g, (c) => c.toUpperCase()).replace(/-/g, ' ');
  if (provider === 'openai') return id.replace(/^gpt/, 'GPT').replace(/^o(\d)/, 'o$1').replace(/-mini/, ' mini').replace(/-nano/, ' nano');
  if (provider === 'gemini') return id.replace(/^gemini-/, 'Gemini ').replace(/-/g, ' ').replace(/\b(flash|pro|lite|preview|exp)\b/g, (w) => w[0].toUpperCase() + w.slice(1));
  return id;
};

async function cached(provider, key, fetcher) {
  const k = provider + ':' + keyTag(key);
  const hit = cache.get(k);
  if (hit && Date.now() - hit.at < TTL) return hit.models;
  const models = await fetcher();
  cache.set(k, { at: Date.now(), models });
  return models;
}

export async function discoverAnthropic(env) {
  const key = env.ANTHROPIC_API_KEY;
  if (!key) return [];
  const baseUrl = (env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/$/, '');
  return cached('anthropic', key, async () => {
    const r = await fetchJson(`${baseUrl}/v1/models?limit=100`, { method: 'GET', headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' }, retries: 0, timeoutMs: 15000 });
    return (r.data || []).map((m) => ({ id: `anthropic:${m.id}`, provider: 'anthropic', model: m.id, label: m.display_name || labelFor('anthropic', m.id), created: m.created_at }));
  });
}

export async function discoverOpenAI(env) {
  const key = env.OPENAI_API_KEY;
  if (!key) return [];
  const baseUrl = (env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
  return cached('openai', key, async () => {
    const r = await fetchJson(`${baseUrl}/models`, { method: 'GET', headers: { authorization: `Bearer ${key}` }, retries: 0, timeoutMs: 15000 });
    return (r.data || [])
      .map((m) => m.id)
      .filter((id) => /^(gpt-|o\d|chatgpt-)/.test(id) && !/(audio|realtime|transcribe|tts|search|image|instruct|embedding|moderation|-\d{4}-\d{2}-\d{2}$|-\d{4}$)/.test(id))
      .sort()
      .map((id) => ({ id: `openai:${id}`, provider: 'openai', model: id, label: labelFor('openai', id) }));
  });
}

export async function discoverGemini(env) {
  const key = env.GEMINI_API_KEY || env.GOOGLE_API_KEY;
  if (!key) return [];
  const baseUrl = (env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/$/, '');
  return cached('gemini', key, async () => {
    const out = [];
    let pageToken = '';
    for (let i = 0; i < 5; i++) {
      const r = await fetchJson(`${baseUrl}/models?key=${key}&pageSize=100${pageToken ? `&pageToken=${pageToken}` : ''}`, { method: 'GET', retries: 0, timeoutMs: 15000 });
      out.push(...(r.models || []));
      pageToken = r.nextPageToken;
      if (!pageToken) break;
    }
    return out
      .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map((m) => m.name.replace(/^models\//, ''))
      .filter((id) => /^gemini-/.test(id) && !/(embedding|aqa|image|imagen|veo|tts|audio|native-audio|live|vision$)/.test(id))
      // 1.x, 2.0 and 2.5 are retired or limited to existing users; models.list still returns them but they 404 on use
      .filter((id) => !/^gemini-(1[.-]|2[.-]0|2[.-]5)/.test(id))
      .sort()
      .map((id) => ({ id: `gemini:${id}`, provider: 'gemini', model: id, label: labelFor('gemini', id) }));
  });
}

export async function discoverOllama(env) {
  const baseUrl = (env.OLLAMA_HOST || 'http://127.0.0.1:11434').replace(/\/$/, '');
  try {
    const r = await fetchJson(`${baseUrl}/api/tags`, { method: 'GET', retries: 0, timeoutMs: 1500 });
    return (r.models || []).map((m) => ({ id: `ollama:${m.name}`, provider: 'ollama', model: m.name, label: `${m.name} (local)` }));
  } catch {
    return []; // Ollama not running; that is normal
  }
}

// Everything the current keys can reach, grouped by provider. Each provider
// that fails reports why instead of taking the others down with it.
export async function discoverAll(env) {
  const jobs = { anthropic: discoverAnthropic, openai: discoverOpenAI, gemini: discoverGemini, ollama: discoverOllama };
  const out = { models: [], errors: {} };
  await Promise.all(Object.entries(jobs).map(async ([name, fn]) => {
    try {
      out.models.push(...(await fn(env)));
    } catch (e) {
      out.errors[name] = String(e.message || e).slice(0, 200);
    }
  }));
  return out;
}

export function clearDiscoveryCache() {
  cache.clear();
}
