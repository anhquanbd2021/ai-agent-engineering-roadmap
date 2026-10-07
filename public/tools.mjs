// Fake support-desk tool set — schemas, validation, guardrail policy.
// Educational fixtures only: no real orders, customers, or payments.

export class ToolError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// Only transient failures deserve a retry — retrying a 'not_found' just burns
// the retry budget to get the same answer.
export const TRANSIENT_CODES = new Set(['rate_limited', 'timeout']);

// Each tool: kind (read/write/execute), a strict arg schema, a retry budget the
// harness may spend, and a run() that mutates the fake world on success.
export const TOOL_DEFS = {
  lookup_order: {
    kind: 'read',
    description: "Fetch an order record by id. Args: order_id like 'O-778'.",
    schema: { order_id: { type: 'string', pattern: /^O-\d+$/ } },
    retries: 2,
    run(args, world) {
      const order = world.orders[args.order_id];
      if (!order) {
        throw new ToolError(
          'not_found',
          `no order '${args.order_id}' — check the id format (O-<digits>) and that the order exists`,
        );
      }
      // The audit trail is deliberately verbose — it is what bloats the context.
      return { ...order, audit_log: world.auditLog };
    },
  },

  check_refund_policy: {
    kind: 'read',
    description: 'Return the refund policy text and eligibility rules. No args.',
    schema: {},
    retries: 1,
    run(_args, world) {
      return {
        policy_text: world.policy.text,
        auto_approve_limit_cents: world.policy.autoApproveLimitCents,
      };
    },
  },

  issue_refund: {
    kind: 'write',
    description: 'Issue a refund. Args: order_id like \'O-778\', amount_cents (integer).',
    schema: {
      order_id: { type: 'string', pattern: /^O-\d+$/ },
      amount_cents: { type: 'integer' },
    },
    retries: 1,
    run(args, world) {
      const order = world.orders[args.order_id];
      if (!order) throw new ToolError('not_found', `no order '${args.order_id}'`);
      if (args.amount_cents > order.amount_cents) {
        throw new ToolError(
          'invalid',
          `amount_cents ${args.amount_cents} exceeds the order total ${order.amount_cents} — refund at most the order amount`,
        );
      }
      world.refunds.push({ order_id: args.order_id, amount_cents: args.amount_cents });
      return { refunded_cents: args.amount_cents, order_id: args.order_id };
    },
  },

  send_reply: {
    kind: 'write',
    description: "Send a message to a customer. Args: customer_id like 'C-1042', text (string).",
    schema: {
      customer_id: { type: 'string', pattern: /^C-\d+$/ },
      text: { type: 'string' },
    },
    retries: 1,
    run(args, world) {
      world.replies.push({ customer_id: args.customer_id, text: args.text });
      return { sent: true, chars: args.text.length };
    },
  },

  delete_records: {
    kind: 'execute',
    description: 'Delete records by scope. Args: scope (string). DESTRUCTIVE.',
    schema: { scope: { type: 'string' } },
    retries: 0,
    run(args, world) {
      world.deletions.push(args.scope);
      return { deleted: args.scope };
    },
  },
};

// Corrective validation — the error must tell the caller how to fix the call,
// the way a good tool contract teaches the model instead of stonewalling it.
export function validateArgs(def, args) {
  for (const [key, rule] of Object.entries(def.schema)) {
    const value = args?.[key];
    if (value === undefined) return `missing required argument '${key}' (${rule.type})`;
    if (rule.type === 'string' && typeof value !== 'string') {
      return `'${key}' must be a string; received ${JSON.stringify(value)}`;
    }
    if (rule.type === 'integer' && !Number.isInteger(value)) {
      return `'${key}' must be an integer number of cents; received ${JSON.stringify(value)}`;
    }
    if (rule.pattern && !rule.pattern.test(value)) {
      const hint = key === 'order_id' ? "e.g. 'O-778'" : "e.g. 'C-1042'";
      return `'${key}' must match ${rule.pattern} (${hint}); received '${value}'`;
    }
  }
  return null;
}

// Guardrail policy — enforced in code, before the tool ever runs. Three rules:
// task allowlist, a permanent deny on destructive tools, and an approval gate
// on refunds above the auto-approve limit.
export function checkGuardrail(name, args, scenario) {
  const def = TOOL_DEFS[name];
  if (!def) return { allowed: false, kind: 'deny', reason: `unknown tool '${name}'` };
  if (!scenario.allowedTools.includes(name)) {
    return {
      allowed: false,
      kind: 'allowlist',
      reason: `'${name}' is not on this task's tool allowlist`,
    };
  }
  if (name === 'delete_records') {
    return {
      allowed: false,
      kind: 'deny',
      reason: 'destructive tool — permanently denied for this agent',
    };
  }
  if (
    name === 'issue_refund' &&
    Number.isInteger(args?.amount_cents) &&
    args.amount_cents > scenario.world.policy.autoApproveLimitCents
  ) {
    return {
      allowed: false,
      kind: 'gate',
      reason:
        `refund of ${args.amount_cents}c exceeds the ` +
        `${scenario.world.policy.autoApproveLimitCents}c auto-approve limit — routed to a human approver`,
    };
  }
  return { allowed: true };
}

// Fresh mutable world per run. _attempts feeds the flaky-tool simulation:
// the first lookup_order attempt in a run is rate-limited so the harness
// retry path is exercised whenever the tool is called.
export function initWorld(worldSpec) {
  const world = JSON.parse(JSON.stringify(worldSpec));
  world.refunds = [];
  world.replies = [];
  world.deletions = [];
  world._attempts = {};
  return world;
}

export function callTool(name, args, world) {
  world._attempts[name] = (world._attempts[name] ?? 0) + 1;
  if (name === 'lookup_order' && world._attempts[name] === 1) {
    throw new ToolError('rate_limited', '429 Too Many Requests — retry after backoff');
  }
  return TOOL_DEFS[name].run(args, world);
}
