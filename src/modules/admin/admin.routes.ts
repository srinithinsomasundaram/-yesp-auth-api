import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { createRouter } from "../../lib/hono.js";
import { requireAuth } from "../../middleware/auth.js";
import { db } from "../../db/client.js";
import { generateToken, hashToken } from "../../lib/crypto.js";
import { sendPasswordResetEmail } from "../shared/notifications/notifications.service.js";
import { audit } from "../../lib/audit.js";
import type { Next } from "hono";
import type { AppEnv } from "../../lib/hono.js";
import type { Context } from "hono";

const router = createRouter();

// Only users whose email is in ADMIN_EMAILS env var can access admin routes
async function requireAdmin(c: Context<AppEnv>, next: Next) {
  const user = c.get("user");
  if (!user) return c.json({ error: "unauthorized" }, 401);

  const adminEmails = (process.env.ADMIN_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);

  if (!adminEmails.includes(user.email.toLowerCase())) {
    return c.json({ error: "forbidden" }, 403);
  }
  await next();
}

// ── Stats ─────────────────────────────────────────────────────────────────────

router.get("/admin/stats", requireAuth, requireAdmin, async (c) => {
  const [totalUsers, activeUsers, totalApps, totalSessions, recentLogins] = await Promise.all([
    db.user.count(),
    db.user.count({ where: { status: "active" } }),
    db.application.count(),
    db.session.count({ where: { revokedAt: null, expiresAt: { gt: new Date() } } }),
    db.loginAttempt.count({ where: { occurredAt: { gt: new Date(Date.now() - 24 * 60 * 60 * 1000) }, success: true } }),
  ]);
  return c.json({ totalUsers, activeUsers, totalApps, totalSessions, recentLogins });
});

// ── Audit Log ─────────────────────────────────────────────────────────────────

router.get("/admin/audit", requireAuth, requireAdmin, async (c) => {
  const page = Math.max(1, Number(c.req.query("page") ?? 1));
  const limit = 50;
  const skip = (page - 1) * limit;
  const [events, total] = await Promise.all([
    db.auditEvent.findMany({
      orderBy: { occurredAt: "desc" },
      skip,
      take: limit,
      include: { actorUser: { select: { email: true, displayName: true } } },
    }),
    db.auditEvent.count(),
  ]);
  return c.json({ events, total, page, pages: Math.ceil(total / limit) });
});

// ── List users ────────────────────────────────────────────────────────────────

router.get("/admin/users", requireAuth, requireAdmin, async (c) => {
  const q = c.req.query("q") ?? "";
  const page = Math.max(1, Number(c.req.query("page") ?? 1));
  const limit = 20;
  const skip = (page - 1) * limit;

  const where = q
    ? {
        OR: [
          { email: { contains: q, mode: "insensitive" as const } },
          { firstName: { contains: q, mode: "insensitive" as const } },
          { lastName: { contains: q, mode: "insensitive" as const } },
        ],
      }
    : {};

  const [users, total] = await Promise.all([
    db.user.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip,
      take: limit,
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        displayName: true,
        status: true,
        emailVerified: true,
        createdAt: true,
        _count: { select: { sessions: true, passkeys: true } },
      },
    }),
    db.user.count({ where }),
  ]);

  return c.json({ users, total, page, pages: Math.ceil(total / limit) });
});

// ── Get single user ───────────────────────────────────────────────────────────

router.get("/admin/users/:id", requireAuth, requireAdmin, async (c) => {
  const { id } = c.req.param();
  const user = await db.user.findUnique({
    where: { id },
    select: {
      id: true,
      email: true,
      firstName: true,
      lastName: true,
      displayName: true,
      status: true,
      emailVerified: true,
      createdAt: true,
      _count: { select: { sessions: true, passkeys: true, mfaMethods: true } },
    },
  });
  if (!user) return c.json({ error: "not_found" }, 404);
  return c.json(user);
});

// ── Reset password (admin-triggered) ─────────────────────────────────────────

router.post("/admin/users/:id/reset-password", requireAuth, requireAdmin, async (c) => {
  const actor = c.get("user");
  const { id } = c.req.param();

  const user = await db.user.findUnique({ where: { id, status: "active" } });
  if (!user) return c.json({ error: "not_found" }, 404);

  // Invalidate any existing unused reset tokens
  await db.passwordReset.updateMany({
    where: { userId: id, usedAt: null },
    data: { usedAt: new Date() },
  });

  const token = generateToken();
  await db.passwordReset.create({
    data: {
      userId: id,
      tokenHash: hashToken(token),
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000), // 24h for admin-triggered
    },
  });

  await sendPasswordResetEmail(user.email, token).catch(() => {});

  await audit({
    eventType: "password.reset.requested",
    actorUserId: actor.id,
    targetType: "user",
    targetId: id,
    metadata: { triggeredBy: "admin" },
    ipAddress: c.req.header("x-forwarded-for") ?? undefined,
  });

  return c.json({ success: true, email: user.email });
});

// ── Suspend / reactivate user ─────────────────────────────────────────────────

const statusSchema = z.object({
  status: z.enum(["active", "suspended"]),
});

router.patch("/admin/users/:id/status", requireAuth, requireAdmin, zValidator("json", statusSchema), async (c) => {
  const actor = c.get("user");
  const { id } = c.req.param();
  const { status } = c.req.valid("json");

  if (id === actor.id) return c.json({ error: "cannot_modify_self" }, 400);

  const user = await db.user.findUnique({ where: { id } });
  if (!user) return c.json({ error: "not_found" }, 404);

  const updated = await db.user.update({ where: { id }, data: { status } });

  await audit({
    eventType: "user.deleted", // closest available; status change logged via metadata
    actorUserId: actor.id,
    targetType: "user",
    targetId: id,
    metadata: { action: status === "suspended" ? "suspended" : "reactivated", triggeredBy: "admin" },
    ipAddress: c.req.header("x-forwarded-for") ?? undefined,
  });

  return c.json({ id: updated.id, status: updated.status });
});

// ── List registered apps ──────────────────────────────────────────────────────

router.get("/admin/apps", requireAuth, requireAdmin, async (c) => {
  const apps = await db.application.findMany({
    orderBy: { createdAt: "desc" },
    include: {
      oauthClients: {
        select: { clientId: true, redirectUris: true, allowedScopes: true, status: true },
      },
    },
  });
  return c.json(apps);
});

// ── Register a new app (creates Application + OAuthClient in one call) ────────

const createAppSchema = z.object({
  name: z.string().min(1),
  slug: z.string().min(1).regex(/^[a-z0-9-]+$/, "slug must be lowercase alphanumeric with dashes"),
  type: z.enum(["web", "spa", "mobile", "server", "service", "internal"]).default("web"),
  description: z.string().optional(),
  logoUrl: z.string().url().optional(),
  homepageUrl: z.string().url().optional(),
  redirectUris: z.array(z.string().url()).min(1),
  scopes: z.array(z.string()).default(["openid", "profile", "email"]),
});

router.post("/admin/apps", requireAuth, requireAdmin, zValidator("json", createAppSchema), async (c) => {
  const { name, slug, type, description, logoUrl, homepageUrl, redirectUris, scopes } = c.req.valid("json");

  const existing = await db.application.findUnique({ where: { slug } });
  if (existing) return c.json({ error: "slug_taken" }, 409);

  const clientId = `yesp_${slug.replace(/-/g, "_")}_${generateToken().slice(0, 8)}`;

  const app = await db.application.create({
    data: {
      name,
      slug,
      type,
      description,
      logoUrl,
      homepageUrl,
      oauthClients: {
        create: {
          clientId,
          redirectUris,
          allowedScopes: scopes,
        },
      },
    },
    include: { oauthClients: { select: { clientId: true, redirectUris: true, allowedScopes: true } } },
  });

  await audit({ eventType: "oauth.code.issued", actorUserId: c.get("user").id, metadata: { action: "app_registered", slug } });

  return c.json({ app, clientId }, 201);
});

// ── Update an app ─────────────────────────────────────────────────────────────

const updateAppSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  logoUrl: z.string().url().optional().nullable(),
  homepageUrl: z.string().url().optional().nullable(),
  status: z.enum(["active", "inactive"]).optional(),
});

router.patch("/admin/apps/:slug", requireAuth, requireAdmin, zValidator("json", updateAppSchema), async (c) => {
  const { slug } = c.req.param();
  const data = c.req.valid("json");
  const app = await db.application.findUnique({ where: { slug } });
  if (!app) return c.json({ error: "not_found" }, 404);
  const updated = await db.application.update({ where: { slug }, data });
  return c.json(updated);
});

// ── Revoke / delete an app ────────────────────────────────────────────────────

router.delete("/admin/apps/:slug", requireAuth, requireAdmin, async (c) => {
  const { slug } = c.req.param();
  const app = await db.application.findUnique({ where: { slug } });
  if (!app) return c.json({ error: "not_found" }, 404);
  await db.application.delete({ where: { slug } });
  return c.json({ success: true });
});

// ── Security overview ─────────────────────────────────────────────────────────

router.get("/admin/security", requireAuth, requireAdmin, async (c) => {
  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const [recentFailures, totalFailures24h, totalSuccess24h] = await Promise.all([
    db.loginAttempt.findMany({
      where: { success: false, occurredAt: { gt: since24h } },
      orderBy: { occurredAt: "desc" },
      take: 50,
    }),
    db.loginAttempt.count({ where: { success: false, occurredAt: { gt: since24h } } }),
    db.loginAttempt.count({ where: { success: true, occurredAt: { gt: since24h } } }),
  ]);

  // IPs with 5+ failures in 24h
  const ipCounts = recentFailures.reduce<Record<string, number>>((acc, a) => {
    if (a.ipAddress) acc[a.ipAddress] = (acc[a.ipAddress] ?? 0) + 1;
    return acc;
  }, {});
  const blockedIps = Object.entries(ipCounts)
    .filter(([, count]) => count >= 5)
    .map(([ip]) => ip);

  return c.json({ recentFailures, blockedIps, totalFailures24h, totalSuccess24h });
});

export { router as adminRouter };
