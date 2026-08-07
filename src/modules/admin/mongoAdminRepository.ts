/**
 * MongoDB-backed implementation of `AdminDashboardRepository`.
 *
 * The first time any collection is touched (lazy, on first repo call), we
 * seed it from the JSON fixtures under `backend/src/data/` if it's empty.
 * After that, every read and mutation goes through Mongo, so changes
 * survive process restarts and reflect across instances.
 *
 * The collection layout is one collection per logical store. Singletons
 * (overview, revenue, account, etc.) are stored as `{ _id: 'singleton', ...doc }`
 * docs. Arrays (users, tickets, providers, audit, user details) use the
 * existing string IDs from the fixtures (`usr_rw`, `tkt_001`, `prov_gpt`,
 * `aud_0001`) as their `_id`, which keeps lookups O(1) and preserves the
 * test fixtures' semantics.
 */

import { randomBytes } from 'node:crypto';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Collection, Db, Filter, OptionalUnlessRequiredId, WithId } from 'mongodb';
import {
  AdminStorageUnavailableError,
  type AdminAccount,
  type AdminAuditEntry,
  type AdminDashboardActor,
  type AdminDashboardRepository,
  type AdminLegalDoc,
  type AdminModelConfig,
  type AdminOverviewStats,
  type AdminProfile,
  type AdminProviderHealth,
  type AdminQuotaHistoryEntry,
  type AdminQuotaOverride,
  type AdminRevenueData,
  type AdminSupportReply,
  type AdminTicket,
  type AdminTicketDetail,
  type AdminTierConfig,
  type AdminUnitPricingConfig,
  type AdminUsageData,
  type AdminUsageVisibility,
  type AdminUserDetail,
  type AdminUserSummary,
} from './adminRepository.js';

const SINGLETON_ID = 'singleton';
const DEFAULT_ACTOR = 'admin@oneai.app';

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

type SingletonDoc<T> = T & { _id: string };
type ListDoc<T extends { id: string }> = T & { _id: string };
type TwoFactorState = {
  _id: string;
  email: string;
  code: string;
  expiresAt: number;
  attempts: number;
};
type TotpSecretDoc = { _id: string; value: string };
type SeedMeta = { _id: string; seededAt: string };

export class MongoAdminDashboardRepository implements AdminDashboardRepository {
  private readonly overviewCol: Collection<SingletonDoc<AdminOverviewStats>>;
  private readonly usersCol: Collection<ListDoc<AdminUserSummary>>;
  private readonly userDetailsCol: Collection<ListDoc<AdminUserDetail>>;
  private readonly revenueCol: Collection<SingletonDoc<AdminRevenueData>>;
  private readonly usageCol: Collection<SingletonDoc<AdminUsageData>>;
  private readonly providersCol: Collection<ListDoc<AdminProviderHealth>>;
  private readonly ticketsCol: Collection<ListDoc<AdminTicket>>;
  private readonly ticketDetailCol: Collection<SingletonDoc<Omit<AdminTicketDetail, keyof AdminTicket>>>;
  private readonly configModelsCol: Collection<ListDoc<AdminModelConfig>>;
  private readonly configTiersCol: Collection<ListDoc<AdminTierConfig>>;
  private readonly planDefaultsCol: Collection<ListDoc<AdminTierConfig>>;
  private readonly auditCol: Collection<ListDoc<AdminAuditEntry>>;
  private readonly accountCol: Collection<SingletonDoc<AdminAccount>>;
  private readonly usageVisibilityCol: Collection<SingletonDoc<AdminUsageVisibility>>;
  private readonly legalTermsCol: Collection<SingletonDoc<AdminLegalDoc>>;
  private readonly legalPrivacyCol: Collection<SingletonDoc<AdminLegalDoc>>;
  private readonly unitPricingCol: Collection<SingletonDoc<AdminUnitPricingConfig>>;
  private readonly twoFactorCol: Collection<TwoFactorState>;
  private readonly totpSecretCol: Collection<TotpSecretDoc>;
  private readonly meta: Collection<SeedMeta>;
  private readonly indexesReady: Promise<unknown>;
  private dir = '';
  private totpCached = '';

  constructor(db: Db) {
    this.overviewCol = db.collection<SingletonDoc<AdminOverviewStats>>('admin_overview');
    this.usersCol = db.collection<ListDoc<AdminUserSummary>>('admin_users');
    this.userDetailsCol = db.collection<ListDoc<AdminUserDetail>>('admin_user_details');
    this.revenueCol = db.collection<SingletonDoc<AdminRevenueData>>('admin_revenue');
    this.usageCol = db.collection<SingletonDoc<AdminUsageData>>('admin_usage');
    this.providersCol = db.collection<ListDoc<AdminProviderHealth>>('admin_providers');
    this.ticketsCol = db.collection<ListDoc<AdminTicket>>('admin_tickets');
    this.ticketDetailCol = db.collection<SingletonDoc<Omit<AdminTicketDetail, keyof AdminTicket>>>(
      'admin_ticket_detail',
    );
    this.configModelsCol = db.collection<ListDoc<AdminModelConfig>>('admin_config_models');
    this.configTiersCol = db.collection<ListDoc<AdminTierConfig>>('admin_config_tiers');
    this.planDefaultsCol = db.collection<ListDoc<AdminTierConfig>>('admin_plan_defaults');
    this.auditCol = db.collection<ListDoc<AdminAuditEntry>>('admin_audit');
    this.accountCol = db.collection<SingletonDoc<AdminAccount>>('admin_account');
    this.usageVisibilityCol = db.collection<SingletonDoc<AdminUsageVisibility>>('admin_usage_visibility');
    this.legalTermsCol = db.collection<SingletonDoc<AdminLegalDoc>>('admin_legal_terms');
    this.legalPrivacyCol = db.collection<SingletonDoc<AdminLegalDoc>>('admin_legal_privacy');
    this.unitPricingCol = db.collection<SingletonDoc<AdminUnitPricingConfig>>('admin_unit_pricing');
    this.twoFactorCol = db.collection<TwoFactorState>('admin_two_factor_state');
    this.totpSecretCol = db.collection<TotpSecretDoc>('admin_totp_secret');
    this.meta = db.collection<SeedMeta>('admin_seed_meta');

    this.indexesReady = Promise.all([
      this.usersCol.createIndex({ id: 1 }, { unique: true }),
      this.userDetailsCol.createIndex({ id: 1 }, { unique: true }),
      this.providersCol.createIndex({ id: 1 }, { unique: true }),
      this.ticketsCol.createIndex({ id: 1 }, { unique: true }),
      this.auditCol.createIndex({ id: 1 }, { unique: true }),
      this.configModelsCol.createIndex({ id: 1 }, { unique: true }),
      this.configTiersCol.createIndex({ id: 1 }, { unique: true }),
      this.planDefaultsCol.createIndex({ id: 1 }, { unique: true }),
      this.twoFactorCol.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
      this.meta.createIndex({ _id: 1 }, { unique: true }),
    ]);
  }

  private async ready(): Promise<void> {
    await this.indexesReady;
  }

  /** Seed every collection from the JSON fixtures, but only if it's empty. */
  async seedFromFixturesIfEmpty(dir?: string): Promise<void> {
    await this.ready();
    this.dir = dir ?? (await resolveDataDir());
    const tasks: Array<() => Promise<void>> = [
      () => this.seedSingleton(this.overviewCol, 'overview'),
      () => this.seedList(this.usersCol, 'users'),
      () => this.seedUserDetails(),
      () => this.seedSingleton(this.revenueCol, 'revenue'),
      () => this.seedSingleton(this.usageCol, 'usage'),
      () => this.seedList(this.providersCol, 'providers-health'),
      () => this.seedList(this.ticketsCol, 'support-tickets'),
      () => this.seedSingleton(this.ticketDetailCol, 'ticket-detail'),
      () => this.seedList(this.configModelsCol, 'config-models'),
      () => this.seedList(this.configTiersCol, 'config-tiers'),
      () => this.seedList(this.planDefaultsCol, 'plan-defaults'),
      () => this.seedList(this.auditCol, 'audit'),
      () => this.seedSingleton(this.accountCol, 'admin-account'),
      () => this.seedSingleton(this.usageVisibilityCol, 'usage-visibility'),
      () => this.seedSingleton(this.legalTermsCol, 'legal-terms'),
      () => this.seedSingleton(this.legalPrivacyCol, 'legal-privacy'),
      () => this.seedSingleton(this.unitPricingCol, 'unit-pricing'),
    ];
    for (const task of tasks) await task();
  }

  private async seedSingleton<T>(collection: Collection<SingletonDoc<T>>, fixtureFile: string): Promise<void> {
    const count = await collection.estimatedDocumentCount();
    if (count > 0) return;
    const payload = (await readJson(this.dir, fixtureFile)) as T;
    await collection.insertOne({ _id: SINGLETON_ID, ...(payload as object) } as OptionalUnlessRequiredId<SingletonDoc<T>>);
  }

  private async seedList<T extends { id: string }>(
    collection: Collection<ListDoc<T>>,
    fixtureFile: string,
  ): Promise<void> {
    const count = await collection.estimatedDocumentCount();
    if (count > 0) return;
    const payload = (await readJson(this.dir, fixtureFile)) as T[];
    if (!Array.isArray(payload) || payload.length === 0) return;
    const docs = payload.map((row) => ({ _id: row.id, ...(row as object) })) as OptionalUnlessRequiredId<ListDoc<T>>[];
    await collection.insertMany(docs);
  }

  private async seedUserDetails(): Promise<void> {
    const count = await this.userDetailsCol.estimatedDocumentCount();
    if (count > 0) return;
    const raw = (await readJson(this.dir, 'user-detail')) as AdminUserDetail | AdminUserDetail[];
    const list = Array.isArray(raw) ? raw : [raw];
    if (list.length === 0) return;
    const docs = list.map((row) => ({ _id: row.id, ...(row as object) })) as ListDoc<AdminUserDetail>[];
    await this.userDetailsCol.insertMany(docs);
  }

    private async readSingleton<T>(collection: Collection<SingletonDoc<T>>): Promise<T> {
    await this.ready();
    const filter = { _id: SINGLETON_ID } as unknown as Filter<SingletonDoc<T>>;
    const doc = await collection.findOne(filter);
    if (!doc) {
      // First request after boot — try to seed then re-read.
      await this.seedFromFixturesIfEmpty();
      const seeded = await collection.findOne(filter);
      if (!seeded) throw new AdminStorageUnavailableError(`Admin collection has no singleton document.`);
      return this.stripId(seeded);
    }
    return this.stripId(doc);
  }

  private async findById<T extends { id: string }>(collection: Collection<ListDoc<T>>, id: string): Promise<WithId<ListDoc<T>> | null> {
    await this.ready();
    return collection.findOne({ _id: id } as unknown as Filter<ListDoc<T>>);
  }

  private async writeSingleton<T>(
    collection: Collection<SingletonDoc<T>>,
    value: T,
  ): Promise<T> {
    await this.ready();
    const filter = { _id: SINGLETON_ID } as unknown as Filter<SingletonDoc<T>>;
    await collection.replaceOne(filter, { _id: SINGLETON_ID, ...(value as object) } as SingletonDoc<T>, { upsert: true });
    return value;
  }

  private stripId<T>(doc: WithId<unknown> | unknown): T {
    const { _id: _drop, ...rest } = doc as Record<string, unknown>;
    void _drop;
    return rest as T;
  }

  // -- reads -----------------------------------------------------------------
  async overview(): Promise<AdminOverviewStats> {
    const doc = await this.readSingleton<AdminOverviewStats>(this.overviewCol);
    return doc;
  }
  async users(): Promise<AdminUserSummary[]> {
    await this.ready();
    const docs = await this.usersCol.find().toArray();
    return docs.map((d) => this.stripId<AdminUserSummary>(d));
  }
  async revenue(): Promise<AdminRevenueData> {
    return this.readSingleton(this.revenueCol);
  }
  async usage(): Promise<AdminUsageData> {
    return this.readSingleton(this.usageCol);
  }
  async providers(): Promise<AdminProviderHealth[]> {
    await this.ready();
    const docs = await this.providersCol.find().toArray();
    return docs.map((d) => this.stripId<AdminProviderHealth>(d));
  }
  async tickets(): Promise<AdminTicket[]> {
    await this.ready();
    const docs = await this.ticketsCol.find().toArray();
    return docs.map((d) => this.stripId<AdminTicket>(d));
  }
  async configModels(): Promise<AdminModelConfig[]> {
    await this.ready();
    const docs = await this.configModelsCol.find().toArray();
    return docs.map((d) => this.stripId<AdminModelConfig>(d));
  }
  async configTiers(): Promise<AdminTierConfig[]> {
    await this.ready();
    const docs = await this.configTiersCol.find().toArray();
    return docs.map((d) => this.stripId<AdminTierConfig>(d));
  }
  async planDefaults(): Promise<AdminTierConfig[]> {
    await this.ready();
    const docs = await this.planDefaultsCol.find().toArray();
    return docs.map((d) => this.stripId<AdminTierConfig>(d));
  }
  async audit(): Promise<AdminAuditEntry[]> {
    await this.ready();
    const docs = await this.auditCol.find().sort({ at: -1 }).toArray();
    return docs.map((d) => this.stripId<AdminAuditEntry>(d));
  }
  async account(): Promise<AdminAccount> {
    return this.readSingleton(this.accountCol);
  }
  async usageVisibility(): Promise<AdminUsageVisibility> {
    return this.readSingleton(this.usageVisibilityCol);
  }
  async legalDoc(docType: 'terms' | 'privacy'): Promise<AdminLegalDoc> {
    return docType === 'terms'
      ? this.readSingleton(this.legalTermsCol)
      : this.readSingleton(this.legalPrivacyCol);
  }
  async adminProfile(): Promise<AdminProfile> {
    const acc = await this.account();
    return {
      id: acc.id,
      name: acc.name,
      email: acc.email,
      avatarUrl: acc.avatarUrl,
      lastSignInAt: acc.lastSignInAt,
    };
  }
  async unitPricing(): Promise<AdminUnitPricingConfig> {
    return this.readSingleton(this.unitPricingCol);
  }

  async userDetail(id: string): Promise<AdminUserDetail> {
    await this.ready();
    const doc = await this.findById(this.userDetailsCol, id);
    if (doc) return this.stripId<AdminUserDetail>(doc);
    const summary = await this.findById(this.usersCol, id);
    if (!summary) throw new Error(`User not found: ${id}`);
    return this.buildDetail(this.stripId<AdminUserSummary>(summary));
  }

  async ticketDetail(id: string): Promise<AdminTicketDetail> {
    await this.ready();
    const doc = await this.ticketDetailCol.findOne({ _id: SINGLETON_ID });
    if (!doc) throw new AdminStorageUnavailableError('Ticket detail missing.');
    return { ...this.stripId<Omit<AdminTicketDetail, keyof AdminTicket>>(doc), id } as AdminTicketDetail;
  }

  async ticketReplies(id: string): Promise<AdminSupportReply[]> {
    await this.ready();
    const doc = await this.findById(this.ticketsCol, id);
    if (!doc) return [];
    return doc.replies ?? [];
  }

  async totpSecret(): Promise<{ secret: string; otpauth: string }> {
    await this.ready();
    if (!this.totpCached) {
      const existing = await this.totpSecretCol.findOne({ _id: SINGLETON_ID });
      if (existing) {
        this.totpCached = existing.value;
      } else {
        this.totpCached = generateTotpSecret();
        await this.totpSecretCol.insertOne({ _id: SINGLETON_ID, value: this.totpCached });
      }
    }
    const acc = await this.account();
    const issuer = 'OneAI Admin';
    const label = acc.email;
    return {
      secret: this.totpCached,
      otpauth: `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(label)}?secret=${this.totpCached}&issuer=${encodeURIComponent(issuer)}`,
    };
  }

  // -- mutations -------------------------------------------------------------
  async updateAdminProfile(input: { name: string; actor?: string; reason?: string }): Promise<AdminProfile> {
    const acc = await this.account();
    const previous = { name: acc.name };
    if (typeof input.name === 'string' && input.name.trim().length >= 2) {
      acc.name = input.name.trim();
      await this.writeSingleton(this.accountCol, acc);
    }
    await this.pushAudit({
      actor: input.actor ?? DEFAULT_ACTOR,
      action: 'profile.update',
      target: acc.id,
      reason: input.reason ?? 'Admin profile updated',
      ip: '10.0.1.1',
      meta: { previous, next: { name: acc.name } },
    });
    return this.adminProfile();
  }

  async setProviderStatus(
    providerId: string,
    status: 'operational' | 'degraded' | 'outage' | 'disabled',
    actor: AdminDashboardActor = DEFAULT_ACTOR,
    reason = '',
  ): Promise<AdminProviderHealth> {
    const doc = await this.findById(this.providersCol, providerId);
    if (!doc) throw new Error(`Provider ${providerId} not found`);
    const previous = doc.status;
    await this.providersCol.updateOne({ _id: providerId }, { $set: { status } });
    await this.pushAudit({
      actor,
      action: 'provider.toggle',
      target: providerId,
      reason: reason || `Provider ${providerId} set to ${status}`,
      ip: '10.0.1.1',
      meta: { previous, next: status, providerId },
    });
    const updated = await this.findById(this.providersCol, providerId);
    if (!updated) throw new Error(`Provider ${providerId} disappeared`);
    return this.stripId<AdminProviderHealth>(updated);
  }

  async createUser(
    input: {
      name: string;
      email: string;
      tier: 'free' | 'pro' | 'business';
      status: 'active' | 'suspended' | 'grace';
    },
    actor: AdminDashboardActor = DEFAULT_ACTOR,
  ): Promise<AdminUserSummary> {
    const email = input.email.trim().toLowerCase();
    const existing = await this.usersCol.findOne({ email });
    if (existing) throw new Error(`User with email ${input.email} already exists`);
    const id = `usr_${Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, '0').slice(0, 8)}`;
    const now = new Date().toISOString();
    const created: AdminUserSummary = {
      id,
      name: input.name.trim(),
      email,
      tier: input.tier,
      status: input.status,
      requestsUsed: 0,
      requestsLimit: input.tier === 'free' ? 100 : input.tier === 'pro' ? 5000 : 25000,
      tokensSpent: 0,
      costUsd: 0,
      lastActiveAt: now,
      signupDate: now,
      platform: 'web',
    };
    await this.usersCol.insertOne({ _id: id, ...(created as object) } as ListDoc<AdminUserSummary>);
    await this.pushAudit({
      actor,
      action: 'userStatus',
      target: id,
      reason: `Created user ${email}`,
      ip: '10.0.1.1',
      meta: { email, tier: input.tier, status: input.status },
    });
    return created;
  }

  async setUserStatus(
    userId: string,
    status: 'active' | 'suspended' | 'grace',
    actor: AdminDashboardActor,
    reason: string,
  ): Promise<AdminUserSummary> {
    const doc = await this.findById(this.usersCol, userId);
    if (!doc) throw new Error(`User ${userId} not found`);
    const previous = doc.status;
    await this.usersCol.updateOne(
      { _id: userId } as unknown as Filter<ListDoc<AdminUserSummary>>,
      { $set: { status, lastActiveAt: doc.lastActiveAt ?? new Date().toISOString() } },
    );
    await this.pushAudit({
      actor,
      action: 'userStatus',
      target: userId,
      reason: reason || `Status changed to ${status}`,
      ip: '10.0.1.1',
      meta: { previous, next: status },
    });
    const updated = await this.findById(this.usersCol, userId);
    if (!updated) throw new Error(`User ${userId} disappeared`);
    return this.stripId<AdminUserSummary>(updated);
  }

  async grantQuota(
    userId: string,
    amount: number,
    actor: AdminDashboardActor,
    reason: string,
  ): Promise<{ user: AdminUserSummary; entry: AdminQuotaHistoryEntry }> {
    if (!Number.isFinite(amount) || amount <= 0) throw new Error('amount must be a positive number');
    const summary = await this.findById(this.usersCol, userId);
    if (!summary) throw new Error(`User ${userId} not found`);
    const previousLimit = summary.requestsLimit;
    const newLimit = previousLimit + amount;
    await this.usersCol.updateOne({ _id: userId } as unknown as Filter<ListDoc<AdminUserSummary>>, { $set: { requestsLimit: newLimit } });
    const entry: AdminQuotaHistoryEntry = {
      date: new Date().toISOString(),
      amount,
      by: actor,
      reason: reason || 'No reason provided',
      newTotal: newLimit,
    };
    let detail = await this.userDetailsCol.findOne({ _id: userId } as unknown as Filter<ListDoc<AdminUserDetail>>);
    if (!detail) {
      detail = { _id: userId, ...(this.buildDetail(this.stripId<AdminUserSummary>(summary)) as object) } as ListDoc<AdminUserDetail>;
      await this.userDetailsCol.insertOne(detail);
    } else {
      const newHistory = [entry, ...(detail.quotaHistory ?? [])];
      await this.userDetailsCol.updateOne(
        { _id: userId } as unknown as Filter<ListDoc<AdminUserDetail>>,
        { $set: { requestsLimit: newLimit, quotaHistory: newHistory } },
      );
    }
    await this.pushAudit({
      actor,
      action: 'quotaOverride',
      target: userId,
      reason: reason || `Granted ${amount} tokens`,
      ip: '10.0.1.1',
      meta: { amount, previousLimit, newLimit },
    });
    const updated = await this.findById(this.usersCol, userId);
    if (!updated) throw new Error(`User ${userId} disappeared`);
    return { user: this.stripId<AdminUserSummary>(updated), entry };
  }

  async setQuotaOverride(
    userId: string,
    override: Omit<AdminQuotaOverride, 'setAt'>,
    actor: AdminDashboardActor,
  ): Promise<{ user: AdminUserSummary; override: AdminQuotaOverride }> {
    const summary = await this.findById(this.usersCol, userId);
    if (!summary) throw new Error(`User ${userId} not found`);
    let detail = await this.findById(this.userDetailsCol, userId);
    if (!detail) {
      const built = this.buildDetail(this.stripId<AdminUserSummary>(summary));
      detail = { _id: userId, ...built } as unknown as WithId<ListDoc<AdminUserDetail>>;
      await this.userDetailsCol.insertOne(detail as ListDoc<AdminUserDetail>);
    }
    const existing = (detail.quotaHistory ?? []).filter(
      (entry) => (entry as { kind?: string }).kind === 'override',
    );
    const newLimit = override.bypassQuota
      ? Number.MAX_SAFE_INTEGER
      : override.customRequestsLimit ?? summary.requestsLimit;
    const entry: AdminQuotaOverride & { kind: 'override' } = {
      ...override,
      setAt: new Date().toISOString(),
      kind: 'override',
    };
    const newHistory = [entry, ...existing];
    await this.userDetailsCol.updateOne(
      { _id: userId },
      { $set: { requestsLimit: newLimit, quotaHistory: newHistory } },
    );
    if (!override.bypassQuota && override.customRequestsLimit != null) {
      await this.usersCol.updateOne({ _id: userId } as unknown as Filter<ListDoc<AdminUserSummary>>, { $set: { requestsLimit: override.customRequestsLimit } });
    }
    await this.pushAudit({
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
    const updated = await this.findById(this.usersCol, userId);
    if (!updated) throw new Error(`User ${userId} disappeared`);
    return { user: this.stripId<AdminUserSummary>(updated), override: entry };
  }

  async resetQuotaOverride(
    userId: string,
    actor: AdminDashboardActor,
    reason: string,
  ): Promise<AdminUserSummary> {
    const summary = await this.findById(this.usersCol, userId);
    if (!summary) throw new Error(`User ${userId} not found`);
    const detail = await this.findById(this.userDetailsCol, userId);
    if (detail) {
      const filtered = (detail.quotaHistory ?? []).filter(
        (entry) => (entry as { kind?: string }).kind !== 'override',
      );
      const defaultLimit = summary.tier === 'free' ? 100 : summary.tier === 'pro' ? 5000 : 25000;
      await this.userDetailsCol.updateOne(
        { _id: userId },
        { $set: { requestsLimit: defaultLimit, quotaHistory: filtered } },
      );
      await this.usersCol.updateOne({ _id: userId } as unknown as Filter<ListDoc<AdminUserSummary>>, { $set: { requestsLimit: defaultLimit } });
    }
    await this.pushAudit({
      actor,
      action: 'quotaOverride',
      target: userId,
      reason: reason || 'Quota override cleared',
      ip: '10.0.1.1',
      meta: { cleared: true },
    });
    const updated = await this.findById(this.usersCol, userId);
    if (!updated) throw new Error(`User ${userId} disappeared`);
    return this.stripId<AdminUserSummary>(updated);
  }

  async appendAudit(entry: Omit<AdminAuditEntry, 'id'>): Promise<AdminAuditEntry> {
    return this.pushAudit(entry);
  }

  async postReply(ticketId: string, body: string, actor: AdminDashboardActor): Promise<AdminSupportReply> {
    const ticket = await this.findById(this.ticketsCol, ticketId);
    const reply: AdminSupportReply = {
      id: `rep_${ticketId}_${(ticket?.replies.length ?? 0) + 1}_${Date.now()}`,
      author: actor,
      role: 'admin',
      message: body,
      createdAt: new Date().toISOString(),
    };
    if (ticket) {
      const replies = [...(ticket.replies ?? []), reply];
      await this.ticketsCol.updateOne(
        { _id: ticketId },
        { $set: { replies, updatedAt: reply.createdAt } },
      );
    }
    await this.pushAudit({
      actor,
      action: 'support.reply',
      target: ticketId,
      reason: `Replied to ticket ${ticketId}`,
      ip: '10.0.1.1',
      meta: { ticketId, preview: body.slice(0, 80) },
    });
    return reply;
  }

  async closeTicket(ticketId: string, actor: AdminDashboardActor, reason: string): Promise<AdminTicket> {
    const ticket = await this.findById(this.ticketsCol, ticketId);
    if (!ticket) throw new Error(`Ticket ${ticketId} not found`);
    const updated: AdminTicket = {
      ...this.stripId<AdminTicket>(ticket),
      status: 'resolved',
      updatedAt: new Date().toISOString(),
    };
    await this.ticketsCol.replaceOne({ _id: ticketId }, { _id: ticketId, ...(updated as object) } as ListDoc<AdminTicket>);
    await this.pushAudit({
      actor,
      action: 'support.close',
      target: ticketId,
      reason: reason || `Closed ticket ${ticketId}`,
      ip: '10.0.1.1',
      meta: { ticketId },
    });
    return updated;
  }

  async updateConfigTiers(
    next: AdminTierConfig[],
    actor: AdminDashboardActor,
    reason: string,
  ): Promise<AdminTierConfig[]> {
    await this.configTiersCol.deleteMany({});
    if (next.length > 0) {
      await this.configTiersCol.insertMany(
        next.map((row) => ({ _id: row.id, ...(row as object) })) as ListDoc<AdminTierConfig>[],
      );
    }
    await this.pushAudit({
      actor,
      action: 'tier.update',
      target: 'config-tiers',
      reason: reason || 'Tier configuration updated',
      ip: '10.0.1.1',
      meta: { count: next.length },
    });
    return next;
  }

  async updateConfigModels(
    next: AdminModelConfig[],
    actor: AdminDashboardActor,
    reason: string,
  ): Promise<AdminModelConfig[]> {
    await this.configModelsCol.deleteMany({});
    if (next.length > 0) {
      await this.configModelsCol.insertMany(
        next.map((row) => ({ _id: row.id, ...(row as object) })) as ListDoc<AdminModelConfig>[],
      );
    }
    await this.pushAudit({
      actor,
      action: 'model.toggle',
      target: 'config-models',
      reason: reason || 'Model configuration updated',
      ip: '10.0.1.1',
      meta: { count: next.length },
    });
    return next;
  }

  async saveLegalVersion(
    docType: 'terms' | 'privacy',
    payload: { body: string; summary: string; createdBy: string; reason: string },
  ): Promise<AdminLegalDoc> {
    const collection = docType === 'terms' ? this.legalTermsCol : this.legalPrivacyCol;
    const doc = await this.readSingleton<AdminLegalDoc>(collection);
    const nextId = `v${doc.versions.length + 1}`;
    const next: AdminLegalDoc = {
      ...doc,
      currentVersionId: nextId,
      versions: [
        ...doc.versions,
        {
          id: nextId,
          bodyMarkdown: payload.body,
          summary: payload.summary,
          createdAt: new Date().toISOString(),
          createdBy: payload.createdBy,
        },
      ],
    };
    await this.writeSingleton(collection, next);
    await this.pushAudit({
      actor: payload.createdBy,
      action: 'legal.publish',
      target: docType,
      reason: payload.reason,
      ip: '10.0.1.1',
      meta: { docType, versionId: nextId },
    });
    return next;
  }

  async restoreLegalVersion(
    docType: 'terms' | 'privacy',
    versionId: string,
    actor: AdminDashboardActor,
    reason: string,
  ): Promise<AdminLegalDoc> {
    const collection = docType === 'terms' ? this.legalTermsCol : this.legalPrivacyCol;
    const doc = await this.readSingleton<AdminLegalDoc>(collection);
    if (!doc.versions.find((version) => version.id === versionId)) {
      throw new Error(`Version ${versionId} not found in ${docType}`);
    }
    const next = { ...doc, currentVersionId: versionId };
    await this.writeSingleton(collection, next);
    await this.pushAudit({
      actor,
      action: 'legal.restore',
      target: docType,
      reason,
      ip: '10.0.1.1',
      meta: { docType, versionId },
    });
    return next;
  }

  async deleteLegalVersion(
    docType: 'terms' | 'privacy',
    versionId: string,
    actor: AdminDashboardActor,
    reason: string,
  ): Promise<AdminLegalDoc> {
    const collection = docType === 'terms' ? this.legalTermsCol : this.legalPrivacyCol;
    const doc = await this.readSingleton<AdminLegalDoc>(collection);
    if (doc.versions.length <= 1) throw new Error('Cannot delete the only version');
    if (doc.currentVersionId === versionId) throw new Error('Cannot delete the current version');
    const next = { ...doc, versions: doc.versions.filter((version) => version.id !== versionId) };
    await this.writeSingleton(collection, next);
    await this.pushAudit({
      actor,
      action: 'legal.delete',
      target: docType,
      reason,
      ip: '10.0.1.1',
      meta: { docType, versionId },
    });
    return next;
  }

  async setUsageVisibility(
    next: AdminUsageVisibility,
    actor: AdminDashboardActor = DEFAULT_ACTOR,
  ): Promise<AdminUsageVisibility> {
    await this.writeSingleton(this.usageVisibilityCol, next);
    await this.pushAudit({
      actor,
      action: 'usage.toggle',
      target: 'usage-visibility',
      reason: `Customer usage dashboard ${next?.enabled ? 'enabled' : 'disabled'}`,
      ip: '10.0.1.1',
      meta: next as Record<string, unknown>,
    });
    return next;
  }

  async updateUnitPricing(
    payload: {
      requestUnit?: { size: number; priceUsd: number; enabled: boolean };
      tokenUnit?: { size: number; priceUsd: number; enabled: boolean };
      reason: string;
    },
    actor: AdminDashboardActor = DEFAULT_ACTOR,
  ): Promise<AdminUnitPricingConfig> {
    const trimmedReason = payload.reason.trim();
    if (trimmedReason.length < 10) throw new Error('Reason must be at least 10 characters');
    if (!payload.requestUnit && !payload.tokenUnit) throw new Error('At least one unit must be provided');
    const current = await this.unitPricing();
    const stamp = new Date().toISOString();
    const history = [...current.history];
    const next: AdminUnitPricingConfig = {
      requestUnit: { ...current.requestUnit },
      tokenUnit: { ...current.tokenUnit },
      history,
    };
    if (payload.requestUnit) {
      if (payload.requestUnit.size <= 0) throw new Error('requestUnit.size must be greater than 0');
      if (payload.requestUnit.priceUsd < 0) throw new Error('requestUnit.priceUsd must be >= 0');
      history.unshift({
        ts: stamp,
        actor,
        unit: 'request',
        before: { size: current.requestUnit.size, priceUsd: current.requestUnit.priceUsd },
        after: { size: payload.requestUnit.size, priceUsd: payload.requestUnit.priceUsd },
        reason: trimmedReason,
      });
      next.requestUnit = {
        ...current.requestUnit,
        ...payload.requestUnit,
        updatedAt: stamp,
        updatedBy: actor,
      };
    }
    if (payload.tokenUnit) {
      if (payload.tokenUnit.size <= 0) throw new Error('tokenUnit.size must be greater than 0');
      if (payload.tokenUnit.priceUsd < 0) throw new Error('tokenUnit.priceUsd must be >= 0');
      history.unshift({
        ts: stamp,
        actor,
        unit: 'token',
        before: { size: current.tokenUnit.size, priceUsd: current.tokenUnit.priceUsd },
        after: { size: payload.tokenUnit.size, priceUsd: payload.tokenUnit.priceUsd },
        reason: trimmedReason,
      });
      next.tokenUnit = {
        ...current.tokenUnit,
        ...payload.tokenUnit,
        updatedAt: stamp,
        updatedBy: actor,
      };
    }
    await this.writeSingleton(this.unitPricingCol, next);
    await this.pushAudit({
      actor,
      action: 'pricing.update',
      target: 'unit-pricing',
      reason: trimmedReason,
      ip: '10.0.1.1',
      meta: {
        requestUnit: next.requestUnit,
        tokenUnit: next.tokenUnit,
        requestChanged: Boolean(payload.requestUnit),
        tokenChanged: Boolean(payload.tokenUnit),
      },
    });
    return next;
  }

  async setTotpEnabled(enabled: boolean, actor: AdminDashboardActor = DEFAULT_ACTOR): Promise<AdminAccount> {
    const acc = await this.account();
    acc.totpEnabled = enabled;
    await this.writeSingleton(this.accountCol, acc);
    await this.pushAudit({
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
    const code = String(Math.floor(100000 + Math.random() * 900000));
    await this.twoFactorCol.replaceOne(
      { _id: SINGLETON_ID },
      {
        email: payload.email,
        code,
        expiresAt: Date.now() + 10 * 60 * 1000,
        attempts: 0,
      },
      { upsert: true },
    );
    await this.pushAudit({
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
    const pending = await this.twoFactorCol.findOne({ _id: SINGLETON_ID });
    if (!pending || pending.email !== payload.email || Date.now() > pending.expiresAt) {
      await this.twoFactorCol.deleteOne({ _id: SINGLETON_ID });
      return { ok: false, reason: 'expired' };
    }
    if (pending.attempts >= 5) {
      await this.twoFactorCol.deleteOne({ _id: SINGLETON_ID });
      return { ok: false, reason: 'too-many-attempts' };
    }
    if (pending.code !== payload.code) {
      const next = pending.attempts + 1;
      if (next >= 5) {
        await this.twoFactorCol.deleteOne({ _id: SINGLETON_ID });
        return { ok: false, reason: 'too-many-attempts' };
      }
      await this.twoFactorCol.updateOne({ _id: SINGLETON_ID }, { $set: { attempts: next } });
      return { ok: false, reason: 'mismatch' };
    }
    const acc = await this.account();
    acc.twoFactor = { email: payload.email, verified: true };
    await this.writeSingleton(this.accountCol, acc);
    await this.twoFactorCol.deleteOne({ _id: SINGLETON_ID });
    await this.pushAudit({
      actor,
      action: 'twoFactor.verified',
      target: payload.email,
      reason: 'Two-factor email verified',
      ip: '10.0.1.1',
      meta: { email: payload.email },
    });
    return { ok: true };
  }

  async setTwoFactorEmail(
    payload: { email: string },
    actor: AdminDashboardActor = DEFAULT_ACTOR,
  ): Promise<AdminAccount> {
    const acc = await this.account();
    acc.twoFactor = { email: payload.email, verified: false };
    await this.writeSingleton(this.accountCol, acc);
    await this.twoFactorCol.deleteOne({ _id: SINGLETON_ID });
    await this.pushAudit({
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
    const acc = await this.account();
    acc.twoFactor = { email: acc.twoFactor.email, verified: false };
    await this.writeSingleton(this.accountCol, acc);
    await this.twoFactorCol.deleteOne({ _id: SINGLETON_ID });
    await this.pushAudit({
      actor,
      action: 'twoFactor.disabled',
      target: 'admin.twoFactor',
      reason: 'Two-factor authentication disabled',
      ip: '10.0.1.1',
      meta: { email: acc.twoFactor.email },
    });
    return this.account();
  }

  async revokeSession(sessionId: string, actor: AdminDashboardActor = DEFAULT_ACTOR): Promise<AdminAccount> {
    const acc = await this.account();
    const remaining = acc.sessions.filter((session) => session.id !== sessionId);
    const next = { ...acc, sessions: remaining };
    await this.writeSingleton(this.accountCol, next);
    await this.pushAudit({
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
    const acc = await this.account();
    const remaining = acc.sessions.filter((session) => session.current);
    const removed = acc.sessions.length - remaining.length;
    await this.writeSingleton(this.accountCol, { ...acc, sessions: remaining });
    await this.pushAudit({
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
    // No-op for the Mongo implementation — use `db.dropDatabase()` externally.
    this.totpCached = '';
  }

  // -- internals -------------------------------------------------------------
  private async pushAudit(entry: Omit<AdminAuditEntry, 'id' | 'at'>): Promise<AdminAuditEntry> {
    const row: AdminAuditEntry = {
      id: `aud_${String(Date.now()).slice(-8)}_${Math.floor(Math.random() * 0xffff).toString(16)}`,
      at: new Date().toISOString(),
      ...entry,
    };
    await this.auditCol.insertOne({ _id: row.id, ...(row as object) } as ListDoc<AdminAuditEntry>);
    return row;
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
}