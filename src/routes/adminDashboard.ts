import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AuthRepository } from '../modules/auth/authRepository.js';
import { MongoAuthRepository } from '../modules/auth/mongoAuthRepository.js';
import { SessionError, SessionService } from '../modules/auth/sessionService.js';
import { env } from '../config/env.js';
import { adminDashboardStore } from '../modules/admin/dashboardStore.js';

type AdminRouteOptions = { authRepository?: AuthRepository };
type Claims = { sub: string; sid: string };

export async function adminDashboardRoutes(app: FastifyInstance, options: AdminRouteOptions) {
  let repository: AuthRepository | undefined;
  const auth = () => {
    repository ??=
      options.authRepository ??
      new MongoAuthRepository(app.mongo.db ?? app.mongo.client.db(env.mongoDatabase));
    return repository;
  };

  let sessions: SessionService | undefined;
  const getSessions = () => {
    sessions ??= new SessionService(auth(), env.jwtSecret, env.sessionExpiresDays);
    return sessions;
  };

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

  app.get('/admin/overview', { onRequest: requireAdmin }, async () => adminDashboardStore.overview());
  app.get('/admin/users', { onRequest: requireAdmin }, async () => adminDashboardStore.users());
  app.get<{ Params: { id: string } }>('/admin/users/:id', { onRequest: requireAdmin }, async (request) => adminDashboardStore.userDetail(request.params.id));
  app.get('/admin/revenue', { onRequest: requireAdmin }, async () => adminDashboardStore.revenue());
  app.get('/admin/usage', { onRequest: requireAdmin }, async () => adminDashboardStore.usage());
  app.get('/admin/providers-health', { onRequest: requireAdmin }, async () => adminDashboardStore.providers());
  app.get('/admin/tickets', { onRequest: requireAdmin }, async () => adminDashboardStore.tickets());
  app.get<{ Params: { id: string } }>('/admin/tickets/:id', { onRequest: requireAdmin }, async (request) => adminDashboardStore.ticketDetail(request.params.id));
  app.get<{ Params: { id: string } }>('/admin/tickets/:id/replies', { onRequest: requireAdmin }, async (request) => adminDashboardStore.ticketReplies(request.params.id));
  app.get('/admin/config/models', { onRequest: requireAdmin }, async () => adminDashboardStore.configModels());
  app.get('/admin/config/tiers', { onRequest: requireAdmin }, async () => adminDashboardStore.configTiers());
  app.get('/admin/plan-defaults', { onRequest: requireAdmin }, async () => adminDashboardStore.planDefaults());
  app.get('/admin/audit', { onRequest: requireAdmin }, async () => adminDashboardStore.audit());
  app.get('/admin/account', { onRequest: requireAdmin }, async () => adminDashboardStore.account());
  app.get('/admin/usage-visibility', { onRequest: requireAdmin }, async () => adminDashboardStore.usageVisibility());
  app.get('/admin/legal/terms', { onRequest: requireAdmin }, async () => adminDashboardStore.legalDoc('terms'));
  app.get('/admin/legal/privacy', { onRequest: requireAdmin }, async () => adminDashboardStore.legalDoc('privacy'));
  app.get('/admin/profile', { onRequest: requireAdmin }, async () => adminDashboardStore.adminProfile());
  app.get('/admin/totp-secret', { onRequest: requireAdmin }, async () => adminDashboardStore.totpSecret());
  app.get('/admin/unit-pricing', { onRequest: requireAdmin }, async () => adminDashboardStore.unitPricing());

  app.post('/admin/totp-enabled', { onRequest: requireAdmin }, async (request, reply) => {
    const body = request.body as { enabled?: boolean; actor?: string };
    if (typeof body.enabled !== 'boolean') {
      return reply.code(400).send({ error: { code: 'INVALID_PAYLOAD', message: 'enabled is required.' } });
    }
    return adminDashboardStore.setTotpEnabled(body.enabled, body.actor);
  });

  app.post('/admin/two-factor/code', { onRequest: requireAdmin }, async (request, reply) => {
    const body = request.body as { email?: string };
    if (!body.email) return reply.code(400).send({ error: { code: 'INVALID_PAYLOAD', message: 'Email is required.' } });
    return adminDashboardStore.sendTwoFactorCode({ email: body.email });
  });

  app.post('/admin/two-factor/verify', { onRequest: requireAdmin }, async (request, reply) => {
    const body = request.body as { email?: string; code?: string };
    if (!body.email || !body.code) {
      return reply.code(400).send({ error: { code: 'INVALID_PAYLOAD', message: 'Email and code are required.' } });
    }
    return adminDashboardStore.verifyTwoFactorCode({ email: body.email, code: body.code });
  });

  app.post('/admin/two-factor/email', { onRequest: requireAdmin }, async (request, reply) => {
    const body = request.body as { email?: string };
    if (!body.email) return reply.code(400).send({ error: { code: 'INVALID_PAYLOAD', message: 'Email is required.' } });
    return adminDashboardStore.setTwoFactorEmail({ email: body.email });
  });

  app.post('/admin/two-factor/disable', { onRequest: requireAdmin }, async () => adminDashboardStore.disableTwoFactor());

  app.delete<{ Params: { sessionId: string } }>('/admin/sessions/:sessionId', { onRequest: requireAdmin }, async (request) =>
    adminDashboardStore.revokeSession(request.params.sessionId),
  );

  app.post('/admin/sessions/revoke-others', { onRequest: requireAdmin }, async () => ({
    revoked: await adminDashboardStore.revokeAllOtherSessions(),
  }));

  app.patch('/admin/usage-visibility', { onRequest: requireAdmin }, async (request) =>
    adminDashboardStore.setUsageVisibility(request.body),
  );

  app.post('/admin/legal/:docType/versions', { onRequest: requireAdmin }, async (request, reply) => {
    const body = request.body as { body?: string; summary?: string; createdBy?: string; reason?: string };
    const params = request.params as { docType: 'terms' | 'privacy' };
    if (!body.body || !body.summary || !body.createdBy || !body.reason) {
      return reply.code(400).send({ error: { code: 'INVALID_PAYLOAD', message: 'Body, summary, createdBy, and reason are required.' } });
    }
    return adminDashboardStore.saveLegalVersion(params.docType, {
      body: body.body,
      summary: body.summary,
      createdBy: body.createdBy,
      reason: body.reason,
    });
  });

  app.post('/admin/legal/:docType/versions/:versionId/restore', { onRequest: requireAdmin }, async (request) => {
    const body = request.body as { actor?: string; reason?: string };
    const params = request.params as { docType: 'terms' | 'privacy'; versionId: string };
    return adminDashboardStore.restoreLegalVersion(params.docType, params.versionId, body.actor ?? 'admin@oneai.app', body.reason ?? 'Restore legal version');
  });

  app.delete('/admin/legal/:docType/versions/:versionId', { onRequest: requireAdmin }, async (request) => {
    const body = request.body as { actor?: string; reason?: string };
    const params = request.params as { docType: 'terms' | 'privacy'; versionId: string };
    return adminDashboardStore.deleteLegalVersion(params.docType, params.versionId, body.actor ?? 'admin@oneai.app', body.reason ?? 'Delete legal version');
  });

  app.post('/admin/tickets/:ticketId/replies', { onRequest: requireAdmin }, async (request, reply) => {
    const body = request.body as { body?: string; actor?: string };
    const params = request.params as { ticketId: string };
    if (!body.body) return reply.code(400).send({ error: { code: 'INVALID_PAYLOAD', message: 'Reply body is required.' } });
    return adminDashboardStore.postReply(params.ticketId, body.body, body.actor ?? 'admin@oneai.app');
  });

  app.post('/admin/tickets/:ticketId/close', { onRequest: requireAdmin }, async (request) => {
    const body = request.body as { actor?: string; reason?: string };
    const params = request.params as { ticketId: string };
    return adminDashboardStore.closeTicket(params.ticketId, body.actor ?? 'admin@oneai.app', body.reason ?? 'Closed by admin');
  });

  app.patch('/admin/config/tiers', { onRequest: requireAdmin }, async (request) => {
    const body = request.body as { tiers?: unknown; actor?: string; reason?: string };
    return adminDashboardStore.updateConfigTiers(body.tiers, body.actor ?? 'admin@oneai.app', body.reason ?? 'Updated tiers');
  });

  app.patch('/admin/config/models', { onRequest: requireAdmin }, async (request) => {
    const body = request.body as { models?: unknown; actor?: string; reason?: string };
    return adminDashboardStore.updateConfigModels(body.models, body.actor ?? 'admin@oneai.app', body.reason ?? 'Updated models');
  });

  app.post('/admin/users', { onRequest: requireAdmin }, async (request, reply) => {
    const body = request.body as { name?: string; email?: string; tier?: 'free' | 'pro' | 'business'; status?: 'active' | 'suspended' | 'grace'; actor?: string };
    if (!body.name || !body.email || !body.tier || !body.status) {
      return reply.code(400).send({ error: { code: 'INVALID_PAYLOAD', message: 'name, email, tier, and status are required.' } });
    }
    return adminDashboardStore.createUser(
      { name: body.name, email: body.email, tier: body.tier, status: body.status },
      body.actor ?? 'admin@oneai.app',
    );
  });

  app.post('/admin/audit', { onRequest: requireAdmin }, async (request) =>
    adminDashboardStore.appendAudit(request.body as never),
  );

  app.patch('/admin/unit-pricing', { onRequest: requireAdmin }, async (request, reply) => {
    const body = request.body as { requestUnit?: { size: number; priceUsd: number; enabled: boolean }; tokenUnit?: { size: number; priceUsd: number; enabled: boolean }; reason?: string; actor?: string };
    if (!body.reason) return reply.code(400).send({ error: { code: 'INVALID_PAYLOAD', message: 'Reason is required.' } });
    return adminDashboardStore.updateUnitPricing(
      {
        requestUnit: body.requestUnit,
        tokenUnit: body.tokenUnit,
        reason: body.reason,
      },
      body.actor ?? 'admin@oneai.app',
    );
  });
}
