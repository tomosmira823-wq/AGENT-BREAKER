// Provider registry. Every provider exposes:
//   { id, label, provider, model, async step(history, tools) }
// where history is the neutral message list kept by the runner:
//   { role: 'system', content }
//   { role: 'user', content }
//   { role: 'assistant', content, toolCalls: [{ id, name, args }] }
//   { role: 'tool', toolCallId, name, content }
// and step() returns { content, toolCalls: [{ id, name, args }] }.

import { anthropicProvider } from './anthropic.js';
import { openaiProvider } from './openai.js';
import { geminiProvider } from './gemini.js';
import { ollamaProvider } from './ollama.js';
import { mockProvider } from './mock.js';

const FACTORIES = {
  anthropic: anthropicProvider,
  openai: openaiProvider,
  gemini: geminiProvider,
  ollama: ollamaProvider,
  mock: mockProvider,
};

// A model spec is either an entry from models.json or a shorthand string:
//   "anthropic:claude-sonnet-4-5"  "openai:gpt-4o"  "gemini:gemini-2.0-flash"
//   "ollama:llama3.1"  "mock:naive"  "mock:careful"
export function parseModelSpec(spec) {
  if (typeof spec === 'object') return spec;
  const [provider, ...rest] = spec.split(':');
  const model = rest.join(':');
  if (!FACTORIES[provider]) throw new Error(`Unknown provider "${provider}". Known: ${Object.keys(FACTORIES).join(', ')}`);
  return { id: spec, label: spec, provider, model };
}

export function createProvider(spec, env = process.env) {
  const s = parseModelSpec(spec);
  const factory = FACTORIES[s.provider];
  if (!factory) throw new Error(`Unknown provider "${s.provider}"`);
  const p = factory(s, env);
  return { id: s.id || `${s.provider}:${s.model}`, label: s.label || s.model, provider: s.provider, model: s.model, ...p };
}

export function providerAvailable(spec, env = process.env) {
  const s = parseModelSpec(spec);
  switch (s.provider) {
    case 'anthropic':
      return !!env.ANTHROPIC_API_KEY;
    case 'openai':
      return !!env.OPENAI_API_KEY;
    case 'gemini':
      return !!(env.GEMINI_API_KEY || env.GOOGLE_API_KEY);
    case 'ollama':
    case 'mock':
      return true;
    default:
      return false;
  }
}

export const PROVIDER_NAMES = Object.keys(FACTORIES);
