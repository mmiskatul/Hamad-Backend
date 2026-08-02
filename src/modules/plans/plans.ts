export const PLANS = ['free', 'pro', 'business'] as const;
export type Plan = (typeof PLANS)[number];

export type UsageLimits = {
  requests: number;
  tokens: number;
};

export const PLAN_LIMITS: Record<Plan, UsageLimits> = {
  free: { requests: 50, tokens: 1_000 },
  pro: { requests: 500, tokens: 4_000 },
  business: { requests: 5_000, tokens: 8_000 },
};

export function resolvePlan(plan: string | undefined): Plan {
  return plan === 'pro' || plan === 'business' ? plan : 'free';
}
