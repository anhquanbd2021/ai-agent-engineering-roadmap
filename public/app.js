import { runAgent } from '/agent.mjs';
import { SCENARIOS } from '/scenarios.mjs';

const $ = id => document.getElementById(id);

for (const s of SCENARIOS) {
  const option = document.createElement('option');
  option.value = s.id;
  option.textContent = `${s.id} — ${s.title}`;
  $('preset').append(option);
}

const requested = new URLSearchParams(location.search).get('scenario');
if (SCENARIOS.some(s => s.id === requested)) $('preset').value = requested;

function current() {
  return SCENARIOS.find(s => s.id === $('preset').value);
}

const PHASE_LABEL = {
  reason: 'Reason', act: 'Act', observe: 'Observe', decide: 'Decide',
  guardrail: 'Guardrail', retry: 'Retry', compact: 'Context',
};

function eventText(e) {
  switch (e.phase) {
    case 'reason': return e.thought;
    case 'act': return `${e.tool}(${JSON.stringify(e.args)})`;
    case 'observe': return `${e.ok ? 'result' : e.denied ? 'denied' : 'error'} — ${e.summary} · context ${e.contextTokens} tok`;
    case 'decide': return e.verdict === 'continue' ? 'continue the loop' : `terminate: ${e.reason}`;
    case 'guardrail': return `${e.verdict.toUpperCase()} — ${e.reason}`;
    case 'retry': return `harness retry ${e.attempt}/${e.of} on ${e.tool} after ${e.error}`;
    case 'compact': return e.reason;
    default: return '';
  }
}

function paintTrace(trace) {
  $('trace').replaceChildren(...trace.map(e => {
    const li = document.createElement('li');
    li.className = `event ${e.phase}`;
    const head = document.createElement('div');
    const step = document.createElement('span');
    step.className = 'step';
    step.textContent = `#${e.step}`;
    const phase = document.createElement('span');
    phase.className = 'phase';
    phase.textContent = PHASE_LABEL[e.phase] ?? e.phase;
    head.append(step, phase);
    const p = document.createElement('p');
    p.textContent = eventText(e);
    li.append(head, p);
    return li;
  }));
}

function paintStats(run) {
  const retries = run.trace.filter(e => e.phase === 'retry').length;
  const guardrails = run.trace.filter(e => e.phase === 'guardrail').length;
  const compacts = run.trace.filter(e => e.phase === 'compact').length;
  $('stat-steps').textContent = run.steps;
  $('stat-retries').textContent = retries;
  $('stat-guardrails').textContent = guardrails;
  $('stat-compacts').textContent = compacts;

  const verdict = $('verdict');
  verdict.textContent = run.status.toUpperCase() + (run.killReason ? ` · ${run.killReason}` : '');
  verdict.className = `badge ${run.status}`;

  const pct = Math.min(100, Math.round(100 * run.contextTokens / run.contextBudget));
  const fill = $('meter-fill');
  fill.style.width = `${pct}%`;
  fill.className = pct > 80 ? 'hot' : '';
  $('meter-label').textContent = `${run.contextTokens} / ${run.contextBudget} est. tokens`;

  $('final').textContent = run.final ? `Final: ${run.final}` : '';
}

function run() {
  const scenario = current();
  $('blurb').textContent = scenario.blurb;
  const run_ = runAgent(scenario);
  paintStats(run_);
  paintTrace(run_.trace);
}

$('preset').addEventListener('change', () => {
  history.replaceState(null, '', `/?scenario=${$('preset').value}`);
  run();
});
$('run').addEventListener('click', run);

run();
