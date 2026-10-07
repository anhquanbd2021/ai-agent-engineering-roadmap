// The agent loop engine — Reason -> Act -> Observe -> Decide -> Repeat, with
// the harness around it: bounded retries, guardrail checks, a context budget
// with compaction, a step budget, and a no-progress detector. Every event is
// appended to a structured trace (concept 10: observability).

import { TOOL_DEFS, TRANSIENT_CODES, checkGuardrail, validateArgs, callTool, initWorld, ToolError } from './tools.mjs';
import { decideNext } from './reasoner.mjs';

const tokens = (text) => Math.ceil(String(text).length / 4);

const entryTokens = (e) => e.tokens;

function contextTokens(context) {
  return context.reduce((sum, e) => sum + entryTokens(e), 0);
}

// Compact the oldest observations into a single summary line — keeps the
// system prompt, the task, and the two most recent observations verbatim.
function compact(state) {
  const pinned = state.context.slice(0, 2); // system + task
  const body = state.context.slice(2);
  if (body.length <= 2) return false;
  const dropped = body.slice(0, body.length - 2);
  const kept = body.slice(body.length - 2);
  const droppedTokens = dropped.reduce((s, e) => s + e.tokens, 0);
  const summary = {
    role: 'summary',
    text: `[compacted ${dropped.length} earlier observations, ~${droppedTokens} tokens]`,
    tokens: tokens(`[compacted ${dropped.length} earlier observations]`),
  };
  state.context = [...pinned, summary, ...kept];
  return dropped.length;
}

export function runAgent(scenario) {
  const budget = { maxSteps: 8, maxContextTokens: 480, ...scenario.budget };
  const world = initWorld(scenario.world);
  const state = {
    task: scenario.task,
    context: [
      { role: 'system', text: 'You are a support-desk agent. Use the tools. Stop when the goal is met.', tokens: 0 },
      { role: 'user', text: scenario.task.instruction, tokens: 0 },
    ],
    observations: [],
    trace: [],
    deniedActions: new Set(),
    tokensUsed: 0,
    step: 0,
  };
  for (const e of state.context) e.tokens = tokens(e.text);

  const push = (event) => state.trace.push({ step: state.step, ...event });

  let status = 'completed';
  let final = null;
  let lastActionKey = null;
  let repeatCount = 0;
  let killReason = null;

  while (true) {
    state.step += 1;

    if (state.step > budget.maxSteps) {
      push({ phase: 'decide', verdict: 'terminate', reason: `step budget exhausted (${budget.maxSteps})` });
      status = 'killed';
      killReason = 'step budget';
      break;
    }

    // ---- REASON -----------------------------------------------------------
    const decision = decideNext(state);
    push({ phase: 'reason', thought: decision.thought });

    if (decision.type === 'final') {
      push({ phase: 'decide', verdict: 'terminate', reason: 'goal complete' });
      status = decision.status ?? 'completed';
      final = decision.text;
      break;
    }

    // ---- ACT --------------------------------------------------------------
    const { tool, args } = decision;
    const def = TOOL_DEFS[tool];
    push({ phase: 'act', tool, args });

    let obs;
    const gate = checkGuardrail(tool, args, scenario);
    if (!gate.allowed) {
      push({ phase: 'guardrail', verdict: gate.kind === 'gate' ? 'gated' : 'blocked', tool, reason: gate.reason });
      obs = { tool, ok: false, denied: true, text: `DENIED: ${gate.reason}` };
      state.deniedActions.add(tool);
    } else {
      const argError = validateArgs(def, args);
      if (argError) {
        obs = { tool, ok: false, text: `ARG ERROR: ${argError}` };
      } else {
        const maxAttempts = Math.max(1, (def.retries ?? 0) + 1);
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
          try {
            const result = callTool(tool, args, world);
            obs = { tool, ok: true, result, text: JSON.stringify(result) };
            break;
          } catch (err) {
            if (err instanceof ToolError && TRANSIENT_CODES.has(err.code) && attempt < maxAttempts) {
              push({ phase: 'retry', tool, attempt: attempt + 1, of: maxAttempts, error: `${err.code}: ${err.message}` });
              continue;
            }
            obs = { tool, ok: false, text: `TOOL ERROR (${err.code ?? 'error'}): ${err.message}` };
            break;
          }
        }
      }
    }

    // ---- OBSERVE ----------------------------------------------------------
    state.observations.push(obs);
    state.context.push({ role: 'observation', text: obs.text, tokens: tokens(obs.text) });
    state.tokensUsed += tokens(obs.text) + tokens(decision.thought);

    let used = contextTokens(state.context);
    if (used > budget.maxContextTokens) {
      const droppedCount = compact(state);
      if (droppedCount) {
        push({
          phase: 'compact',
          dropped: droppedCount,
          contextTokens: contextTokens(state.context),
          reason: `context over budget (${used} > ${budget.maxContextTokens}) — oldest observations compacted`,
        });
      }
    }
    push({ phase: 'observe', tool, ok: obs.ok, denied: !!obs.denied, summary: obs.text.slice(0, 140), contextTokens: contextTokens(state.context) });

    // ---- DECIDE -----------------------------------------------------------
    const actionKey = `${tool}(${JSON.stringify(args)})`;
    repeatCount = actionKey === lastActionKey ? repeatCount + 1 : 0;
    lastActionKey = actionKey;

    if (repeatCount >= 2) {
      push({ phase: 'decide', verdict: 'terminate', reason: `no-progress detector: '${actionKey}' repeated ${repeatCount + 1}x with identical args` });
      status = 'killed';
      killReason = 'no-progress detector';
      break;
    }
    push({ phase: 'decide', verdict: 'continue' });
  }

  return {
    scenario: scenario.id,
    status,
    final,
    killReason,
    steps: state.step > budget.maxSteps ? budget.maxSteps : state.step,
    tokensUsed: state.tokensUsed,
    contextTokens: contextTokens(state.context),
    contextBudget: budget.maxContextTokens,
    trace: state.trace,
    world: { refunds: world.refunds, replies: world.replies, deletions: world.deletions },
  };
}
