import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TOOL_DEFS, TRANSIENT_CODES, ToolError,
  checkGuardrail, validateArgs, callTool, initWorld,
} from '../public/tools.mjs';
import { SCENARIOS } from '../public/scenarios.mjs';

const scenario = SCENARIOS.find(s => s.id === 'refund-ok');

test('validateArgs returns corrective errors, not "invalid input"', () => {
  const def = TOOL_DEFS.issue_refund;
  assert.match(validateArgs(def, {}), /missing required argument 'order_id'/);
  assert.match(validateArgs(def, { order_id: 'O-778' }), /missing required argument 'amount_cents'/);
  assert.match(
    validateArgs(def, { order_id: 'O-778', amount_cents: 'fifty dollars' }),
    /must be an integer number of cents/,
  );
  assert.match(
    validateArgs(def, { order_id: 'abc', amount_cents: 100 }),
    /must match.*O-778/,
  );
  assert.equal(validateArgs(def, { order_id: 'O-778', amount_cents: 100 }), null);
});

test('callTool: lookup_order is rate-limited once, then works', () => {
  const world = initWorld(scenario.world);
  assert.throws(() => callTool('lookup_order', { order_id: 'O-778' }, world), (e) => {
    assert.ok(e instanceof ToolError);
    assert.equal(e.code, 'rate_limited');
    assert.ok(TRANSIENT_CODES.has(e.code), 'rate_limited must be retryable');
    return true;
  });
  const order = callTool('lookup_order', { order_id: 'O-778' }, world);
  assert.equal(order.amount_cents, 4200);
});

test('callTool: not_found is permanent — not a transient retry candidate', () => {
  const world = initWorld(scenario.world);
  assert.throws(() => callTool('lookup_order', { order_id: 'O-778' }, world)); // burn the flaky call
  assert.throws(() => callTool('lookup_order', { order_id: 'O-1' }, world), (e) => {
    assert.equal(e.code, 'not_found');
    assert.ok(!TRANSIENT_CODES.has(e.code), 'not_found must not be retried');
    return true;
  });
});

test('checkGuardrail: allowlist, permanent deny, and refund gate', () => {
  // not on the task allowlist
  const blocked = checkGuardrail('delete_records', { scope: 'all' }, scenario);
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.kind, 'allowlist');

  // on the allowlist but permanently denied
  const s2 = { ...scenario, allowedTools: [...scenario.allowedTools, 'delete_records'] };
  const denied = checkGuardrail('delete_records', { scope: 'all' }, s2);
  assert.equal(denied.allowed, false);
  assert.equal(denied.kind, 'deny');

  // over-limit refund gated for human approval
  const gated = checkGuardrail('issue_refund', { order_id: 'O-778', amount_cents: 45000 }, scenario);
  assert.equal(gated.allowed, false);
  assert.equal(gated.kind, 'gate');

  // under-limit refund passes
  assert.equal(checkGuardrail('issue_refund', { order_id: 'O-778', amount_cents: 4200 }, scenario).allowed, true);
  assert.equal(checkGuardrail('send_reply', { customer_id: 'C-1042', text: 'hi' }, scenario).allowed, true);
});

test('issue_refund enforces the order-total ceiling inside the tool', () => {
  const world = initWorld(scenario.world);
  assert.throws(
    () => TOOL_DEFS.issue_refund.run({ order_id: 'O-778', amount_cents: 999999 }, world),
    /exceeds the order total/,
  );
  assert.equal(world.refunds.length, 0);
});
