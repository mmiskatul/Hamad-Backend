export const PLANS = ['free', 'pro', 'business'] as const;
export type Plan = (typeof PLANS)[number];

export type UsageLimits = {
  requests: number;
  tokens: number;
};

export const PLAN_LIMITS: Record<Plan, UsageLimits> = {
  free: { requests: 50, tokens: 50_000 },
  pro: { requests: 500, tokens: 500_000 },
  business: { requests: 2_000, tokens: 1_500_000 },
};

const PLAN_RANK: Record<Plan, number> = { free: 0, pro: 1, business: 2 };

export function planIncludes(plan: Plan, required: Plan): boolean {
  return PLAN_RANK[plan] >= PLAN_RANK[required];
}

export function resolvePlan(plan: string | undefined): Plan {
  return plan === 'pro' || plan === 'business' ? plan : 'free';
}
