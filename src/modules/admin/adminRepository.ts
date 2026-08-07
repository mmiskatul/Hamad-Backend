/**
 * Persistence-layer contract for the admin dashboard.
 *
 * The previous implementation kept all data in process memory. This interface
 * lets us swap in a MongoDB-backed store for production (mutations survive a
 * restart) while keeping the in-memory store available for tests and dev.
 *
 * Every method mirrors a public method on the legacy `AdminDashboardStore`
 * class so the route layer never needs to know which implementation is wired.
 */

export type AdminDashboardActor = string;

export type AdminOverviewStats = {
  health: 'healthy' | 'degraded' | 'outage';
  providersUp: number;
  providersTotal: number;
  mrr: number;
  mrrDelta: number;
  spend30d: number;
  spendMargin: number;
  spendDelta: number;
  activeUsers: number;
  activeUsersDelta: number;
  newUsers: number;
  sparklines: { mrr: number[]; spend: number[]; active: number[] };
  costByModel: { modelId: string; cost: number; tokens: number }[];
};

export type AdminUserSummary = {
  id: string;
  email: string;
  mobile?: string;
  name: string;
  tier: 'free' | 'pro' | 'business';
  status: 'active' | 'suspended' | 'grace';
  requestsUsed: number;
  requestsLimit: number;
  tokensSpent: number;
  costUsd: number;
  lastActiveAt: string;
  signupDate: string;
  platform: 'ios' | 'android' | 'web';
};

export type AdminUserDetail = AdminUserSummary & {
  avatarUrl: string;
  signupSource: 'ios' | 'android' | 'web';
  paymentHistory: { date: string; amountUsd: number; plan: string; period: string; status: string }[];
  quotaHistory: (Record<string, unknown> & { date?: string; amount?: number; by?: string; reason?: string })[];
  renewals: { plan: string; period: string; amountUsd: number; nextBillingAt: string }[];
  modelDistribution: Record<string, number>;
  ticketIds: string[];
  memory?: { count: number; bytesUsed: number; lastUpdatedAt: string; topCategories: string[] };
  actionTimeline?: { ts: string; actor: string; action: string; summary: string }[];
};

export type AdminProviderHealth = {
  id: string;
  name: string;
  modelId: string;
  status: 'operational' | 'degraded' | 'outage' | 'disabled';
  p50Ms: number;
  p95Ms: number;
  errorRate: number;
  uptime: number;
  circuit: 'closed' | 'half-open' | 'open';
  sparkline: number[];
};

export type AdminTicket = {
  id: string;
  userId: string;
  userEmail: string;
  subject: string;
  status: 'open' | 'pending' | 'resolved';
  priority: 'low' | 'normal' | 'high';
  assignedTo: string | null;
  createdAt: string;
  updatedAt: string;
  hasAttachment: boolean;
  attachmentExpiresAt: string | null;
  replies: AdminSupportReply[];
};

export type AdminTicketDetail = AdminTicket & {
  description: string;
  timeline: { id: string; at: string; actor: string; note: string }[];
};

export type AdminSupportReply = {
  id: string;
  author: string;
  role: 'admin' | 'user';
  message: string;
  createdAt: string;
};

export type AdminModelConfig = {
  id: string;
  label: string;
  enabled: boolean;
  includedInTiers: ('free' | 'pro' | 'business')[];
  affectedUsers: number;
};

export type AdminTierConfig = {
  id: 'free' | 'pro' | 'business';
  name: string;
  monthlyUsd: number;
  requestsLimit: number;
  tokensLimit: number;
  models: string[];
  features: { fileUpload: boolean; voice: boolean; priority: boolean };
};

export type AdminAuditEntry = {
  id: string;
  at: string;
  actor: string;
  action: string;
  target: string;
  reason: string;
  ip: string;
  meta?: Record<string, unknown>;
};

export type AdminAccount = {
  id: string;
  name: string;
  email: string;
  avatarUrl: string;
  lastSignInAt: string;
  totpEnabled: boolean;
  twoFactor: { email: string | null; verified: boolean };
  sessions: { id: string; device: string; location: string; ip: string; lastActiveAt: string; current: boolean }[];
};

export type AdminProfile = {
  id: string;
  name: string;
  email: string;
  avatarUrl: string;
  lastSignInAt: string;
};

export type AdminUsageVisibility = {
  enabled: boolean;
  updatedAt: string;
  updatedBy: string;
};

export type AdminLegalDoc = {
  currentVersionId: string;
  versions: { id: string; bodyMarkdown: string; createdAt: string; createdBy: string; summary: string }[];
};

export type AdminUnitConfig = {
  size: number;
  priceUsd: number;
  enabled: boolean;
  updatedAt: string;
  updatedBy: string;
};

export type AdminUnitPricingConfig = {
  requestUnit: AdminUnitConfig;
  tokenUnit: AdminUnitConfig;
  history: { ts: string; actor: string; unit: 'request' | 'token'; before: { size: number; priceUsd: number }; after: { size: number; priceUsd: number }; reason: string }[];
};

export type AdminRevenueData = {
  mrrSeries: { month: string; mrr: number }[];
  tierMix: { tier: 'free' | 'pro' | 'business'; users: number; revenue: number }[];
  churn: { month: string; churn: number; newMrr: number }[];
  arpu: number;
  arr: number;
  churnRate: number;
  funnel: { stage: string; value: number }[];
};

export type AdminUsageData = {
  tokensByModel: { date: string; series: Record<string, number> }[];
  costByModel: { modelId: string; cost: number; tokens: number }[];
  topUsers: { userId: string; email: string; spend: number; tokens: number }[];
};

export type AdminQuotaHistoryEntry = {
  date: string;
  amount: number;
  by: string;
  reason: string;
  newTotal?: number;
};

export type AdminQuotaOverride = {
  bypassQuota: boolean;
  customRequestsLimit?: number;
  customTokensLimit?: number;
  reason: string;
  setBy: string;
  setAt: string;
};

export interface AdminDashboardRepository {
  // Read methods
  overview(): Promise<AdminOverviewStats>;
  users(): Promise<AdminUserSummary[]>;
  userDetail(id: string): Promise<AdminUserDetail>;
  revenue(): Promise<AdminRevenueData>;
  usage(): Promise<AdminUsageData>;
  providers(): Promise<AdminProviderHealth[]>;
  tickets(): Promise<AdminTicket[]>;
  ticketDetail(id: string): Promise<AdminTicketDetail>;
  ticketReplies(id: string): Promise<AdminSupportReply[]>;
  configModels(): Promise<AdminModelConfig[]>;
  configTiers(): Promise<AdminTierConfig[]>;
  planDefaults(): Promise<AdminTierConfig[]>;
  audit(): Promise<AdminAuditEntry[]>;
  account(): Promise<AdminAccount>;
  usageVisibility(): Promise<AdminUsageVisibility>;
  legalDoc(docType: 'terms' | 'privacy'): Promise<AdminLegalDoc>;
  adminProfile(): Promise<AdminProfile>;
  totpSecret(): Promise<{ secret: string; otpauth: string }>;
  unitPricing(): Promise<AdminUnitPricingConfig>;

  // Mutations
  updateAdminProfile(input: { name: string; actor?: string; reason?: string }): Promise<AdminProfile>;
  setProviderStatus(
    providerId: string,
    status: 'operational' | 'degraded' | 'outage' | 'disabled',
    actor: AdminDashboardActor,
    reason: string,
  ): Promise<AdminProviderHealth>;
  createUser(
    input: { name: string; email: string; tier: 'free' | 'pro' | 'business'; status: 'active' | 'suspended' | 'grace' },
    actor: AdminDashboardActor,
  ): Promise<AdminUserSummary>;
  setUserStatus(
    userId: string,
    status: 'active' | 'suspended' | 'grace',
    actor: AdminDashboardActor,
    reason: string,
  ): Promise<AdminUserSummary>;
  grantQuota(
    userId: string,
    amount: number,
    actor: AdminDashboardActor,
    reason: string,
  ): Promise<{ user: AdminUserSummary; entry: AdminQuotaHistoryEntry }>;
  setQuotaOverride(
    userId: string,
    override: Omit<AdminQuotaOverride, 'setAt'>,
    actor: AdminDashboardActor,
  ): Promise<{ user: AdminUserSummary; override: AdminQuotaOverride }>;
  resetQuotaOverride(userId: string, actor: AdminDashboardActor, reason: string): Promise<AdminUserSummary>;
  appendAudit(entry: Omit<AdminAuditEntry, 'id' | 'at'>): Promise<AdminAuditEntry>;
  postReply(ticketId: string, body: string, actor: AdminDashboardActor): Promise<AdminSupportReply>;
  closeTicket(ticketId: string, actor: AdminDashboardActor, reason: string): Promise<AdminTicket>;
  updateConfigTiers(next: AdminTierConfig[], actor: AdminDashboardActor, reason: string): Promise<AdminTierConfig[]>;
  updateConfigModels(next: AdminModelConfig[], actor: AdminDashboardActor, reason: string): Promise<AdminModelConfig[]>;
  saveLegalVersion(
    docType: 'terms' | 'privacy',
    payload: { body: string; summary: string; createdBy: string; reason: string },
  ): Promise<AdminLegalDoc>;
  restoreLegalVersion(
    docType: 'terms' | 'privacy',
    versionId: string,
    actor: AdminDashboardActor,
    reason: string,
  ): Promise<AdminLegalDoc>;
  deleteLegalVersion(
    docType: 'terms' | 'privacy',
    versionId: string,
    actor: AdminDashboardActor,
    reason: string,
  ): Promise<AdminLegalDoc>;
  setUsageVisibility(next: AdminUsageVisibility, actor: AdminDashboardActor): Promise<AdminUsageVisibility>;
  updateUnitPricing(
    payload: {
      requestUnit?: { size: number; priceUsd: number; enabled: boolean };
      tokenUnit?: { size: number; priceUsd: number; enabled: boolean };
      reason: string;
    },
    actor: AdminDashboardActor,
  ): Promise<AdminUnitPricingConfig>;
  setTotpEnabled(enabled: boolean, actor: AdminDashboardActor): Promise<AdminAccount>;
  sendTwoFactorCode(payload: { email: string }, actor: AdminDashboardActor): Promise<{ ok: true }>;
  verifyTwoFactorCode(
    payload: { email: string; code: string },
    actor: AdminDashboardActor,
  ): Promise<{ ok: boolean; reason?: string }>;
  setTwoFactorEmail(payload: { email: string }, actor: AdminDashboardActor): Promise<AdminAccount>;
  disableTwoFactor(actor: AdminDashboardActor): Promise<AdminAccount>;
  revokeSession(sessionId: string, actor: AdminDashboardActor): Promise<AdminAccount>;
  revokeAllOtherSessions(actor: AdminDashboardActor): Promise<number>;

  /** Wipe in-memory state. Mongo repos treat this as a no-op. */
  reset(): Promise<void>;
}

/** Thrown when the Mongo backend is unreachable or not seeded yet. */
export class AdminStorageUnavailableError extends Error {
  readonly code = 'ADMIN_STORAGE_UNAVAILABLE' as const;
  constructor(message = 'Admin dashboard storage is unavailable.') {
    super(message);
    this.name = 'AdminStorageUnavailableError';
  }
}
