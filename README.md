# Agent Loop Lab — companion demo

Interactive lab for the article *10 Concepts That Turn an LLM Demo into a
Production Agent*. It runs an instrumented **Reason → Act → Observe → Decide →
Repeat** loop over a fake support-desk tool set and shows the engineering a
prompt alone never gives you.

Zero dependencies — Node 20+ only. The loop engine, tool set, and reasoner are
plain ES modules shared by the browser UI, the CLI report, and the test suite.

## What a run shows

- **Harness engineering** — `lookup_order` is rate-limited on its first call in
  a run; the harness retries (bounded, transient errors only) and the loop
  recovers without the reasoner ever knowing.
- **Loop engineering** — three coded exits: goal met, step budget (8), and a
  no-progress detector that kills the loop after the same action repeats with
  identical arguments.
- **Context engineering** — every observation lands in the context with an
  estimated token cost; over budget, the oldest observations collapse into a
  summary line.
- **Guardrails** — enforced in code before any tool runs: the task allowlist, a
  permanent deny on `delete_records`, and a human-approval gate on refunds above
  the auto-approve limit.
- **Observability** — every phase of every step lands in a structured trace:
  tool, args, verdict, context size. The tests grade that trace.

## Four scenarios

| Scenario | What happens |
|---|---|
| `refund-ok` | Flaky lookup → harness retry → verbose tool output triggers context compaction → refund issues under the limit → completed. |
| `refund-over-limit` | Same path, but the 45000¢ refund hits the 10000¢ approval gate → agent escalates to a human instead of forcing it through → completed. |
| `delete-everything` | The task says delete; `delete_records` is not on the task allowlist → blocked in code → agent refuses. |
| `ghost-order` | A broken reasoner re-issues the identical lookup for a nonexistent order → the no-progress detector kills the loop at step 3 of 8. |

## Run it

```text
npm start       # serve the lab on :3000
npm test        # loop, guardrails, tools, scenario sync, server
npm run scan    # side-by-side scenario report
npm run check   # both
```

## Layout

- `app/server.js` — zero-dep static host plus `/health` and `/version`.
- `public/agent.mjs` — the loop engine (retries, budgets, compaction, trace).
- `public/tools.mjs` — tool schemas, corrective validation, guardrail policy.
- `public/reasoner.mjs` — the deterministic rule-based stand-in for the model.
- `public/scenarios.mjs` — scenario presets generated from `examples/*.json`
  (sync asserted by `test/scenarios.test.mjs`).
- `examples/` — the four scenario fixtures.
- `test/` — asserts the article's claims: the loop always terminates, the
  guardrail always fires, the retry always recovers.

## Honest limits

- The reasoner is **rule-based and deterministic** — a stand-in that exists to
  demonstrate the engineering *around* a model, not model intelligence.
- Token counts are `length / 4` estimates, not a real tokenizer.
- The guardrail policy is illustrative — allowlist, permanent deny, and one
  approval gate; not a complete permissions model.
- The human-approval gate ends at escalation; no approver UI exists.
- No memory layer, no orchestration — single agent, single run, fresh world.

This is an educational demo, not production infrastructure.
