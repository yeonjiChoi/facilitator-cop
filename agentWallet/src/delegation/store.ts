import { randomUUID } from "node:crypto";
import type { DelegationPolicy, Network } from "x402-contracts";

interface SpendRecord {
  timestamp: number;
  amount: bigint;
}

interface StoredPolicy {
  id: string;
  policy: DelegationPolicy;
  spends: SpendRecord[];
}

const policies = new Map<string, StoredPolicy>();

export function createDelegation(policy: DelegationPolicy): { id: string } {
  const id = randomUUID();
  policies.set(id, { id, policy, spends: [] });
  return { id };
}

export function revokeDelegation(id: string): boolean {
  return policies.delete(id);
}

// Oldest first (Map keeps insertion order).
function activePoliciesForAgent(agentId: string): StoredPolicy[] {
  const now = Math.floor(Date.now() / 1000);
  return [...policies.values()].filter(
    (stored) => stored.policy.agentId === agentId && stored.policy.expiresAt > now,
  );
}

function matchesResource(pattern: string, resource: string): boolean {
  if (pattern.endsWith("*")) {
    return resource.startsWith(pattern.slice(0, -1));
  }
  return pattern === resource;
}

export interface AuthorizationCheck {
  ok: boolean;
  reason?: string;
  policyId?: string;
  /** Already spent in the current window, before this payment. Set when ok. */
  spentInWindow?: bigint;
  policy?: DelegationPolicy;
}

// An agent can hold several delegations at once (e.g. a standing policy plus a one-off approval
// for a single payment). A payment is allowed if any one of them covers it; when none does, the
// reason reported is the oldest policy's.
export function authorize(
  agentId: string,
  resource: string,
  chain: Network,
  amount: bigint,
): AuthorizationCheck {
  const candidates = activePoliciesForAgent(agentId);
  if (candidates.length === 0) {
    return { ok: false, reason: "no active delegation policy for agent" };
  }
  let firstFailure: AuthorizationCheck | undefined;
  for (const stored of candidates) {
    const result = checkPolicy(stored, resource, chain, amount);
    if (result.ok) return result;
    firstFailure ??= result;
  }
  return firstFailure!;
}

function checkPolicy(
  stored: StoredPolicy,
  resource: string,
  chain: Network,
  amount: bigint,
): AuthorizationCheck {
  const { policy } = stored;

  if (!policy.allowedResources.some((pattern) => matchesResource(pattern, resource))) {
    return { ok: false, reason: `resource ${resource} not allowed by delegation policy` };
  }
  if (!policy.allowedChains.includes(chain)) {
    return { ok: false, reason: `chain ${chain} not allowed by delegation policy` };
  }
  if (amount > BigInt(policy.maxAmountPerTx)) {
    return { ok: false, reason: "amount exceeds maxAmountPerTx" };
  }

  const now = Math.floor(Date.now() / 1000);
  const windowStart = now - policy.windowSeconds;
  stored.spends = stored.spends.filter((s) => s.timestamp >= windowStart);
  const spentInWindow = stored.spends.reduce((sum, s) => sum + s.amount, 0n);
  if (spentInWindow + amount > BigInt(policy.maxAmountPerWindow)) {
    return { ok: false, reason: "amount exceeds maxAmountPerWindow" };
  }

  return { ok: true, policyId: stored.id, spentInWindow, policy };
}

// Call only after signing actually succeeds, so a failed sign doesn't burn window budget.
export function commitSpend(policyId: string, amount: bigint): void {
  const stored = policies.get(policyId);
  if (!stored) return;
  stored.spends.push({ timestamp: Math.floor(Date.now() / 1000), amount });
}
