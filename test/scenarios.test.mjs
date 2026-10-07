import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { SCENARIOS } from '../public/scenarios.mjs';

const EXAMPLES = fileURLToPath(new URL('../examples', import.meta.url));

test('public/scenarios.mjs stays in sync with examples/*.json', () => {
  const files = readdirSync(EXAMPLES).filter(f => f.endsWith('.json')).sort();
  const onDisk = files.map(f => JSON.parse(readFileSync(join(EXAMPLES, f), 'utf8')));
  assert.deepEqual(SCENARIOS, onDisk, 'scenarios.mjs is generated from examples/*.json — regenerate it after editing fixtures');
});

test('every scenario declares a budget and an allowlist', () => {
  for (const s of SCENARIOS) {
    assert.ok(s.budget?.maxSteps > 0, `${s.id} needs a step budget`);
    assert.ok(s.budget?.maxContextTokens > 0, `${s.id} needs a context budget`);
    assert.ok(Array.isArray(s.allowedTools) && s.allowedTools.length > 0, `${s.id} needs a tool allowlist`);
    assert.ok(!s.allowedTools.includes('delete_records'), `${s.id} must never allowlist a destructive tool`);
  }
});
