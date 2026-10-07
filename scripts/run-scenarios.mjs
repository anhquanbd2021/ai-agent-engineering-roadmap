// Side-by-side report: run every scenario through the agent loop.
import { runAgent } from '../public/agent.mjs';
import { SCENARIOS } from '../public/scenarios.mjs';

const count = (trace, phase) => trace.filter(e => e.phase === phase).length;

console.log('Agent Loop Lab — scenario report\n');
console.log(
  `${'scenario'.padEnd(20)}${'status'.padEnd(11)}${'steps'.padEnd(7)}` +
  `${'retries'.padEnd(9)}${'guardrail'.padEnd(11)}${'compact'.padEnd(9)}ctx (est.)`,
);
for (const s of SCENARIOS) {
  const r = runAgent(s);
  console.log(
    `${s.id.padEnd(20)}${r.status.padEnd(11)}${String(r.steps).padEnd(7)}` +
    `${String(count(r.trace, 'retry')).padEnd(9)}${String(count(r.trace, 'guardrail')).padEnd(11)}` +
    `${String(count(r.trace, 'compact')).padEnd(9)}${r.contextTokens}/${r.contextBudget}`,
  );
}

console.log('\nKey events per run');
for (const s of SCENARIOS) {
  const r = runAgent(s);
  const key = r.trace.filter(e => ['guardrail', 'retry', 'compact'].includes(e.phase)
    || (e.phase === 'decide' && e.verdict === 'terminate'));
  console.log(`\n${s.id} → ${r.status}${r.killReason ? ` (${r.killReason})` : ''}`);
  for (const e of key) {
    console.log(`  step ${e.step} ${e.phase}: ${e.reason ?? `${e.error} → retry ${e.attempt}/${e.of}`}`);
  }
  if (r.world.refunds.length) console.log(`  world: refunds issued → ${JSON.stringify(r.world.refunds)}`);
  if (r.world.replies.length) console.log(`  world: replies sent → ${r.world.replies.length}`);
  if (r.world.deletions.length) console.log(`  world: DELETIONS → ${JSON.stringify(r.world.deletions)}`);
}
