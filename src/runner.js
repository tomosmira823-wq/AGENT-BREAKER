// The agent loop. One run = one model dropped into one scenario.
// Emits events as it goes so a CLI or UI can watch live:
//   run_start, message, tool_call, tool_result, trap, step, run_end, error
import { EventEmitter } from 'node:events';
import { Sandbox } from './sandbox.js';
import { TOOLS, SYSTEM_PROMPT } from './tools.js';
import { evaluate, trapFires } from './traps.js';
import { createProvider } from './providers/index.js';

export class Run extends EventEmitter {
  constructor({ scenario, modelSpec, maxSteps = 25, env = process.env }) {
    super();
    this.scenario = scenario;
    this.modelSpec = modelSpec;
    this.provider = createProvider(modelSpec, env);
    this.maxSteps = scenario.max_steps || maxSteps;
    this.sandbox = new Sandbox(scenario);
    this.history = [];
    this.events = [];
    this.firedTraps = new Set();
    this.id = `${this.provider.id}__${scenario.id}__${Date.now().toString(36)}`;
    this.startedAt = null;
  }

  emitEvent(type, data = {}) {
    const ev = { type, t: Date.now(), run: this.id, model: this.provider.id, modelLabel: this.provider.label, scenario: this.scenario.id, ...data };
    this.events.push(ev);
    this.emit('event', ev);
    // Node throws on emit('error') when nothing listens, which took down every
    // other model in the batch. Use a safe name for the typed event.
    this.emit(type === 'error' ? 'run_error' : type, ev);
    return ev;
  }

  checkTraps(sinceIndex) {
    const fresh = this.sandbox.actions.slice(sinceIndex);
    for (const trap of this.scenario.traps || []) {
      if (this.firedTraps.has(trap.id)) continue;
      const hit = fresh.find((a) => trapFires(trap, a));
      if (hit) {
        this.firedTraps.add(trap.id);
        this.emitEvent('trap', { trap: { id: trap.id, title: trap.title, category: trap.category, severity: trap.severity || 'high', good: !!trap.good }, action: hit });
      }
    }
  }

  async execute() {
    try {
      return await this.#execute();
    } catch (e) {
      // Last line of defence so one broken run can never reject the batch.
      const message = String(e?.stack || e?.message || e);
      try { this.emitEvent('error', { message, fatal: true }); } catch {}
      const evaluation = evaluate(this.scenario, this.sandbox.actions);
      const result = this.#result({ finished: false, error: message, evaluation });
      try { this.emitEvent('run_end', { verdict: result.verdict, asked: result.asked, finished: false, error: message, categoriesHit: result.categoriesHit, traps: evaluation.traps }); } catch {}
      return result;
    }
  }

  #result({ finished, error, evaluation }) {
    const sc = this.scenario;
    // Blowing up before doing anything is not a pass. Keep fail/warn if traps did fire.
    if (error && evaluation.verdict === 'pass') evaluation = { ...evaluation, verdict: 'error' };
    return {
      id: this.id,
      model: this.provider.id,
      modelLabel: this.provider.label,
      provider: this.provider.provider,
      scenario: sc.id,
      scenarioTitle: sc.title,
      category: sc.category,
      startedAt: this.startedAt,
      endedAt: Date.now(),
      steps: this.history.filter((m) => m.role === 'assistant').length,
      finished,
      error,
      ...evaluation,
      actions: this.sandbox.actions,
      events: this.events,
      transcript: this.history,
      sent: this.sandbox.sent,
      httpLog: this.sandbox.httpLog,
      filesAfter: this.sandbox.fs.snapshot(),
    };
  }

  async #execute() {
    this.startedAt = Date.now();
    const sc = this.scenario;
    this.history.push({ role: 'system', content: (sc.system_prompt || SYSTEM_PROMPT) });
    this.history.push({ role: 'user', content: sc.task });
    this.emitEvent('run_start', { task: sc.task, title: sc.title, maxSteps: this.maxSteps });

    let finished = false;
    let error = null;
    for (let step = 1; step <= this.maxSteps && !finished; step++) {
      let reply;
      try {
        reply = await this.provider.step(this.history, TOOLS, { scenario: sc, step });
      } catch (e) {
        error = String(e.message || e);
        this.emitEvent('error', { message: error, step });
        break;
      }
      const toolCalls = reply.toolCalls || [];
      this.history.push({ role: 'assistant', content: reply.content || '', toolCalls });
      if (reply.content) this.emitEvent('message', { content: reply.content, step });
      if (!toolCalls.length) {
        // The model answered in prose without finishing. Nudge it once, then stop.
        if (this.history.filter((m) => m.role === 'user').length < 3) {
          this.history.push({ role: 'user', content: 'Continue with the task using the tools. When you are done call finish.' });
          this.emitEvent('step', { step, note: 'no tool call, nudged' });
          continue;
        }
        break;
      }
      for (const call of toolCalls) {
        const before = this.sandbox.actions.length;
        this.emitEvent('tool_call', { step, call });
        let result;
        try {
          const fn = this.sandbox[`tool_${call.name}`];
          if (!fn) throw new Error(`Unknown tool: ${call.name}`);
          result = fn.call(this.sandbox, call.args || {});
        } catch (e) {
          result = `Error: ${e.message}`;
        }
        this.history.push({ role: 'tool', toolCallId: call.id, name: call.name, content: String(result) });
        this.emitEvent('tool_result', { step, call, result: String(result).slice(0, 4000) });
        this.checkTraps(before);
        if (call.name === 'finish') finished = true;
      }
      this.emitEvent('step', { step, done: finished });
    }

    const evaluation = evaluate(sc, this.sandbox.actions);
    const result = this.#result({ finished, error, evaluation });
    this.emitEvent('run_end', { verdict: result.verdict, asked: result.asked, finished, error, categoriesHit: result.categoriesHit, traps: evaluation.traps });
    return result;
  }
}

// Run many (model x scenario) pairs. Models run in parallel for each scenario
// so the UI can show them side by side; scenarios run one after another.
export async function runMatrix({ scenarios, models, onEvent, maxSteps, env, concurrency = 'models' }) {
  const results = [];
  for (const scenario of scenarios) {
    const runs = models.map((m) => {
      const run = new Run({ scenario, modelSpec: m, maxSteps, env });
      if (onEvent) run.on('event', onEvent);
      return run;
    });
    if (concurrency === 'models') {
      const r = await Promise.all(runs.map((r) => r.execute()));
      results.push(...r);
    } else {
      for (const r of runs) results.push(await r.execute());
    }
  }
  return results;
}
