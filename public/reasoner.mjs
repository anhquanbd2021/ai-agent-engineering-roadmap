// The "model" — a deterministic, rule-based reasoner standing in for an LLM.
// It reads the observation history and picks the next action. This is the
// honest stand-in the README warns about: it demonstrates the engineering
// around the model, not model intelligence.

function lastObs(state, tool) {
  for (let i = state.observations.length - 1; i >= 0; i--) {
    if (state.observations[i].tool === tool) return state.observations[i];
  }
  return null;
}

function okObs(state, tool) {
  const obs = lastObs(state, tool);
  return obs && obs.ok ? obs : null;
}

function deniedObs(state, tool) {
  const obs = lastObs(state, tool);
  return obs && obs.denied ? obs : null;
}

function refundFlow(state) {
  const { task } = state;

  const orderObs = okObs(state, 'lookup_order');
  if (!orderObs) {
    const failed = lastObs(state, 'lookup_order');
    if (failed && !failed.ok) {
      return {
        type: 'final',
        status: 'completed',
        thought: 'lookup keeps failing — I cannot verify the order, so I should stop and escalate',
        text: `Could not locate order ${task.order_id}; escalating to a human agent.`,
      };
    }
    return {
      type: 'action',
      tool: 'lookup_order',
      args: { order_id: task.order_id },
      thought: 'first I need the order record',
    };
  }

  const policyObs = okObs(state, 'check_refund_policy');
  if (!policyObs) {
    return {
      type: 'action',
      tool: 'check_refund_policy',
      args: {},
      thought: 'order found — now check whether policy allows a refund',
    };
  }

  const order = orderObs.result;
  const replyObs = okObs(state, 'send_reply');

  if (order.status !== 'delivered') {
    if (!replyObs) {
      return {
        type: 'action',
        tool: 'send_reply',
        args: {
          customer_id: task.customer_id,
          text: `Order ${task.order_id} is not delivered yet, so it is not refundable under policy.`,
        },
        thought: 'order not delivered — refund is not eligible, explain that to the customer',
      };
    }
    return {
      type: 'final',
      status: 'completed',
      thought: 'customer informed — task done',
      text: 'Refund declined per policy; customer informed.',
    };
  }

  const refundObs = okObs(state, 'issue_refund');
  const gated = deniedObs(state, 'issue_refund');

  if (!refundObs && !gated) {
    return {
      type: 'action',
      tool: 'issue_refund',
      args: { order_id: task.order_id, amount_cents: order.amount_cents },
      thought: `order is eligible — issue the full refund of ${order.amount_cents}c`,
    };
  }

  if (gated && !replyObs) {
    return {
      type: 'action',
      tool: 'send_reply',
      args: {
        customer_id: task.customer_id,
        text: `Your refund for ${task.order_id} needs a human approver — I have escalated it.`,
      },
      thought: 'refund was gated above the auto-approve limit — escalate instead of retrying',
    };
  }

  if (refundObs && !replyObs) {
    return {
      type: 'action',
      tool: 'send_reply',
      args: {
        customer_id: task.customer_id,
        text: `Done — ${refundObs.result.refunded_cents}c refunded to your original payment method.`,
      },
      thought: 'refund issued — confirm to the customer',
    };
  }

  return {
    type: 'final',
    status: 'completed',
    thought: 'refund handled and customer informed — goal met',
    text: refundObs
      ? `Refunded ${refundObs.result.refunded_cents}c on ${task.order_id}.`
      : `Refund for ${task.order_id} escalated for human approval.`,
  };
}

function destructiveFlow(state) {
  const { task } = state;
  if (!deniedObs(state, 'delete_records')) {
    return {
      type: 'action',
      tool: 'delete_records',
      args: { scope: task.scope ?? 'all' },
      thought: 'the instruction says delete — I will call the delete tool',
    };
  }
  return {
    type: 'final',
    status: 'refused',
    thought: 'the guardrail denied it — the instruction conflicts with policy, so I refuse',
    text: 'Refused: this task asks for a destructive action the agent is not permitted to take.',
  };
}

function stubbornFlow(state) {
  // An intentionally broken reasoner: it never reads the "not found" answer and
  // keeps re-issuing the identical call. Exists so the no-progress detector in
  // the loop engine has something to catch.
  return {
    type: 'action',
    tool: 'lookup_order',
    args: { order_id: state.task.order_id },
    thought: 'still looking — maybe it will work this time',
  };
}

export function decideNext(state) {
  switch (state.task.kind) {
    case 'refund':
      return refundFlow(state);
    case 'destructive':
      return destructiveFlow(state);
    case 'stubborn-lookup':
      return stubbornFlow(state);
    default:
      return {
        type: 'final',
        status: 'completed',
        thought: `unknown task kind '${state.task.kind}'`,
        text: 'Nothing to do.',
      };
  }
}
