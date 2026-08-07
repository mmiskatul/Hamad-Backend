/**
 * Thin facade over `AdminDashboardRepository`. The legacy in-memory store
 * used to live here; that code has moved to `memoryAdminRepository.ts`. The
 * production build wires a Mongo-backed repo via `app.ts`; tests wire a
 * memory repo via the `adminRepository` option on `buildApp`.
 */

import type {
  AdminDashboardRepository,
  AdminAccount,
  AdminAuditEntry,
  AdminLegalDoc,
  AdminModelConfig,
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
  AdminDashboardActor,
} from './adminRepository.js';
import { AdminStorageUnavailableError } from './adminRepository.js';

export class AdminDashboardStore {
  constructor(private readonly repo: AdminDashboardRepository) {}

  // Read methods
  overview(): Promise<unknown> {
    return this.repo.overview();
  }
  users(): Promise<AdminUserSummary[]> {
    return this.repo.users();
  }
  userDetail(id: string): Promise<AdminUserDetail> {
    return this.repo.userDetail(id);
  }
  revenue(): Promise<AdminRevenueData> {
    return this.repo.revenue();
  }
  usage(): Promise<AdminUsageData> {
    return this.repo.usage();
  }
  providers(): Promise<AdminProviderHealth[]> {
    return this.repo.providers();
  }
  tickets(): Promise<AdminTicket[]> {
    return this.repo.tickets();
  }
  ticketDetail(id: string): Promise<AdminTicketDetail> {
    return this.repo.ticketDetail(id);
  }
  ticketReplies(id: string): Promise<AdminSupportReply[]> {
    return this.repo.ticketReplies(id);
  }
  configModels(): Promise<AdminModelConfig[]> {
    return this.repo.configModels();
  }
  configTiers(): Promise<AdminTierConfig[]> {
    return this.repo.configTiers();
  }
  planDefaults(): Promise<AdminTierConfig[]> {
    return this.repo.planDefaults();
  }
  audit(): Promise<AdminAuditEntry[]> {
    return this.repo.audit();
  }
  account(): Promise<AdminAccount> {
    return this.repo.account();
  }
  usageVisibility(): Promise<AdminUsageVisibility> {
    return this.repo.usageVisibility();
  }
  legalDoc(docType: 'terms' | 'privacy'): Promise<AdminLegalDoc> {
    return this.repo.legalDoc(docType);
  }
  adminProfile(): Promise<{ id: string; name: string; email: string; avatarUrl: string; lastSignInAt: string }> {
    return this.repo.adminProfile();
  }
  totpSecret(): Promise<{ secret: string; otpauth: string }> {
    return this.repo.totpSecret();
  }
  unitPricing(): Promise<AdminUnitPricingConfig> {
    return this.repo.unitPricing();
  }

  // Mutations
  updateAdminProfile(input: { name: string; actor?: string; reason?: string }): Promise<{
    id: string;
    name: string;
    email: string;
    avatarUrl: string;
    lastSignInAt: string;
  }> {
    return this.repo.updateAdminProfile(input);
  }
  setProviderStatus(
    providerId: string,
    status: 'operational' | 'degraded' | 'outage' | 'disabled',
    actor: AdminDashboardActor = 'admin@oneai.app',
    reason = '',
  ): Promise<AdminProviderHealth> {
    return this.repo.setProviderStatus(providerId, status, actor, reason);
  }
  createUser(
    input: { name: string; email: string; tier: 'free' | 'pro' | 'business'; status: 'active' | 'suspended' | 'grace' },
    actor: AdminDashboardActor = 'admin@oneai.app',
  ): Promise<AdminUserSummary> {
    return this.repo.createUser(input, actor);
  }
  setUserStatus(
    userId: string,
    status: 'active' | 'suspended' | 'grace',
    actor: AdminDashboardActor,
    reason: string,
  ): Promise<AdminUserSummary> {
    return this.repo.setUserStatus(userId, status, actor, reason);
  }
  grantQuota(
    userId: string,
    amount: number,
    actor: AdminDashboardActor,
    reason: string,
  ): Promise<{ user: AdminUserSummary; entry: AdminQuotaHistoryEntry }> {
    return this.repo.grantQuota(userId, amount, actor, reason);
  }
  setQuotaOverride(
    userId: string,
    override: Omit<AdminQuotaOverride, 'setAt'>,
    actor: AdminDashboardActor,
  ): Promise<{ user: AdminUserSummary; override: AdminQuotaOverride }> {
    return this.repo.setQuotaOverride(userId, override, actor);
  }
  resetQuotaOverride(
    userId: string,
    actor: AdminDashboardActor,
    reason: string,
  ): Promise<AdminUserSummary> {
    return this.repo.resetQuotaOverride(userId, actor, reason);
  }
  appendAudit(entry: Omit<AdminAuditEntry, 'id' | 'at'>): Promise<AdminAuditEntry> {
    return this.repo.appendAudit(entry);
  }
  postReply(ticketId: string, body: string, actor: AdminDashboardActor): Promise<AdminSupportReply> {
    return this.repo.postReply(ticketId, body, actor);
  }
  closeTicket(ticketId: string, actor: AdminDashboardActor, reason: string): Promise<AdminTicket> {
    return this.repo.closeTicket(ticketId, actor, reason);
  }
  updateConfigTiers(
    next: AdminTierConfig[],
    actor: AdminDashboardActor,
    reason: string,
  ): Promise<AdminTierConfig[]> {
    return this.repo.updateConfigTiers(next, actor, reason);
  }
  updateConfigModels(
    next: AdminModelConfig[],
    actor: AdminDashboardActor,
    reason: string,
  ): Promise<AdminModelConfig[]> {
    return this.repo.updateConfigModels(next, actor, reason);
  }
  saveLegalVersion(
    docType: 'terms' | 'privacy',
    payload: { body: string; summary: string; createdBy: string; reason: string },
  ): Promise<AdminLegalDoc> {
    return this.repo.saveLegalVersion(docType, payload);
  }
  restoreLegalVersion(
    docType: 'terms' | 'privacy',
    versionId: string,
    actor: AdminDashboardActor,
    reason: string,
  ): Promise<AdminLegalDoc> {
    return this.repo.restoreLegalVersion(docType, versionId, actor, reason);
  }
  deleteLegalVersion(
    docType: 'terms' | 'privacy',
    versionId: string,
    actor: AdminDashboardActor,
    reason: string,
  ): Promise<AdminLegalDoc> {
    return this.repo.deleteLegalVersion(docType, versionId, actor, reason);
  }
  setUsageVisibility(
    next: AdminUsageVisibility,
    actor: AdminDashboardActor = 'admin@oneai.app',
  ): Promise<AdminUsageVisibility> {
    return this.repo.setUsageVisibility(next, actor);
  }
  updateUnitPricing(
    payload: {
      requestUnit?: { size: number; priceUsd: number; enabled: boolean };
      tokenUnit?: { size: number; priceUsd: number; enabled: boolean };
      reason: string;
    },
    actor: AdminDashboardActor = 'admin@oneai.app',
  ): Promise<AdminUnitPricingConfig> {
    return this.repo.updateUnitPricing(payload, actor);
  }
  setTotpEnabled(enabled: boolean, actor: AdminDashboardActor = 'admin@oneai.app'): Promise<AdminAccount> {
    return this.repo.setTotpEnabled(enabled, actor);
  }
  sendTwoFactorCode(payload: { email: string }, actor: AdminDashboardActor = 'admin@oneai.app'): Promise<{ ok: true }> {
    return this.repo.sendTwoFactorCode(payload, actor);
  }
  verifyTwoFactorCode(
    payload: { email: string; code: string },
    actor: AdminDashboardActor = 'admin@oneai.app',
  ): Promise<{ ok: boolean; reason?: string }> {
    return this.repo.verifyTwoFactorCode(payload, actor);
  }
  setTwoFactorEmail(
    payload: { email: string },
    actor: AdminDashboardActor = 'admin@oneai.app',
  ): Promise<AdminAccount> {
    return this.repo.setTwoFactorEmail(payload, actor);
  }
  disableTwoFactor(actor: AdminDashboardActor = 'admin@oneai.app'): Promise<AdminAccount> {
    return this.repo.disableTwoFactor(actor);
  }
  revokeSession(sessionId: string, actor: AdminDashboardActor = 'admin@oneai.app'): Promise<AdminAccount> {
    return this.repo.revokeSession(sessionId, actor);
  }
  revokeAllOtherSessions(actor: AdminDashboardActor = 'admin@oneai.app'): Promise<number> {
    return this.repo.revokeAllOtherSessions(actor);
  }

  reset(): Promise<void> {
    return this.repo.reset();
  }
}

export { AdminStorageUnavailableError };
export type {
  AdminAccount,
  AdminAuditEntry,
  AdminLegalDoc,
  AdminModelConfig,
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
export type { AdminDashboardRepository } from './adminRepository.js';
