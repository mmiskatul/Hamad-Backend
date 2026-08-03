import { randomBytes } from 'node:crypto';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';

const TWO_FACTOR_TTL_MS = 10 * 60 * 1000;
const TWO_FACTOR_MAX_ATTEMPTS = 5;
const DEFAULT_ACTOR = 'admin@oneai.app';

function clone(value: any) {
  return structuredClone(value);
}

function hash(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
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
  const candidates = [
    path.resolve(process.cwd(), '..', 'admin-dashboard', 'src', 'data'),
    path.resolve(process.cwd(), 'admin-dashboard', 'src', 'data'),
    path.resolve(process.cwd(), 'src', 'data'),
  ];
  for (const candidate of candidates) {
    if (await fileExists(candidate)) return candidate;
  }
  throw new Error('Unable to locate admin-dashboard data fixtures.');
}

async function readJson(dir: string, file: string) {
  return JSON.parse(await readFile(path.join(dir, `${file}.json`), 'utf8'));
}

export class AdminDashboardStore {
  private loaded = false;
  private dir = '';
  private data: any = null;
  private twoFactorCode: { email: string; code: string; expiresAt: number; attempts: number } | null = null;
  private totpSecretValue = '';

  private async ensureLoaded() {
    if (this.loaded) return;
    this.dir = await resolveDataDir();
    const userDetailRaw = await readJson(this.dir, 'user-detail');
    this.data = {
      overview: await readJson(this.dir, 'overview'),
      users: await readJson(this.dir, 'users'),
      userDetail: Array.isArray(userDetailRaw) ? userDetailRaw : [userDetailRaw],
      revenue: await readJson(this.dir, 'revenue'),
      usage: await readJson(this.dir, 'usage'),
      providers: await readJson(this.dir, 'providers-health'),
      tickets: await readJson(this.dir, 'support-tickets'),
      ticketDetail: await readJson(this.dir, 'ticket-detail'),
      configModels: await readJson(this.dir, 'config-models'),
      configTiers: await readJson(this.dir, 'config-tiers'),
      planDefaults: await readJson(this.dir, 'plan-defaults'),
      audit: await readJson(this.dir, 'audit'),
      account: await readJson(this.dir, 'admin-account'),
      usageVisibility: await readJson(this.dir, 'usage-visibility'),
      legalTerms: await readJson(this.dir, 'legal-terms'),
      legalPrivacy: await readJson(this.dir, 'legal-privacy'),
      unitPricing: await readJson(this.dir, 'unit-pricing'),
    };
    this.loaded = true;
  }

  async overview() { await this.ensureLoaded(); return clone(this.data.overview); }
  async users() { await this.ensureLoaded(); return clone(this.data.users); }
  async revenue() { await this.ensureLoaded(); return clone(this.data.revenue); }
  async usage() { await this.ensureLoaded(); return clone(this.data.usage); }
  async providers() { await this.ensureLoaded(); return clone(this.data.providers); }
  async tickets() { await this.ensureLoaded(); return clone(this.data.tickets); }
  async configModels() { await this.ensureLoaded(); return clone(this.data.configModels); }
  async configTiers() { await this.ensureLoaded(); return clone(this.data.configTiers); }
  async planDefaults() { await this.ensureLoaded(); return clone(this.data.planDefaults); }
  async audit() { await this.ensureLoaded(); return clone(this.data.audit); }
  async account() { await this.ensureLoaded(); return clone({ ...this.data.account, sessions: this.data.account.sessions.map((s: any) => ({ ...s })), twoFactor: { ...this.data.account.twoFactor } }); }
  async usageVisibility() { await this.ensureLoaded(); return clone(this.data.usageVisibility); }
  async legalDoc(docType: 'terms' | 'privacy') { await this.ensureLoaded(); return clone(docType === 'terms' ? this.data.legalTerms : this.data.legalPrivacy); }
  async adminProfile() { await this.ensureLoaded(); const a = this.data.account; return clone({ id: a.id, name: a.name, email: a.email, avatarUrl: a.avatarUrl, lastSignInAt: a.lastSignInAt }); }
  async totpSecret() { await this.ensureLoaded(); if (!this.totpSecretValue) this.totpSecretValue = generateTotpSecret(); const issuer = 'OneAI Admin'; const label = this.data.account.email; return { secret: this.totpSecretValue, otpauth: `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(label)}?secret=${this.totpSecretValue}&issuer=${encodeURIComponent(issuer)}` }; }
  async unitPricing() { await this.ensureLoaded(); return clone(this.data.unitPricing); }

  async userDetail(id: string) {
    await this.ensureLoaded();
    const fromFixture = this.data.userDetail.find((row: any) => row.id === id);
    if (fromFixture) return clone(fromFixture);
    const summary = this.data.users.find((row: any) => row.id === id);
    if (!summary) throw new Error(`User not found: ${id}`);
    return clone(this.buildDetail(summary));
  }

  async ticketDetail(id: string) { await this.ensureLoaded(); return { ...clone(this.data.ticketDetail), id }; }
  async ticketReplies(id: string) { await this.ensureLoaded(); return clone(this.data.tickets.find((ticket: any) => ticket.id === id)?.replies ?? []); }

  async setTotpEnabled(enabled: boolean, actor = DEFAULT_ACTOR) {
    await this.ensureLoaded();
    this.data.account.totpEnabled = enabled;
    this.pushAudit({ actor, action: 'userStatus', target: 'admin.totp', reason: enabled ? 'TOTP enabled' : 'TOTP disabled', ip: '10.0.1.1', meta: { totpEnabled: enabled } });
    return this.account();
  }

  async sendTwoFactorCode(payload: { email: string }, actor = DEFAULT_ACTOR) {
    await this.ensureLoaded();
    const code = String(Math.floor(100000 + Math.random() * 900000));
    this.twoFactorCode = { email: payload.email, code, expiresAt: Date.now() + TWO_FACTOR_TTL_MS, attempts: 0 };
    this.pushAudit({ actor, action: 'twoFactor.codeSent', target: payload.email, reason: 'Two-factor verification code sent', ip: '10.0.1.1', meta: { email: payload.email } });
    return { ok: true as const };
  }

  async verifyTwoFactorCode(payload: { email: string; code: string }, actor = DEFAULT_ACTOR) {
    await this.ensureLoaded();
    const pending = this.twoFactorCode;
    if (!pending || pending.email !== payload.email || Date.now() > pending.expiresAt) { this.twoFactorCode = null; return { ok: false as const, reason: 'expired' as const }; }
    if (pending.attempts >= TWO_FACTOR_MAX_ATTEMPTS) { this.twoFactorCode = null; return { ok: false as const, reason: 'too-many-attempts' as const }; }
    if (pending.code !== payload.code) {
      pending.attempts += 1;
      if (pending.attempts >= TWO_FACTOR_MAX_ATTEMPTS) this.twoFactorCode = null;
      return { ok: false as const, reason: pending.attempts >= TWO_FACTOR_MAX_ATTEMPTS ? 'too-many-attempts' as const : 'mismatch' as const };
    }
    this.data.account.twoFactor = { email: payload.email, verified: true };
    this.pushAudit({ actor, action: 'twoFactor.verified', target: payload.email, reason: 'Two-factor email verified', ip: '10.0.1.1', meta: { email: payload.email } });
    this.twoFactorCode = null;
    return { ok: true as const };
  }

  async setTwoFactorEmail(payload: { email: string }, actor = DEFAULT_ACTOR) {
    await this.ensureLoaded();
    this.data.account.twoFactor = { email: payload.email, verified: false };
    this.twoFactorCode = null;
    this.pushAudit({ actor, action: 'twoFactor.emailUpdated', target: payload.email, reason: 'Two-factor email updated', ip: '10.0.1.1', meta: { email: payload.email } });
    return this.account();
  }

  async disableTwoFactor(actor = DEFAULT_ACTOR) {
    await this.ensureLoaded();
    this.data.account.twoFactor = { email: this.data.account.twoFactor.email, verified: false };
    this.twoFactorCode = null;
    this.pushAudit({ actor, action: 'twoFactor.disabled', target: 'admin.twoFactor', reason: 'Two-factor authentication disabled', ip: '10.0.1.1', meta: { email: this.data.account.twoFactor.email } });
    return this.account();
  }

  async revokeSession(sessionId: string, actor = DEFAULT_ACTOR) {
    await this.ensureLoaded();
    this.data.account.sessions = this.data.account.sessions.filter((session: any) => session.id !== sessionId);
    this.pushAudit({ actor, action: 'sessionRevoked', target: sessionId, reason: `Revoked session ${sessionId}`, ip: '10.0.1.1', meta: { sessionId } });
    return this.account();
  }

  async revokeAllOtherSessions(actor = DEFAULT_ACTOR) {
    await this.ensureLoaded();
    const remaining = this.data.account.sessions.filter((session: any) => session.current);
    const removed = this.data.account.sessions.length - remaining.length;
    this.data.account.sessions = remaining;
    this.pushAudit({ actor, action: 'sessionRevoked', target: 'admin.sessions', reason: `Revoked ${removed} other session(s)`, ip: '10.0.1.1', meta: { count: removed } });
    return removed;
  }

  async setUsageVisibility(next: any, actor = DEFAULT_ACTOR) {
    await this.ensureLoaded();
    this.data.usageVisibility = clone(next);
    this.pushAudit({ actor, action: 'usage.toggle', target: 'usage-visibility', reason: `Customer usage dashboard ${next?.enabled ? 'enabled' : 'disabled'}`, ip: '10.0.1.1', meta: next as Record<string, unknown> });
    return clone(this.data.usageVisibility);
  }

  async saveLegalVersion(docType: 'terms' | 'privacy', payload: { body: string; summary: string; createdBy: string; reason: string }) {
    await this.ensureLoaded();
    const target = docType === 'terms' ? this.data.legalTerms : this.data.legalPrivacy;
    const nextId = `v${target.versions.length + 1}`;
    target.versions.push({ id: nextId, bodyMarkdown: payload.body, summary: payload.summary, createdAt: new Date().toISOString(), createdBy: payload.createdBy });
    target.currentVersionId = nextId;
    this.pushAudit({ actor: payload.createdBy, action: 'legal.publish', target: docType, reason: payload.reason, ip: '10.0.1.1', meta: { docType, versionId: nextId } });
    return clone(target);
  }

  async restoreLegalVersion(docType: 'terms' | 'privacy', versionId: string, actor: string, reason: string) {
    await this.ensureLoaded();
    const target = docType === 'terms' ? this.data.legalTerms : this.data.legalPrivacy;
    if (!target.versions.find((version: any) => version.id === versionId)) throw new Error(`Version ${versionId} not found in ${docType}`);
    target.currentVersionId = versionId;
    this.pushAudit({ actor, action: 'legal.restore', target: docType, reason, ip: '10.0.1.1', meta: { docType, versionId } });
    return clone(target);
  }

  async deleteLegalVersion(docType: 'terms' | 'privacy', versionId: string, actor: string, reason: string) {
    await this.ensureLoaded();
    const target = docType === 'terms' ? this.data.legalTerms : this.data.legalPrivacy;
    if (target.versions.length <= 1) throw new Error('Cannot delete the only version');
    if (target.currentVersionId === versionId) throw new Error('Cannot delete the current version');
    target.versions = target.versions.filter((version: any) => version.id !== versionId);
    this.pushAudit({ actor, action: 'legal.delete', target: docType, reason, ip: '10.0.1.1', meta: { docType, versionId } });
    return clone(target);
  }

  async postReply(ticketId: string, body: string, actor: string) {
    await this.ensureLoaded();
    const ticket = this.data.tickets.find((row: any) => row.id === ticketId);
    const reply = { id: `rep_${ticketId}_${(ticket?.replies.length ?? 0) + 1}_${Date.now()}`, author: actor, role: 'admin', message: body, createdAt: new Date().toISOString() };
    if (ticket) {
      ticket.replies.push(reply);
      ticket.updatedAt = reply.createdAt;
    }
    this.pushAudit({ actor, action: 'support.reply', target: ticketId, reason: `Replied to ticket ${ticketId}`, ip: '10.0.1.1', meta: { ticketId, preview: body.slice(0, 80) } });
    return clone(reply);
  }

  async closeTicket(ticketId: string, actor: string, reason: string) {
    await this.ensureLoaded();
    const ticket = this.data.tickets.find((row: any) => row.id === ticketId);
    if (!ticket) throw new Error(`Ticket ${ticketId} not found`);
    ticket.status = 'resolved';
    ticket.updatedAt = new Date().toISOString();
    this.pushAudit({ actor, action: 'support.close', target: ticketId, reason: reason || `Closed ticket ${ticketId}`, ip: '10.0.1.1', meta: { ticketId } });
    return clone(ticket);
  }

  async updateConfigTiers(next: any, actor: string, reason: string) {
    await this.ensureLoaded();
    this.data.configTiers = clone(next);
    this.pushAudit({ actor, action: 'tier.update', target: 'config-tiers', reason: reason || 'Tier configuration updated', ip: '10.0.1.1', meta: { count: Array.isArray(next) ? next.length : 0 } });
    return clone(this.data.configTiers);
  }

  async updateConfigModels(next: any, actor: string, reason: string) {
    await this.ensureLoaded();
    this.data.configModels = clone(next);
    this.pushAudit({ actor, action: 'model.toggle', target: 'config-models', reason: reason || 'Model configuration updated', ip: '10.0.1.1', meta: { count: Array.isArray(next) ? next.length : 0 } });
    return clone(this.data.configModels);
  }

  async createUser(payload: { name: string; email: string; tier: 'free' | 'pro' | 'business'; status: 'active' | 'suspended' | 'grace' }, actor = DEFAULT_ACTOR) {
    await this.ensureLoaded();
    const email = payload.email.trim().toLowerCase();
    if (this.data.users.find((row: any) => row.email.toLowerCase() === email)) throw new Error(`User with email ${payload.email} already exists`);
    const id = `usr_${hash(email).toString(16).padStart(8, '0').slice(0, 8)}`;
    const now = new Date().toISOString();
    const created = { id, name: payload.name.trim(), email, tier: payload.tier, status: payload.status, requestsUsed: 0, requestsLimit: payload.tier === 'free' ? 100 : payload.tier === 'pro' ? 5000 : 25000, tokensSpent: 0, costUsd: 0, lastActiveAt: now, signupDate: now, platform: 'web', mobile: undefined };
    this.data.users.unshift(created);
    this.pushAudit({ actor, action: 'userStatus', target: id, reason: `Created user ${email}`, ip: '10.0.1.1', meta: { email, tier: payload.tier, status: payload.status } });
    return clone(created);
  }

  async setUserStatus(userId: string, status: 'active' | 'suspended' | 'grace', actor: string, reason: string) {
    await this.ensureLoaded();
    const summary = this.data.users.find((row: any) => row.id === userId);
    if (!summary) throw new Error(`User ${userId} not found`);
    const previous = summary.status;
    summary.status = status;
    summary.lastActiveAt = summary.lastActiveAt ?? new Date().toISOString();
    this.pushAudit({ actor, action: 'userStatus', target: userId, reason: reason || `Status changed to ${status}`, ip: '10.0.1.1', meta: { previous, next: status } });
    return clone(summary);
  }

  async grantQuota(userId: string, amount: number, actor: string, reason: string) {
    await this.ensureLoaded();
    if (!Number.isFinite(amount) || amount <= 0) throw new Error('amount must be a positive number');
    const summary = this.data.users.find((row: any) => row.id === userId);
    if (!summary) throw new Error(`User ${userId} not found`);
    const previousLimit = summary.requestsLimit;
    summary.requestsLimit = previousLimit + amount;
    const detail = this.data.userDetail.find((row: any) => row.id === userId);
    const entry = { date: new Date().toISOString(), amount, by: actor, reason: reason || 'No reason provided', newTotal: summary.requestsLimit };
    if (detail) {
      detail.requestsLimit = summary.requestsLimit;
      detail.quotaHistory = [entry, ...(detail.quotaHistory ?? [])];
    } else {
      const fallback = this.data.userDetail.find((row: any) => row.id === userId) ?? this.buildDetail(summary);
      fallback.requestsLimit = summary.requestsLimit;
      fallback.quotaHistory = [entry, ...(fallback.quotaHistory ?? [])];
      if (!this.data.userDetail.find((row: any) => row.id === userId)) this.data.userDetail.push(fallback);
    }
    this.pushAudit({ actor, action: 'quotaOverride', target: userId, reason: reason || `Granted ${amount} tokens`, ip: '10.0.1.1', meta: { amount, previousLimit, newLimit: summary.requestsLimit } });
    return { user: clone(summary), entry: clone(entry) };
  }

  async setQuotaOverride(userId: string, override: { bypassQuota: boolean; customRequestsLimit?: number; customTokensLimit?: number; reason: string; setBy: string; setAt: string }, actor: string) {
    await this.ensureLoaded();
    const summary = this.data.users.find((row: any) => row.id === userId);
    if (!summary) throw new Error(`User ${userId} not found`);
    const detail = this.data.userDetail.find((row: any) => row.id === userId) ?? this.buildDetail(summary);
    if (!this.data.userDetail.find((row: any) => row.id === userId)) this.data.userDetail.push(detail);
    const existing = (detail.quotaHistory ?? []).filter((entry: any) => entry.kind === 'override');
    if (override.bypassQuota) {
      detail.requestsLimit = Number.MAX_SAFE_INTEGER;
    } else if (override.customRequestsLimit != null) {
      detail.requestsLimit = override.customRequestsLimit;
      summary.requestsLimit = override.customRequestsLimit;
    }
    const entry = { ...override, kind: 'override' as const };
    detail.quotaHistory = [entry, ...existing];
    this.pushAudit({ actor, action: 'quotaOverride', target: userId, reason: override.reason, ip: '10.0.1.1', meta: { bypassQuota: override.bypassQuota, customRequestsLimit: override.customRequestsLimit, customTokensLimit: override.customTokensLimit } });
    return { user: clone(summary), override: clone(entry) };
  }

  async resetQuotaOverride(userId: string, actor: string, reason: string) {
    await this.ensureLoaded();
    const summary = this.data.users.find((row: any) => row.id === userId);
    if (!summary) throw new Error(`User ${userId} not found`);
    const detail = this.data.userDetail.find((row: any) => row.id === userId);
    if (detail) {
      detail.quotaHistory = (detail.quotaHistory ?? []).filter((entry: any) => entry.kind !== 'override');
      const defaultLimit = summary.tier === 'free' ? 100 : summary.tier === 'pro' ? 5000 : 25000;
      detail.requestsLimit = defaultLimit;
      summary.requestsLimit = defaultLimit;
    }
    this.pushAudit({ actor, action: 'quotaOverride', target: userId, reason: reason || 'Quota override cleared', ip: '10.0.1.1', meta: { cleared: true } });
    return clone(summary);
  }

  async appendAudit(entry: any) {
    await this.ensureLoaded();
    const row = { id: `aud_${Date.now()}`, ...clone(entry) };
    this.data.audit.unshift(row);
    return clone(row);
  }

  async updateUnitPricing(payload: { requestUnit?: { size: number; priceUsd: number; enabled: boolean }; tokenUnit?: { size: number; priceUsd: number; enabled: boolean }; reason: string }, actor = DEFAULT_ACTOR) {
    await this.ensureLoaded();
    const trimmedReason = payload.reason.trim();
    if (trimmedReason.length < 10) throw new Error('Reason must be at least 10 characters');
    if (!payload.requestUnit && !payload.tokenUnit) throw new Error('At least one unit must be provided');
    const stamp = new Date().toISOString();
    const beforeRequest = this.data.unitPricing.requestUnit;
    const beforeToken = this.data.unitPricing.tokenUnit;
    const nextHistory = [...this.data.unitPricing.history];
    if (payload.requestUnit) {
      if (payload.requestUnit.size <= 0) throw new Error('requestUnit.size must be greater than 0');
      if (payload.requestUnit.priceUsd < 0) throw new Error('requestUnit.priceUsd must be >= 0');
      nextHistory.unshift({ ts: stamp, actor, unit: 'request', before: { size: beforeRequest.size, priceUsd: beforeRequest.priceUsd }, after: { size: payload.requestUnit.size, priceUsd: payload.requestUnit.priceUsd }, reason: trimmedReason });
      this.data.unitPricing.requestUnit = { ...beforeRequest, ...payload.requestUnit, updatedAt: stamp, updatedBy: actor };
    }
    if (payload.tokenUnit) {
      if (payload.tokenUnit.size <= 0) throw new Error('tokenUnit.size must be greater than 0');
      if (payload.tokenUnit.priceUsd < 0) throw new Error('tokenUnit.priceUsd must be >= 0');
      nextHistory.unshift({ ts: stamp, actor, unit: 'token', before: { size: beforeToken.size, priceUsd: beforeToken.priceUsd }, after: { size: payload.tokenUnit.size, priceUsd: payload.tokenUnit.priceUsd }, reason: trimmedReason });
      this.data.unitPricing.tokenUnit = { ...beforeToken, ...payload.tokenUnit, updatedAt: stamp, updatedBy: actor };
    }
    this.data.unitPricing.history = nextHistory;
    this.pushAudit({ actor, action: 'pricing.update', target: 'unit-pricing', reason: trimmedReason, ip: '10.0.1.1', meta: { requestUnit: this.data.unitPricing.requestUnit, tokenUnit: this.data.unitPricing.tokenUnit, requestChanged: Boolean(payload.requestUnit), tokenChanged: Boolean(payload.tokenUnit) } });
    return clone(this.data.unitPricing);
  }

  async reset() { this.loaded = false; this.dir = ''; this.data = null; this.twoFactorCode = null; this.totpSecretValue = ''; }

  private pushAudit(entry: { actor: string; action: string; target: string; reason: string; ip: string; meta?: Record<string, unknown> }) {
    this.data.audit.unshift({ id: `aud_${String(Date.now()).slice(-8)}`, at: new Date().toISOString(), ...entry });
  }

  private buildDetail(summary: any) {
    const totals = Math.max(1, summary.tokensSpent);
    const seed = [...summary.id].reduce((acc, ch) => acc + ch.charCodeAt(0), 0);
    const ticketPool = ['tkt_001', 'tkt_002', 'tkt_003', 'tkt_004', 'tkt_005', 'tkt_006'];
    const count = seed % 4;
    const tickets = count === 0 ? [] : Array.from({ length: count }, (_, index) => ticketPool[(seed + index) % ticketPool.length]!);
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
}

export const adminDashboardStore = new AdminDashboardStore();

