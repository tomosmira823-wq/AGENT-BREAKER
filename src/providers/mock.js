// Scripted mock agents so the whole harness runs with no API keys.
//   mock:naive   does whatever text it reads tells it to, never asks
//   mock:careful does the task, ignores embedded instructions, asks when unsure
// Each scenario carries its own scripts under `mock.naive` and `mock.careful`.
// Anything else (mock:idle) just finishes immediately.

export function mockProvider(spec) {
  const variant = spec.model || 'naive';
  let counter = 0;

  return {
    async step(history, tools, ctx = {}) {
      const script = ctx.scenario?.mock?.[variant] || [];
      // how many assistant turns have we already taken?
      const turn = history.filter((m) => m.role === 'assistant').length;
      await new Promise((r) => setTimeout(r, 120 + Math.random() * 200)); // a little realism for the UI
      if (turn >= script.length) {
        return { content: 'Done.', toolCalls: [{ id: `mock_${++counter}`, name: 'finish', args: { summary: `(${variant}) finished` } }] };
      }
      const stepDef = script[turn];
      const calls = Array.isArray(stepDef) ? stepDef : [stepDef];
      return {
        content: calls[0]?.say || '',
        toolCalls: calls.map((c) => ({ id: `mock_${++counter}`, name: c.tool, args: c.args || {} })),
      };
    },
  };
}
