import test from 'node:test';
import assert from 'node:assert/strict';
import { runAgent } from '../public/agent.mjs';
import { SCENARIOS } from '../public/scenarios.mjs';

const byId = id => SCENARIOS.find(s => s.id === id);
const count = (trace, phase) => trace.filter(e => e.phase === phase).length;

test('every scenario terminates — the loop always has an exit', () => {
  for (const s of SCENARIOS) {
    const r = runAgent(s);
    assert.ok(['completed', 'refused', 'killed'].includes(r.status), `${s.id} returned ${r.status}`);
    assert.ok(r.steps <= 8, `${s.id} exceeded its step budget`);
    const last = r.trace.at(-1);
    assert.equal(last.phase, 'decide');
    assert.equal(last.verdict, 'terminate');
  }
});

test('refund-ok: flaky tool recovered by harness retry, refund issued', () => {
  const r = runAgent(byId('refund-ok'));
  assert.equal(r.status, 'completed');
  assert.equal(count(r.trace, 'retry'), 1, 'expected exactly one harness retry');
  const retry = r.trace.find(e => e.phase === 'retry');
  assert.equal(retry.tool, 'lookup_order');
  assert.match(retry.error, /rate_limited/);
  assert.deepEqual(r.world.refunds, [{ order_id: 'O-778', amount_cents: 4200 }]);
  assert.equal(r.world.replies.length, 1);
});

test('refund-over-limit: approval gate blocks the write, agent escalates', () => {
  const r = runAgent(byId('refund-over-limit'));
  assert.equal(r.status, 'completed');
  const gate = r.trace.find(e => e.phase === 'guardrail');
  assert.equal(gate.verdict, 'gated');
  assert.equal(gate.tool, 'issue_refund');
  assert.match(gate.reason, /auto-approve limit/);
  assert.equal(r.world.refunds.length, 0, 'gated refund must never execute');
  assert.match(r.world.replies[0].text, /human approver/);
});

test('delete-everything: allowlist blocks delete_records before it runs', () => {
  const r = runAgent(byId('delete-everything'));
  assert.equal(r.status, 'refused');
  const block = r.trace.find(e => e.phase === 'guardrail');
  assert.equal(block.verdict, 'blocked');
  assert.equal(block.tool, 'delete_records');
  assert.match(block.reason, /allowlist/);
  assert.equal(r.world.deletions.length, 0, 'a blocked tool must have zero side effects');
});

test('ghost-order: no-progress detector kills the stuck loop', () => {
  const r = runAgent(byId('ghost-order'));
  assert.equal(r.status, 'killed');
  assert.equal(r.killReason, 'no-progress detector');
  assert.ok(r.steps < 8, 'no-progress should kill long before the step budget');
  const kill = r.trace.at(-1);
  assert.match(kill.reason, /repeated 3x with identical args/);
});

test('context budget: refund run compacts and ends under budget', () => {
  const r = runAgent(byId('refund-ok'));
  const compactIdx = r.trace.findIndex(e => e.phase === 'compact');
  assert.ok(compactIdx >= 0, 'expected a compaction event');
  assert.match(r.trace[compactIdx].reason, /context over budget/);
  // something must have exceeded budget to trigger it, and after compaction
  // every observed context size is back under budget
  const before = r.trace.slice(0, compactIdx).filter(t => t.phase === 'observe');
  assert.ok(before.some(e => e.contextTokens > r.contextBudget), 'compaction without an over-budget moment proves nothing');
  const after = r.trace.slice(compactIdx).filter(t => t.phase === 'observe');
  for (const e of after) {
    assert.ok(e.contextTokens <= r.contextBudget, `step ${e.step} context ${e.contextTokens} still over budget after compaction`);
  }
  assert.ok(r.contextTokens <= r.contextBudget, `context ${r.contextTokens} over budget ${r.contextBudget}`);
});

test('a run with no allowed tools still terminates', () => {
  const s = structuredClone(byId('refund-ok'));
  s.allowedTools = [];
  const r = runAgent(s);
  assert.ok(['completed', 'refused', 'killed'].includes(r.status));
  assert.ok(r.steps <= 8);
});
