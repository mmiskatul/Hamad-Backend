import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AuthRepository } from '../modules/auth/authRepository.js';
import { MongoAuthRepository } from '../modules/auth/mongoAuthRepository.js';
import { SessionError, SessionService } from '../modules/auth/sessionService.js';
import { env } from '../config/env.js';
import { AdminDashboardStore } from '../modules/admin/dashboardStore.js';
import { MongoAdminDashboardRepository } from '../modules/admin/mongoAdminRepository.js';
import { MemoryAdminDashboardRepository } from '../modules/admin/memoryAdminRepository.js';
import { AdminStorageUnavailableError, type AdminDashboardRepository } from '../modules/admin/adminRepository.js';
import { ConsoleEmailSender } from '../modules/email/emailSender.js';
import type { EmailSender } from '../modules/email/emailSender.js';
import { SmtpEmailSender } from '../modules/email/smtpEmailSender.js';

type AdminRouteOptions = {
  authRepository?: AuthRepository;
  emailSender?: EmailSender;
  adminRepository?: AdminDashboardRepository;
};
type Claims = { sub: string; sid: string };

export async function adminDashboardRoutes(app: FastifyInstance, options: AdminRouteOptions) {
  let repository: AuthRepository | undefined;
  const auth = () => {
    repository ??=
      options.authRepository ?? (app.mongo?.db
        ? new MongoAuthRepository(app.mongo.db)
        : new MongoAuthRepository(app.mongo.client.db(env.mongoDatabase)));
    return repository;
  };

  let emailer: EmailSender | undefined;
  const getEmailer = (): EmailSender => {
    emailer ??= options.emailSender ?? buildDefaultEmailSender();
    return emailer;
  };

  let sessions: SessionService | undefined;
  const getSessions = () => {
    sessions ??= new SessionService(auth(), env.jwtSecret, env.sessionExpiresDays);
    return sessions;
  };

  // Prefer the injected repo (tests use this). Production wires a Mongo repo;
  // when neither is present we fall back to a memory repo so dev with no
  // Mongo still works.
  let adminRepo: AdminDashboardRepository | undefined = options.adminRepository;
  const getAdminRepo = (): AdminDashboardRepository => {
    if (adminRepo) return adminRepo;
    if (app.mongo?.db) {
      adminRepo = new MongoAdminDashboardRepository(app.mongo.db);
    } else {
      adminRepo = new MemoryAdminDashboardRepository();
    }
    return adminRepo;
  };
  const store = new AdminDashboardStore(getAdminRepo());

  const requireAdmin = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      await request.jwtVerify();
      const claims = request.user as Claims;
      await getSessions().assertActive(claims.sub, claims.sid);
      const user = await auth().findUserById(claims.sub);
      if (!user || user.role !== 'admin') {
        return reply.code(403).send({ error: { code: 'ADMIN_ACCESS_REQUIRED', message: 'Administrator access is required.' } });
      }
    } catch (error) {
      if (error instanceof SessionError) {
        return reply.code(401).send({ error: { code: error.code, message: error.message } });
      }
      throw error;
    }
  };

  /** Wrap a handler so Mongo errors surface as 503 instead of 500. */
  const withStorageGuard = (handler: (request: FastifyRequest) => Promise<unknown>) =>
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        return await handler(request);
      } catch (error) {
        if (error instanceof AdminStorageUnavailableError) {
          return reply.code(503).send({
            error: { code: error.code, message: error.message },
          });
        }
        throw error;
      }
    };

  app.get('/admin/overview', { onRequest: requireAdmin }, withStorageGuard(async () => store.overview()));
  app.get('/admin/users', { onRequest: requireAdmin }, withStorageGuard(async () => store.users()));
  app.get<{ Params: { id: string } }>('/admin/users/:id', { onRequest: requireAdmin }, withStorageGuard(async (request) => store.userDetail((request.params as { id: string }).id)));
  app.get('/admin/revenue', { onRequest: requireAdmin }, withStorageGuard(async () => store.revenue()));
  app.get('/admin/usage', { onRequest: requireAdmin }, withStorageGuard(async () => store.usage()));
  app.get('/admin/providers-health', { onRequest: requireAdmin }, withStorageGuard(async () => store.providers()));

  app.patch<{ Params: { id: string } }>('/admin/providers/:id/status', { onRequest: requireAdmin }, async (request, reply) => {
    const body = request.body as { status?: 'operational' | 'degraded' | 'outage' | 'disabled'; actor?: string; reason?: string };
    if (!body.status || !['operational', 'degraded', 'outage', 'disabled'].includes(body.status)) {
      return reply.code(400).send({ error: { code: 'INVALID_PAYLOAD', message: 'status must be one of operational, degraded, outage, disabled.' } });
    }
    try {
      return await store.setProviderStatus(
        request.params.id,
        body.status,
        body.actor ?? 'admin@oneai.app',
        body.reason ?? '',
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to update provider status.';
      return reply.code(404).send({ error: { code: 'PROVIDER_NOT_FOUND', message } });
    }
  });
  app.get('/admin/tickets', { onRequest: requireAdmin }, withStorageGuard(async () => store.tickets()));
  app.get<{ Params: { id: string } }>('/admin/tickets/:id', { onRequest: requireAdmin }, withStorageGuard(async (request) => store.ticketDetail((request.params as { id: string }).id)));
  app.get<{ Params: { id: string } }>('/admin/tickets/:id/replies', { onRequest: requireAdmin }, withStorageGuard(async (request) => store.ticketReplies((request.params as { id: string }).id)));
  app.get('/admin/config/models', { onRequest: requireAdmin }, withStorageGuard(async () => store.configModels()));
  app.get('/admin/config/tiers', { onRequest: requireAdmin }, withStorageGuard(async () => store.configTiers()));
  app.get('/admin/plan-defaults', { onRequest: requireAdmin }, withStorageGuard(async () => store.planDefaults()));
  app.get('/admin/audit', { onRequest: requireAdmin }, withStorageGuard(async () => store.audit()));
  app.get('/admin/account', { onRequest: requireAdmin }, withStorageGuard(async () => store.account()));
  app.get('/admin/usage-visibility', { onRequest: requireAdmin }, withStorageGuard(async () => store.usageVisibility()));
  app.get('/admin/legal/terms', { onRequest: requireAdmin }, withStorageGuard(async () => store.legalDoc('terms')));
  app.get('/admin/legal/privacy', { onRequest: requireAdmin }, withStorageGuard(async () => store.legalDoc('privacy')));
  app.get('/admin/profile', { onRequest: requireAdmin }, withStorageGuard(async () => store.adminProfile()));
  app.patch('/admin/profile', { onRequest: requireAdmin }, async (request, reply) => {
    const body = request.body as { name?: string; actor?: string; reason?: string };
    if (!body.name || typeof body.name !== 'string' || body.name.trim().length < 2) {
      return reply.code(400).send({ error: { code: 'INVALID_PAYLOAD', message: 'name must be at least 2 characters.' } });
    }
    try {
      return await store.updateAdminProfile({ name: body.name, actor: body.actor, reason: body.reason });
    } catch (error) {
      if (error instanceof AdminStorageUnavailableError) {
        return reply.code(503).send({ error: { code: error.code, message: error.message } });
      }
      throw error;
    }
  });
  app.get('/admin/totp-secret', { onRequest: requireAdmin }, withStorageGuard(async () => store.totpSecret()));
  app.get('/admin/unit-pricing', { onRequest: requireAdmin }, withStorageGuard(async () => store.unitPricing()));

  app.post('/admin/totp-enabled', { onRequest: requireAdmin }, async (request, reply) => {
    const body = request.body as { enabled?: boolean; actor?: string };
    if (typeof body.enabled !== 'boolean') {
      return reply.code(400).send({ error: { code: 'INVALID_PAYLOAD', message: 'enabled is required.' } });
    }
    try {
      return await store.setTotpEnabled(body.enabled, body.actor);
    } catch (error) {
      if (error instanceof AdminStorageUnavailableError) {
        return reply.code(503).send({ error: { code: error.code, message: error.message } });
      }
      throw error;
    }
  });

  app.post('/admin/two-factor/code', { onRequest: requireAdmin }, async (request, reply) => {
    const body = request.body as { email?: string };
    if (!body.email) return reply.code(400).send({ error: { code: 'INVALID_PAYLOAD', message: 'Email is required.' } });
    try {
      return await store.sendTwoFactorCode({ email: body.email });
    } catch (error) {
      if (error instanceof AdminStorageUnavailableError) {
        return reply.code(503).send({ error: { code: error.code, message: error.message } });
      }
      throw error;
    }
  });

  app.post('/admin/two-factor/verify', { onRequest: requireAdmin }, async (request, reply) => {
    const body = request.body as { email?: string; code?: string };
    if (!body.email || !body.code) {
      return reply.code(400).send({ error: { code: 'INVALID_PAYLOAD', message: 'Email and code are required.' } });
    }
    try {
      return await store.verifyTwoFactorCode({ email: body.email, code: body.code });
    } catch (error) {
      if (error instanceof AdminStorageUnavailableError) {
        return reply.code(503).send({ error: { code: error.code, message: error.message } });
      }
      throw error;
    }
  });

  app.post('/admin/two-factor/email', { onRequest: requireAdmin }, async (request, reply) => {
    const body = request.body as { email?: string };
    if (!body.email) return reply.code(400).send({ error: { code: 'INVALID_PAYLOAD', message: 'Email is required.' } });
    try {
      return await store.setTwoFactorEmail({ email: body.email });
    } catch (error) {
      if (error instanceof AdminStorageUnavailableError) {
        return reply.code(503).send({ error: { code: error.code, message: error.message } });
      }
      throw error;
    }
  });

  app.post('/admin/two-factor/disable', { onRequest: requireAdmin }, async () => {
    try {
      return await store.disableTwoFactor();
    } catch (error) {
      if (error instanceof AdminStorageUnavailableError) {
        return { error: { code: error.code, message: error.message } };
      }
      throw error;
    }
  });

  app.delete<{ Params: { sessionId: string } }>('/admin/sessions/:sessionId', { onRequest: requireAdmin }, async (request, reply) => {
    try {
      return await store.revokeSession(request.params.sessionId);
    } catch (error) {
      if (error instanceof AdminStorageUnavailableError) {
        return reply.code(503).send({ error: { code: error.code, message: error.message } });
      }
      throw error;
    }
  });

  app.post('/admin/sessions/revoke-others', { onRequest: requireAdmin }, async (request, reply) => {
    try {
      return { revoked: await store.revokeAllOtherSessions() };
    } catch (error) {
      if (error instanceof AdminStorageUnavailableError) {
        return reply.code(503).send({ error: { code: error.code, message: error.message } });
      }
      throw error;
    }
  });

  app.patch('/admin/usage-visibility', { onRequest: requireAdmin }, async (request, reply) => {
    try {
      return await store.setUsageVisibility(request.body as never);
    } catch (error) {
      if (error instanceof AdminStorageUnavailableError) {
        return reply.code(503).send({ error: { code: error.code, message: error.message } });
      }
      throw error;
    }
  });

  app.post('/admin/legal/:docType/versions', { onRequest: requireAdmin }, async (request, reply) => {
    const body = request.body as { body?: string; summary?: string; createdBy?: string; reason?: string };
    const params = request.params as { docType: 'terms' | 'privacy' };
    if (!body.body || !body.summary || !body.createdBy || !body.reason) {
      return reply.code(400).send({ error: { code: 'INVALID_PAYLOAD', message: 'Body, summary, createdBy, and reason are required.' } });
    }
    try {
      return await store.saveLegalVersion(params.docType, {
        body: body.body,
        summary: body.summary,
        createdBy: body.createdBy,
        reason: body.reason,
      });
    } catch (error) {
      if (error instanceof AdminStorageUnavailableError) {
        return reply.code(503).send({ error: { code: error.code, message: error.message } });
      }
      throw error;
    }
  });

  app.post('/admin/legal/:docType/versions/:versionId/restore', { onRequest: requireAdmin }, async (request, reply) => {
    const body = request.body as { actor?: string; reason?: string };
    const params = request.params as { docType: 'terms' | 'privacy'; versionId: string };
    try {
      return await store.restoreLegalVersion(
        params.docType,
        params.versionId,
        body.actor ?? 'admin@oneai.app',
        body.reason ?? 'Restore legal version',
      );
    } catch (error) {
      if (error instanceof AdminStorageUnavailableError) {
        return reply.code(503).send({ error: { code: error.code, message: error.message } });
      }
      throw error;
    }
  });

  app.delete('/admin/legal/:docType/versions/:versionId', { onRequest: requireAdmin }, async (request, reply) => {
    const body = request.body as { actor?: string; reason?: string };
    const params = request.params as { docType: 'terms' | 'privacy'; versionId: string };
    try {
      return await store.deleteLegalVersion(
        params.docType,
        params.versionId,
        body.actor ?? 'admin@oneai.app',
        body.reason ?? 'Delete legal version',
      );
    } catch (error) {
      if (error instanceof AdminStorageUnavailableError) {
        return reply.code(503).send({ error: { code: error.code, message: error.message } });
      }
      throw error;
    }
  });

  app.post('/admin/tickets/:ticketId/replies', { onRequest: requireAdmin }, async (request, reply) => {
    const body = request.body as { body?: string; actor?: string; notifyUser?: boolean };
    const params = request.params as { ticketId: string };
    if (!body.body) return reply.code(400).send({ error: { code: 'INVALID_PAYLOAD', message: 'Reply body is required.' } });
    let replyRecord;
    try {
      replyRecord = await store.postReply(params.ticketId, body.body, body.actor ?? 'admin@oneai.app');
    } catch (error) {
      if (error instanceof AdminStorageUnavailableError) {
        return reply.code(503).send({ error: { code: error.code, message: error.message } });
      }
      throw error;
    }
    if (body.notifyUser !== false) {
      const ticket = (await store.tickets()).find((row: any) => row.id === params.ticketId);
      if (ticket?.userEmail) {
        try {
          await getEmailer().sendSupportReply?.({
            to: ticket.userEmail,
            subject: `Update on your support ticket: ${ticket.subject}`,
            message: body.body,
          });
        } catch (error) {
          request.log.warn(
            { err: error, ticketId: params.ticketId },
            'support reply email failed; reply persisted',
          );
        }
      }
    }
    return replyRecord;
  });

  app.post('/admin/tickets/:ticketId/close', { onRequest: requireAdmin }, async (request, reply) => {
    const body = request.body as { actor?: string; reason?: string };
    const params = request.params as { ticketId: string };
    try {
      return await store.closeTicket(params.ticketId, body.actor ?? 'admin@oneai.app', body.reason ?? 'Closed by admin');
    } catch (error) {
      if (error instanceof AdminStorageUnavailableError) {
        return reply.code(503).send({ error: { code: error.code, message: error.message } });
      }
      throw error;
    }
  });

  app.patch('/admin/config/tiers', { onRequest: requireAdmin }, async (request, reply) => {
    const body = request.body as { tiers?: unknown; actor?: string; reason?: string };
    try {
      return await store.updateConfigTiers(body.tiers as never, body.actor ?? 'admin@oneai.app', body.reason ?? 'Updated tiers');
    } catch (error) {
      if (error instanceof AdminStorageUnavailableError) {
        return reply.code(503).send({ error: { code: error.code, message: error.message } });
      }
      throw error;
    }
  });

  app.patch('/admin/config/models', { onRequest: requireAdmin }, async (request, reply) => {
    const body = request.body as { models?: unknown; actor?: string; reason?: string };
    try {
      return await store.updateConfigModels(body.models as never, body.actor ?? 'admin@oneai.app', body.reason ?? 'Updated models');
    } catch (error) {
      if (error instanceof AdminStorageUnavailableError) {
        return reply.code(503).send({ error: { code: error.code, message: error.message } });
      }
      throw error;
    }
  });

  app.post('/admin/users', { onRequest: requireAdmin }, async (request, reply) => {
    const body = request.body as { name?: string; email?: string; tier?: 'free' | 'pro' | 'business'; status?: 'active' | 'suspended' | 'grace'; actor?: string };
    if (!body.name || !body.email || !body.tier || !body.status) {
      return reply.code(400).send({ error: { code: 'INVALID_PAYLOAD', message: 'name, email, tier, and status are required.' } });
    }
    try {
      return await store.createUser(
        { name: body.name, email: body.email, tier: body.tier, status: body.status },
        body.actor ?? 'admin@oneai.app',
      );
    } catch (error) {
      if (error instanceof AdminStorageUnavailableError) {
        return reply.code(503).send({ error: { code: error.code, message: error.message } });
      }
      throw error;
    }
  });

  app.post<{ Params: { id: string } }>('/admin/users/:id/status', { onRequest: requireAdmin }, async (request, reply) => {
    const body = request.body as { status?: 'active' | 'suspended' | 'grace'; actor?: string; reason?: string };
    const params = request.params;
    if (!body.status || !['active', 'suspended', 'grace'].includes(body.status)) {
      return reply.code(400).send({ error: { code: 'INVALID_PAYLOAD', message: 'status must be one of active, suspended, grace.' } });
    }
    if (!body.reason || body.reason.trim().length < 10) {
      return reply.code(400).send({ error: { code: 'INVALID_PAYLOAD', message: 'reason must be at least 10 characters.' } });
    }
    try {
      return await store.setUserStatus(
        params.id,
        body.status,
        body.actor ?? 'admin@oneai.app',
        body.reason,
      );
    } catch (error) {
      if (error instanceof AdminStorageUnavailableError) {
        return reply.code(503).send({ error: { code: error.code, message: error.message } });
      }
      const message = error instanceof Error ? error.message : 'Unable to update user status.';
      return reply.code(404).send({ error: { code: 'USER_NOT_FOUND', message } });
    }
  });

  app.post<{ Params: { id: string } }>('/admin/users/:id/quota-grant', { onRequest: requireAdmin }, async (request, reply) => {
    const body = request.body as { amount?: number; actor?: string; reason?: string };
    const params = request.params;
    if (!Number.isFinite(body.amount) || (body.amount as number) <= 0) {
      return reply.code(400).send({ error: { code: 'INVALID_PAYLOAD', message: 'amount must be a positive number.' } });
    }
    try {
      return await store.grantQuota(
        params.id,
        body.amount as number,
        body.actor ?? 'admin@oneai.app',
        body.reason ?? '',
      );
    } catch (error) {
      if (error instanceof AdminStorageUnavailableError) {
        return reply.code(503).send({ error: { code: error.code, message: error.message } });
      }
      const message = error instanceof Error ? error.message : 'Unable to grant quota.';
      return reply.code(404).send({ error: { code: 'USER_NOT_FOUND', message } });
    }
  });

  app.post<{ Params: { id: string } }>('/admin/users/:id/quota-override', { onRequest: requireAdmin }, async (request, reply) => {
    const body = request.body as {
      bypassQuota?: boolean;
      customRequestsLimit?: number;
      customTokensLimit?: number;
      reason?: string;
      actor?: string;
    };
    if (typeof body.bypassQuota !== 'boolean') {
      return reply.code(400).send({ error: { code: 'INVALID_PAYLOAD', message: 'bypassQuota is required.' } });
    }
    if (!body.reason || body.reason.trim().length < 1) {
      return reply.code(400).send({ error: { code: 'INVALID_PAYLOAD', message: 'reason is required.' } });
    }
    const override = {
      bypassQuota: body.bypassQuota,
      customRequestsLimit: body.customRequestsLimit,
      customTokensLimit: body.customTokensLimit,
      reason: body.reason,
      setBy: body.actor ?? 'admin@oneai.app',
      setAt: new Date().toISOString(),
    };
    try {
      return await store.setQuotaOverride(request.params.id, override, override.setBy);
    } catch (error) {
      if (error instanceof AdminStorageUnavailableError) {
        return reply.code(503).send({ error: { code: error.code, message: error.message } });
      }
      const message = error instanceof Error ? error.message : 'Unable to save override.';
      return reply.code(404).send({ error: { code: 'USER_NOT_FOUND', message } });
    }
  });

  app.delete<{ Params: { id: string } }>('/admin/users/:id/quota-override', { onRequest: requireAdmin }, async (request, reply) => {
    const body = (request.body ?? {}) as { actor?: string; reason?: string };
    try {
      return await store.resetQuotaOverride(
        request.params.id,
        body.actor ?? 'admin@oneai.app',
        body.reason ?? 'Quota override cleared',
      );
    } catch (error) {
      if (error instanceof AdminStorageUnavailableError) {
        return reply.code(503).send({ error: { code: error.code, message: error.message } });
      }
      const message = error instanceof Error ? error.message : 'Unable to clear override.';
      return reply.code(404).send({ error: { code: 'USER_NOT_FOUND', message } });
    }
  });

  app.post('/admin/audit', { onRequest: requireAdmin }, async (request, reply) => {
    try {
      return await store.appendAudit(request.body as never);
    } catch (error) {
      if (error instanceof AdminStorageUnavailableError) {
        return reply.code(503).send({ error: { code: error.code, message: error.message } });
      }
      throw error;
    }
  });

  app.patch('/admin/unit-pricing', { onRequest: requireAdmin }, async (request, reply) => {
    const body = request.body as { requestUnit?: { size: number; priceUsd: number; enabled: boolean }; tokenUnit?: { size: number; priceUsd: number; enabled: boolean }; reason?: string; actor?: string };
    if (!body.reason) return reply.code(400).send({ error: { code: 'INVALID_PAYLOAD', message: 'Reason is required.' } });
    try {
      return await store.updateUnitPricing(
        {
          requestUnit: body.requestUnit,
          tokenUnit: body.tokenUnit,
          reason: body.reason,
        },
        body.actor ?? 'admin@oneai.app',
      );
    } catch (error) {
      if (error instanceof AdminStorageUnavailableError) {
        return reply.code(503).send({ error: { code: error.code, message: error.message } });
      }
      throw error;
    }
  });
}

function buildDefaultEmailSender(): EmailSender {
  if (env.smtpHost && env.smtpUser && env.smtpPassword && env.smtpFromEmail) {
    try {
      return new SmtpEmailSender({
        host: env.smtpHost,
        port: env.smtpPort,
        secure: env.smtpSecure,
        user: env.smtpUser,
        password: env.smtpPassword,
        fromEmail: env.smtpFromEmail,
        fromName: env.smtpFromName,
      });
    } catch (error) {
      // Fall back to console — better than crashing the admin route.
      // eslint-disable-next-line no-console
      console.warn('Failed to build SMTP email sender; using console fallback.', error);
    }
  }
  return new ConsoleEmailSender();
}
