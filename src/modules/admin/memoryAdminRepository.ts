/**
 * In-memory implementation of AdminDashboardRepository. Used by tests and as
 * the dev fallback when Mongo is not configured. The data layout matches the
 * JSON fixtures under backend/src/data/, so seeded content is identical to
 * what Mongo sees after first boot.
 */

import { randomBytes } from 'node:crypto';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  AdminAccount,
  AdminAuditEntry,
  AdminDashboardActor,
  AdminDashboardRepository,
  AdminLegalDoc,
  AdminModelConfig,
  AdminOverviewStats,
  AdminProviderHealth,
  AdminQuotaHistoryEntry,
  AdminQuotaOverride,
  AdminRevenueData,
  AdminSupportReply,
  AdminTicket,
  AdminTicketDetail,
  AdminTierConfig,
  AdminUnitPricingConfig,
  AdminUsageData,
  AdminUsageVisibility,
  AdminUserDetail,
  AdminUserSummary,
} from './adminRepository.js';

const TWO_FACTOR_TTL_MS = 10 * 60 * 1000;
const TWO_FACTOR_MAX_ATTEMPTS = 5;
const DEFAULT_ACTOR = 'admin@oneai.app';
const SINGLETON_ID = 'singleton';

function clone<T>(value: T): T {
  return structuredClone(value);
}

function hash(input: string): number {
  let h = 0x811c9dc5;
  for (const ch of input) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function generateTotpSecret(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const bytes = randomBytes(32);
  let secret = '';
  for (let i = 0; i < 32; i += 1) secret += alphabet[bytes[i]! % alphabet.length];
  return secret;
}

async function fileExists(dir: string): Promise<boolean> {
  try {
    await access(dir);
    return true;
  } catch {
    return false;
  }
}

async function resolveDataDir(): Promise<string> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, 'data'),
    path.resolve(here, '..', '..', '..', 'data'),
    path.resolve(here, '..', 'data'),
    path.resolve(here, '..', '..', 'src', 'data'),
    path.resolve(process.cwd(), 'data'),
    path.resolve(process.cwd(), 'src', 'data'),
    path.resolve(process.cwd(), '..', 'admin-dashboard', 'src', 'data'),
    path.resolve(process.cwd(), 'admin-dashboard', 'src', 'data'),
  ];
  for (const candidate of candidates) {
    if (await fileExists(candidate)) return candidate;
  }
  throw new Error('Unable to locate admin-dashboard data fixtures.');
}

async function readJson(dir: string, file: string): Promise<unknown> {
  return JSON.parse(await readFile(path.join(dir, `${file}.json`), 'utf8'));
}

type Snapshot = {
  overview: AdminRevenueData extends object ? unknown : unknown;
  users: AdminUserSummary[];
  userDetail: AdminUserDetail[];
  revenue: AdminRevenueData;
  usage: AdminUsageData;
  providers: AdminProviderHealth[];
  tickets: AdminTicket[];
  ticketDetail: Omit<AdminTicketDetail, keyof AdminTicket> & { id?: string };
  configModels: AdminModelConfig[];
  configTiers: AdminTierConfig[];
  planDefaults: AdminTierConfig[];
  audit: AdminAuditEntry[];
  account: AdminAccount;
  usageVisibility: AdminUsageVisibility;
  legalTerms: AdminLegalDoc;
  legalPrivacy: AdminLegalDoc;
  unitPricing: AdminUnitPricingConfig;
};

export class MemoryAdminDashboardRepository implements AdminDashboardRepository {
  private dir = '';
  private data: Snapshot | null = null;
  private loaded = false;
  private twoFactorCode: { email: string; code: string; expiresAt: number; attempts: number } | null = null;
  private totpSecretValue = '';

  /** Override the directory used to load fixtures (used by tests). */
  async initialize(dir?: string): Promise<void> {
    this.dir = dir ?? (await resolveDataDir());
    await this.ensureLoaded();
  }

  async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    if (!this.dir) this.dir = await resolveDataDir();
    const userDetailRaw = (await readJson(this.dir, 'user-detail')) as AdminUserDetail | AdminUserDetail[];
    this.data = {
      overview: await readJson(this.dir, 'overview'),
      users: (await readJson(this.dir, 'users')) as AdminUserSummary[],
      userDetail: Array.isArray(userDetailRaw) ? userDetailRaw : [userDetailRaw],
      revenue: (await readJson(this.dir, 'revenue')) as AdminRevenueData,
      usage: (await readJson(this.dir, 'usage')) as AdminUsageData,
      providers: (await readJson(this.dir, 'providers-health')) as AdminProviderHealth[],
      tickets: (await readJson(this.dir, 'support-tickets')) as AdminTicket[],
      ticketDetail: (await readJson(this.dir, 'ticket-detail')) as Snapshot['ticketDetail'],
      configModels: (await readJson(this.dir, 'config-models')) as AdminModelConfig[],
      configTiers: (await readJson(this.dir, 'config-tiers')) as AdminTierConfig[],
      planDefaults: (await readJson(this.dir, 'plan-defaults')) as AdminTierConfig[],
      audit: (await readJson(this.dir, 'audit')) as AdminAuditEntry[],
      account: (await readJson(this.dir, 'admin-account')) as AdminAccount,
      usageVisibility: (await readJson(this.dir, 'usage-visibility')) as AdminUsageVisibility,
      legalTerms: (await readJson(this.dir, 'legal-terms')) as AdminLegalDoc,
      legalPrivacy: (await readJson(this.dir, 'legal-privacy')) as AdminLegalDoc,
      unitPricing: (await readJson(this.dir, 'unit-pricing')) as AdminUnitPricingConfig,
    };
    this.loaded = true;
  }

  private async d(): Promise<Snapshot> {
    await this.ensureLoaded();
    if (!this.data) throw new Error('MemoryAdminDashboardRepository not initialized');
    return this.data;
  }

  // -- reads -----------------------------------------------------------------
  async overview(): Promise<AdminOverviewStats> {
    const d = await this.d();
    return clone(d.overview) as AdminOverviewStats;
  }
  async users(): Promise<AdminUserSummary[]> {
    const d = await this.d();
    return clone(d.users);
  }
  async revenue(): Promise<AdminRevenueData> {
    const d = await this.d();
    return clone(d.revenue);
  }
  async usage(): Promise<AdminUsageData> {
    const d = await this.d();
    return clone(d.usage);
  }
  async providers(): Promise<AdminProviderHealth[]> {
    const d = await this.d();
    return clone(d.providers);
  }
  async tickets(): Promise<AdminTicket[]> {
    const d = await this.d();
    return clone(d.tickets);
  }
  async configModels(): Promise<AdminModelConfig[]> {
    const d = await this.d();
    return clone(d.configModels);
  }
  async configTiers(): Promise<AdminTierConfig[]> {
    const d = await this.d();
    return clone(d.configTiers);
  }
  async planDefaults(): Promise<AdminTierConfig[]> {
    const d = await this.d();
    return clone(d.planDefaults);
  }
  async audit(): Promise<AdminAuditEntry[]> {
    const d = await this.d();
    return clone(d.audit);
  }
  async account(): Promise<AdminAccount> {
    const d = await this.d();
    return clone({
      ...d.account,
      sessions: d.account.sessions.map((s) => ({ ...s })),
      twoFactor: { ...d.account.twoFactor },
    });
  }
  async usageVisibility(): Promise<AdminUsageVisibility> {
    const d = await this.d();
    return clone(d.usageVisibility);
  }
  async legalDoc(docType: 'terms' | 'privacy'): Promise<AdminLegalDoc> {
    const d = await this.d();
    return clone(docType === 'terms' ? d.legalTerms : d.legalPrivacy);
  }
  async adminProfile(): Promise<{
    id: string;
    name: string;
    email: string;
    avatarUrl: string;
    lastSignInAt: string;
  }> {
    const d = await this.d();
    const a = d.account;
    return clone({
      id: a.id,
      name: a.name,
      email: a.email,
      avatarUrl: a.avatarUrl,
      lastSignInAt: a.lastSignInAt,
    });
  }
  async unitPricing(): Promise<AdminUnitPricingConfig> {
    const d = await this.d();
    return clone(d.unitPricing);
  }

  async userDetail(id: string): Promise<AdminUserDetail> {
    const d = await this.d();
    const fromFixture = d.userDetail.find((row) => row.id === id);
    if (fromFixture) return clone(fromFixture);
    const summary = d.users.find((row) => row.id === id);
    if (!summary) throw new Error(`User not found: ${id}`);
    return clone(this.buildDetail(summary));
  }

  async ticketDetail(id: string): Promise<AdminTicketDetail> {
    const d = await this.d();
    const fixture = d.ticketDetail;
    return { ...clone(fixture), id } as AdminTicketDetail;
  }

  async ticketReplies(id: string): Promise<AdminSupportReply[]> {
    const d = await this.d();
    return clone(d.tickets.find((ticket) => ticket.id === id)?.replies ?? []);
  }

  async totpSecret(): Promise<{ secret: string; otpauth: string }> {
    await this.ensureLoaded();
    if (!this.totpSecretValue) this.totpSecretValue = generateTotpSecret();
    const d = await this.d();
    const issuer = 'OneAI Admin';
    const label = d.account.email;
    return {
      secret: this.totpSecretValue,
      otpauth: `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(label)}?secret=${this.totpSecretValue}&issuer=${encodeURIComponent(issuer)}`,
    };
  }

  // -- mutations -------------------------------------------------------------
  async updateAdminProfile(payload: {
    name: string;
    actor?: string;
    reason?: string;
  }): Promise<{ id: string; name: string; email: string; avatarUrl: string; lastSignInAt: string }> {
    const d = await this.d();
    const account = d.account;
    const previous = { name: account.name };
    if (typeof payload.name === 'string' && payload.name.trim().length >= 2) {
      account.name = payload.name.trim();
    }
    this.pushAudit(d, {
      actor: payload.actor ?? DEFAULT_ACTOR,
      action: 'profile.update',
      target: account.id,
      reason: payload.reason ?? 'Admin profile updated',
      ip: '10.0.1.1',
      meta: { previous, next: { name: account.name } },
    });
    return this.adminProfile();
  }

  async setProviderStatus(
    providerId: string,
    status: 'operational' | 'degraded' | 'outage' | 'disabled',
    actor: AdminDashboardActor = DEFAULT_ACTOR,
    reason = '',
  ): Promise<AdminProviderHealth> {
    const d = await this.d();
    const provider = d.providers.find((row) => row.id === providerId);
    if (!provider) throw new Error(`Provider ${providerId} not found`);
    const previous = provider.status;
    provider.status = status;
    this.pushAudit(d, {
      actor,
      action: 'provider.toggle',
      target: providerId,
      reason: reason || `Provider ${providerId} set to ${status}`,
      ip: '10.0.1.1',
      meta: { previous, next: status, providerId },
    });
    return clone(provider);
  }

  async createUser(
    payload: {
      name: string;
      email: string;
      tier: 'free' | 'pro' | 'business';
      status: 'active' | 'suspended' | 'grace';
    },
    actor: AdminDashboardActor = DEFAULT_ACTOR,
  ): Promise<AdminUserSummary> {
    const d = await this.d();
    const email = payload.email.trim().toLowerCase();
    if (d.users.find((row) => row.email.toLowerCase() === email)) {
      throw new Error(`User with email ${payload.email} already exists`);
    }
    const id = `usr_${hash(email).toString(16).padStart(8, '0').slice(0, 8)}`;
    const now = new Date().toISOString();
    const created: AdminUserSummary = {
      id,
      name: payload.name.trim(),
      email,
      tier: payload.tier,
      status: payload.status,
      requestsUsed: 0,
      requestsLimit: payload.tier === 'free' ? 100 : payload.tier === 'pro' ? 5000 : 25000,
      tokensSpent: 0,
      costUsd: 0,
      lastActiveAt: now,
      signupDate: now,
      platform: 'web',
    };
    d.users.unshift(created);
    this.pushAudit(d, {
      actor,
      action: 'userStatus',
      target: id,
      reason: `Created user ${email}`,
      ip: '10.0.1.1',
      meta: { email, tier: payload.tier, status: payload.status },
    });
    return clone(created);
  }

  async setUserStatus(
    userId: string,
    status: 'active' | 'suspended' | 'grace',
    actor: AdminDashboardActor,
    reason: string,
  ): Promise<AdminUserSummary> {
    const d = await this.d();
    const summary = d.users.find((row) => row.id === userId);
    if (!summary) throw new Error(`User ${userId} not found`);
    const previous = summary.status;
    summary.status = status;
    summary.lastActiveAt = summary.lastActiveAt ?? new Date().toISOString();
    this.pushAudit(d, {
      actor,
      action: 'userStatus',
      target: userId,
      reason: reason || `Status changed to ${status}`,
      ip: '10.0.1.1',
      meta: { previous, next: status },
    });
    return clone(summary);
  }

  async grantQuota(
    userId: string,
    amount: number,
    actor: AdminDashboardActor,
    reason: string,
  ): Promise<{ user: AdminUserSummary; entry: AdminQuotaHistoryEntry }> {
    if (!Number.isFinite(amount) || amount <= 0) throw new Error('amount must be a positive number');
    const d = await this.d();
    const summary = d.users.find((row) => row.id === userId);
    if (!summary) throw new Error(`User ${userId} not found`);
    const previousLimit = summary.requestsLimit;
    summary.requestsLimit = previousLimit + amount;
    let detail = d.userDetail.find((row) => row.id === userId);
    if (!detail) {
      detail = this.buildDetail(summary);
      d.userDetail.push(detail);
    }
    const entry: AdminQuotaHistoryEntry = {
      date: new Date().toISOString(),
      amount,
      by: actor,
      reason: reason || 'No reason provided',
      newTotal: summary.requestsLimit,
    };
    detail.requestsLimit = summary.requestsLimit;
    detail.quotaHistory = [entry as unknown as (typeof detail.quotaHistory)[number], ...(detail.quotaHistory ?? [])];
    this.pushAudit(d, {
      actor,
      action: 'quotaOverride',
      target: userId,
      reason: reason || `Granted ${amount} tokens`,
      ip: '10.0.1.1',
      meta: { amount, previousLimit, newLimit: summary.requestsLimit },
    });
    return { user: clone(summary), entry: clone(entry) };
  }

  async setQuotaOverride(
    userId: string,
    override: Omit<AdminQuotaOverride, 'setAt'>,
    actor: AdminDashboardActor,
  ): Promise<{ user: AdminUserSummary; override: AdminQuotaOverride }> {
    const d = await this.d();
    const summary = d.users.find((row) => row.id === userId);
    if (!summary) throw new Error(`User ${userId} not found`);
    let detail = d.userDetail.find((row) => row.id === userId);
    if (!detail) {
      detail = this.buildDetail(summary);
      d.userDetail.push(detail);
    }
    const existing = (detail.quotaHistory ?? []).filter(
      (entry) => (entry as { kind?: string }).kind === 'override',
    );
    if (override.bypassQuota) {
      detail.requestsLimit = Number.MAX_SAFE_INTEGER;
    } else if (override.customRequestsLimit != null) {
      detail.requestsLimit = override.customRequestsLimit;
      summary.requestsLimit = override.customRequestsLimit;
    }
    const entry: AdminQuotaOverride & { kind: 'override' } = {
      ...override,
      setAt: new Date().toISOString(),
      kind: 'override',
    };
    detail.quotaHistory = [entry as unknown as (typeof detail.quotaHistory)[number], ...existing];
    this.pushAudit(d, {
      actor,
      action: 'quotaOverride',
      target: userId,
      reason: override.reason,
      ip: '10.0.1.1',
      meta: {
        bypassQuota: override.bypassQuota,
        customRequestsLimit: override.customRequestsLimit,
        customTokensLimit: override.customTokensLimit,
      },
    });
    return { user: clone(summary), override: clone(entry) };
  }

  async resetQuotaOverride(
    userId: string,
    actor: AdminDashboardActor,
    reason: string,
  ): Promise<AdminUserSummary> {
    const d = await this.d();
    const summary = d.users.find((row) => row.id === userId);
    if (!summary) throw new Error(`User ${userId} not found`);
    const detail = d.userDetail.find((row) => row.id === userId);
    if (detail) {
      detail.quotaHistory = (detail.quotaHistory ?? []).filter(
        (entry) => (entry as { kind?: string }).kind !== 'override',
      );
      const defaultLimit = summary.tier === 'free' ? 100 : summary.tier === 'pro' ? 5000 : 25000;
      detail.requestsLimit = defaultLimit;
      summary.requestsLimit = defaultLimit;
    }
    this.pushAudit(d, {
      actor,
      action: 'quotaOverride',
      target: userId,
      reason: reason || 'Quota override cleared',
      ip: '10.0.1.1',
      meta: { cleared: true },
    });
    return clone(summary);
  }

  async appendAudit(entry: Omit<AdminAuditEntry, 'id' | 'at'>): Promise<AdminAuditEntry> {
    const d = await this.d();
    return this.pushAudit(d, entry);
  }

  async postReply(ticketId: string, body: string, actor: AdminDashboardActor): Promise<AdminSupportReply> {
    const d = await this.d();
    const ticket = d.tickets.find((row) => row.id === ticketId);
    const reply: AdminSupportReply = {
      id: `rep_${ticketId}_${(ticket?.replies.length ?? 0) + 1}_${Date.now()}`,
      author: actor,
      role: 'admin',
      message: body,
      createdAt: new Date().toISOString(),
    };
    if (ticket) {
      ticket.replies.push(reply);
      ticket.updatedAt = reply.createdAt;
    }
    this.pushAudit(d, {
      actor,
      action: 'support.reply',
      target: ticketId,
      reason: `Replied to ticket ${ticketId}`,
      ip: '10.0.1.1',
      meta: { ticketId, preview: body.slice(0, 80) },
    });
    return clone(reply);
  }

  async closeTicket(ticketId: string, actor: AdminDashboardActor, reason: string): Promise<AdminTicket> {
    const d = await this.d();
    const ticket = d.tickets.find((row) => row.id === ticketId);
    if (!ticket) throw new Error(`Ticket ${ticketId} not found`);
    ticket.status = 'resolved';
    ticket.updatedAt = new Date().toISOString();
    this.pushAudit(d, {
      actor,
      action: 'support.close',
      target: ticketId,
      reason: reason || `Closed ticket ${ticketId}`,
      ip: '10.0.1.1',
      meta: { ticketId },
    });
    return clone(ticket);
  }

  async updateConfigTiers(
    next: AdminTierConfig[],
    actor: AdminDashboardActor,
    reason: string,
  ): Promise<AdminTierConfig[]> {
    const d = await this.d();
    d.configTiers = clone(next);
    this.pushAudit(d, {
      actor,
      action: 'tier.update',
      target: 'config-tiers',
      reason: reason || 'Tier configuration updated',
      ip: '10.0.1.1',
      meta: { count: next.length },
    });
    return clone(d.configTiers);
  }

  async updateConfigModels(
    next: AdminModelConfig[],
    actor: AdminDashboardActor,
    reason: string,
  ): Promise<AdminModelConfig[]> {
    const d = await this.d();
    d.configModels = clone(next);
    this.pushAudit(d, {
      actor,
      action: 'model.toggle',
      target: 'config-models',
      reason: reason || 'Model configuration updated',
      ip: '10.0.1.1',
      meta: { count: next.length },
    });
    return clone(d.configModels);
  }

  async saveLegalVersion(
    docType: 'terms' | 'privacy',
    payload: { body: string; summary: string; createdBy: string; reason: string },
  ): Promise<AdminLegalDoc> {
    const d = await this.d();
    const target = docType === 'terms' ? d.legalTerms : d.legalPrivacy;
    const nextId = `v${target.versions.length + 1}`;
    target.versions.push({
      id: nextId,
      bodyMarkdown: payload.body,
      summary: payload.summary,
      createdAt: new Date().toISOString(),
      createdBy: payload.createdBy,
    });
    target.currentVersionId = nextId;
    this.pushAudit(d, {
      actor: payload.createdBy,
      action: 'legal.publish',
      target: docType,
      reason: payload.reason,
      ip: '10.0.1.1',
      meta: { docType, versionId: nextId },
    });
    return clone(target);
  }

  async restoreLegalVersion(
    docType: 'terms' | 'privacy',
    versionId: string,
    actor: AdminDashboardActor,
    reason: string,
  ): Promise<AdminLegalDoc> {
    const d = await this.d();
    const target = docType === 'terms' ? d.legalTerms : d.legalPrivacy;
    if (!target.versions.find((version) => version.id === versionId)) {
      throw new Error(`Version ${versionId} not found in ${docType}`);
    }
    target.currentVersionId = versionId;
    this.pushAudit(d, {
      actor,
      action: 'legal.restore',
      target: docType,
      reason,
      ip: '10.0.1.1',
      meta: { docType, versionId },
    });
    return clone(target);
  }

  async deleteLegalVersion(
    docType: 'terms' | 'privacy',
    versionId: string,
    actor: AdminDashboardActor,
    reason: string,
  ): Promise<AdminLegalDoc> {
    const d = await this.d();
    const target = docType === 'terms' ? d.legalTerms : d.legalPrivacy;
    if (target.versions.length <= 1) throw new Error('Cannot delete the only version');
    if (target.currentVersionId === versionId) throw new Error('Cannot delete the current version');
    target.versions = target.versions.filter((version) => version.id !== versionId);
    this.pushAudit(d, {
      actor,
      action: 'legal.delete',
      target: docType,
      reason,
      ip: '10.0.1.1',
      meta: { docType, versionId },
    });
    return clone(target);
  }

  async setUsageVisibility(
    next: AdminUsageVisibility,
    actor: AdminDashboardActor = DEFAULT_ACTOR,
  ): Promise<AdminUsageVisibility> {
    const d = await this.d();
    d.usageVisibility = clone(next);
    this.pushAudit(d, {
      actor,
      action: 'usage.toggle',
      target: 'usage-visibility',
      reason: `Customer usage dashboard ${next?.enabled ? 'enabled' : 'disabled'}`,
      ip: '10.0.1.1',
      meta: next as Record<string, unknown>,
    });
    return clone(d.usageVisibility);
  }

  async updateUnitPricing(
    payload: {
      requestUnit?: { size: number; priceUsd: number; enabled: boolean };
      tokenUnit?: { size: number; priceUsd: number; enabled: boolean };
      reason: string;
    },
    actor: AdminDashboardActor = DEFAULT_ACTOR,
  ): Promise<AdminUnitPricingConfig> {
    const d = await this.d();
    const trimmedReason = payload.reason.trim();
    if (trimmedReason.length < 10) throw new Error('Reason must be at least 10 characters');
    if (!payload.requestUnit && !payload.tokenUnit) throw new Error('At least one unit must be provided');
    const stamp = new Date().toISOString();
    const beforeRequest = d.unitPricing.requestUnit;
    const beforeToken = d.unitPricing.tokenUnit;
    const nextHistory = [...d.unitPricing.history];
    if (payload.requestUnit) {
      if (payload.requestUnit.size <= 0) throw new Error('requestUnit.size must be greater than 0');
      if (payload.requestUnit.priceUsd < 0) throw new Error('requestUnit.priceUsd must be >= 0');
      nextHistory.unshift({
        ts: stamp,
        actor,
        unit: 'request',
        before: { size: beforeRequest.size, priceUsd: beforeRequest.priceUsd },
        after: { size: payload.requestUnit.size, priceUsd: payload.requestUnit.priceUsd },
        reason: trimmedReason,
      });
      d.unitPricing.requestUnit = {
        ...beforeRequest,
        ...payload.requestUnit,
        updatedAt: stamp,
        updatedBy: actor,
      };
    }
    if (payload.tokenUnit) {
      if (payload.tokenUnit.size <= 0) throw new Error('tokenUnit.size must be greater than 0');
      if (payload.tokenUnit.priceUsd < 0) throw new Error('tokenUnit.priceUsd must be >= 0');
      nextHistory.unshift({
        ts: stamp,
        actor,
        unit: 'token',
        before: { size: beforeToken.size, priceUsd: beforeToken.priceUsd },
        after: { size: payload.tokenUnit.size, priceUsd: payload.tokenUnit.priceUsd },
        reason: trimmedReason,
      });
      d.unitPricing.tokenUnit = {
        ...beforeToken,
        ...payload.tokenUnit,
        updatedAt: stamp,
        updatedBy: actor,
      };
    }
    d.unitPricing.history = nextHistory;
    this.pushAudit(d, {
      actor,
      action: 'pricing.update',
      target: 'unit-pricing',
      reason: trimmedReason,
      ip: '10.0.1.1',
      meta: {
        requestUnit: d.unitPricing.requestUnit,
        tokenUnit: d.unitPricing.tokenUnit,
        requestChanged: Boolean(payload.requestUnit),
        tokenChanged: Boolean(payload.tokenUnit),
      },
    });
    return clone(d.unitPricing);
  }

  async setTotpEnabled(enabled: boolean, actor: AdminDashboardActor = DEFAULT_ACTOR): Promise<AdminAccount> {
    const d = await this.d();
    d.account.totpEnabled = enabled;
    this.pushAudit(d, {
      actor,
      action: 'userStatus',
      target: 'admin.totp',
      reason: enabled ? 'TOTP enabled' : 'TOTP disabled',
      ip: '10.0.1.1',
      meta: { totpEnabled: enabled },
    });
    return this.account();
  }

  async sendTwoFactorCode(payload: { email: string }, actor: AdminDashboardActor = DEFAULT_ACTOR): Promise<{ ok: true }> {
    const d = await this.d();
    const code = String(Math.floor(100000 + Math.random() * 900000));
    this.twoFactorCode = {
      email: payload.email,
      code,
      expiresAt: Date.now() + TWO_FACTOR_TTL_MS,
      attempts: 0,
    };
    this.pushAudit(d, {
      actor,
      action: 'twoFactor.codeSent',
      target: payload.email,
      reason: 'Two-factor verification code sent',
      ip: '10.0.1.1',
      meta: { email: payload.email },
    });
    return { ok: true };
  }

  async verifyTwoFactorCode(
    payload: { email: string; code: string },
    actor: AdminDashboardActor = DEFAULT_ACTOR,
  ): Promise<{ ok: boolean; reason?: string }> {
    const d = await this.d();
    const pending = this.twoFactorCode;
    if (!pending || pending.email !== payload.email || Date.now() > pending.expiresAt) {
      this.twoFactorCode = null;
      return { ok: false, reason: 'expired' };
    }
    if (pending.attempts >= TWO_FACTOR_MAX_ATTEMPTS) {
      this.twoFactorCode = null;
      return { ok: false, reason: 'too-many-attempts' };
    }
    if (pending.code !== payload.code) {
      pending.attempts += 1;
      if (pending.attempts >= TWO_FACTOR_MAX_ATTEMPTS) this.twoFactorCode = null;
      return {
        ok: false,
        reason: pending.attempts >= TWO_FACTOR_MAX_ATTEMPTS ? 'too-many-attempts' : 'mismatch',
      };
    }
    d.account.twoFactor = { email: payload.email, verified: true };
    this.pushAudit(d, {
      actor,
      action: 'twoFactor.verified',
      target: payload.email,
      reason: 'Two-factor email verified',
      ip: '10.0.1.1',
      meta: { email: payload.email },
    });
    this.twoFactorCode = null;
    return { ok: true };
  }

  async setTwoFactorEmail(
    payload: { email: string },
    actor: AdminDashboardActor = DEFAULT_ACTOR,
  ): Promise<AdminAccount> {
    const d = await this.d();
    d.account.twoFactor = { email: payload.email, verified: false };
    this.twoFactorCode = null;
    this.pushAudit(d, {
      actor,
      action: 'twoFactor.emailUpdated',
      target: payload.email,
      reason: 'Two-factor email updated',
      ip: '10.0.1.1',
      meta: { email: payload.email },
    });
    return this.account();
  }

  async disableTwoFactor(actor: AdminDashboardActor = DEFAULT_ACTOR): Promise<AdminAccount> {
    const d = await this.d();
    d.account.twoFactor = { email: d.account.twoFactor.email, verified: false };
    this.twoFactorCode = null;
    this.pushAudit(d, {
      actor,
      action: 'twoFactor.disabled',
      target: 'admin.twoFactor',
      reason: 'Two-factor authentication disabled',
      ip: '10.0.1.1',
      meta: { email: d.account.twoFactor.email },
    });
    return this.account();
  }

  async revokeSession(sessionId: string, actor: AdminDashboardActor = DEFAULT_ACTOR): Promise<AdminAccount> {
    const d = await this.d();
    d.account.sessions = d.account.sessions.filter((session) => session.id !== sessionId);
    this.pushAudit(d, {
      actor,
      action: 'sessionRevoked',
      target: sessionId,
      reason: `Revoked session ${sessionId}`,
      ip: '10.0.1.1',
      meta: { sessionId },
    });
    return this.account();
  }

  async revokeAllOtherSessions(actor: AdminDashboardActor = DEFAULT_ACTOR): Promise<number> {
    const d = await this.d();
    const remaining = d.account.sessions.filter((session) => session.current);
    const removed = d.account.sessions.length - remaining.length;
    d.account.sessions = remaining;
    this.pushAudit(d, {
      actor,
      action: 'sessionRevoked',
      target: 'admin.sessions',
      reason: `Revoked ${removed} other session(s)`,
      ip: '10.0.1.1',
      meta: { count: removed },
    });
    return removed;
  }

  async reset(): Promise<void> {
    this.loaded = false;
    this.dir = '';
    this.data = null;
    this.twoFactorCode = null;
    this.totpSecretValue = '';
  }

  // -- internals -------------------------------------------------------------
  private pushAudit(d: Snapshot, entry: Omit<AdminAuditEntry, 'id' | 'at'>): AdminAuditEntry {
    const row: AdminAuditEntry = {
      id: `aud_${String(Date.now()).slice(-8)}`,
      at: new Date().toISOString(),
      ...entry,
    };
    d.audit.unshift(row);
    return clone(row);
  }

  private buildDetail(summary: AdminUserSummary): AdminUserDetail {
    const totals = Math.max(1, summary.tokensSpent);
    const seed = [...summary.id].reduce((acc, ch) => acc + ch.charCodeAt(0), 0);
    const ticketPool = ['tkt_001', 'tkt_002', 'tkt_003', 'tkt_004', 'tkt_005', 'tkt_006'];
    const count = seed % 4;
    const tickets = count === 0
      ? []
      : Array.from({ length: count }, (_, index) => ticketPool[(seed + index) % ticketPool.length]!);
    return {
      ...summary,
      avatarUrl: '/brand/logo-mark.svg',
      signupSource: summary.platform,
      paymentHistory: [],
      quotaHistory: [],
      renewals: [],
      modelDistribution: {
        gpt: Math.round(totals * 0.45),
        gemini: Math.round(totals * 0.22),
        claude: Math.round(totals * 0.12),
        grok: Math.round(totals * 0.16),
        deepseek: Math.round(totals * 0.04),
        perplexity: Math.round(totals * 0.01),
      },
      ticketIds: tickets,
      memory: { count: 0, bytesUsed: 0, lastUpdatedAt: summary.lastActiveAt, topCategories: [] },
      actionTimeline: [],
    };
  }

  /** Compatibility helper — the legacy code referenced the singleton key. */
  static readonly SINGLETON_ID = SINGLETON_ID;
}