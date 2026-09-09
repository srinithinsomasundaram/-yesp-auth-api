import { zValidator } from "@hono/zod-validator";
import { createRouter } from "../../src/lib/hono.js";
import { z } from "zod";
import { requireAuth } from "../../src/middleware/auth.js";
import { db } from "../../src/db/client.js";
import { generateToken, hashToken } from "../../src/lib/crypto.js";
import { audit } from "../../src/lib/audit.js";
import { sendInvitationEmail } from "../../src/modules/shared/notifications/notifications.service.js";

const router = createRouter();

// ─── Organizations ────────────────────────────────────────────────────────────

router.get("/organizations", requireAuth, async (c) => {
  const user = c.get("user");

  const memberships = await db.organizationMembership.findMany({
    where: { userId: user.id, status: "active" },
    include: { organization: true },
  });

  return c.json(memberships.map((m) => ({
    ...m.organization,
    role: m.role,
    joinedAt: m.joinedAt,
  })));
});

const createOrgSchema = z.object({
  name: z.string().min(2).max(150),
  slug: z.string().min(2).max(80).regex(/^[a-z0-9-]+$/),
});

router.post("/organizations", requireAuth, zValidator("json", createOrgSchema), async (c) => {
  const user = c.get("user");
  const body = c.req.valid("json");

  const slugTaken = await db.organization.findUnique({ where: { slug: body.slug } });
  if (slugTaken) return c.json({ error: "slug_taken" }, 409);

  const org = await db.organization.create({
    data: {
      name: body.name,
      slug: body.slug,
      memberships: {
        create: { userId: user.id, role: "organization_owner", status: "active", joinedAt: new Date() },
      },
    },
  });

  await audit({
    eventType: "organization.created",
    actorUserId: user.id,
    organizationId: org.id,
    targetType: "organization",
    targetId: org.id,
  });

  return c.json(org, 201);
});

router.get("/organizations/:id", requireAuth, async (c) => {
  const user = c.get("user");
  const { id } = c.req.param();

  const membership = await db.organizationMembership.findUnique({
    where: { organizationId_userId: { organizationId: id, userId: user.id }, status: "active" },
    include: { organization: true },
  });

  if (!membership) return c.json({ error: "not_found" }, 404);

  return c.json(membership.organization);
});

const updateOrgSchema = z.object({
  name: z.string().min(2).max(150).optional(),
});

router.patch("/organizations/:id", requireAuth, zValidator("json", updateOrgSchema), async (c) => {
  const user = c.get("user");
  const { id } = c.req.param();
  const body = c.req.valid("json");

  const membership = await db.organizationMembership.findUnique({
    where: { organizationId_userId: { organizationId: id, userId: user.id } },
  });

  if (!membership || !["organization_owner", "identity_admin"].includes(membership.role)) {
    return c.json({ error: "forbidden" }, 403);
  }

  const org = await db.organization.update({ where: { id }, data: body });
  return c.json(org);
});

// ─── Members ──────────────────────────────────────────────────────────────────

router.get("/organizations/:id/members", requireAuth, async (c) => {
  const user = c.get("user");
  const { id } = c.req.param();

  const membership = await db.organizationMembership.findUnique({
    where: { organizationId_userId: { organizationId: id, userId: user.id }, status: "active" },
  });
  if (!membership) return c.json({ error: "not_found" }, 404);

  const members = await db.organizationMembership.findMany({
    where: { organizationId: id, status: { in: ["active", "invited"] } },
    include: { user: { select: { id: true, email: true, firstName: true, lastName: true, displayName: true } } },
  });

  return c.json(members.map((m) => ({ ...m.user, role: m.role, status: m.status, joinedAt: m.joinedAt })));
});

const inviteSchema = z.object({
  email: z.string().email().toLowerCase(),
  role: z.enum(["identity_admin", "security_admin", "application_admin", "user_manager", "billing_admin", "member"]).default("member"),
});

router.post("/organizations/:id/invitations", requireAuth, zValidator("json", inviteSchema), async (c) => {
  const user = c.get("user");
  const { id } = c.req.param();
  const body = c.req.valid("json");

  const membership = await db.organizationMembership.findUnique({
    where: { organizationId_userId: { organizationId: id, userId: user.id } },
  });

  if (!membership || !["organization_owner", "identity_admin", "user_manager"].includes(membership.role)) {
    return c.json({ error: "forbidden" }, 403);
  }

  const token = generateToken();
  await db.organizationInvitation.create({
    data: {
      organizationId: id,
      email: body.email,
      role: body.role,
      tokenHash: hashToken(token),
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    },
  });

  const org = await db.organization.findUnique({ where: { id } });
  if (org) await sendInvitationEmail(body.email, org.name, token).catch(() => {});

  await audit({
    eventType: "organization.user.invited",
    actorUserId: user.id,
    organizationId: id,
    metadata: { email: body.email, role: body.role },
  });

  return c.json({ success: true }, 201);
});

const updateMemberSchema = z.object({
  role: z.enum(["identity_admin", "security_admin", "application_admin", "user_manager", "billing_admin", "member"]).optional(),
  status: z.enum(["active", "suspended"]).optional(),
});

router.patch("/organizations/:id/members/:memberId", requireAuth, zValidator("json", updateMemberSchema), async (c) => {
  const user = c.get("user");
  const { id, memberId } = c.req.param();
  const body = c.req.valid("json");

  const actorMembership = await db.organizationMembership.findUnique({
    where: { organizationId_userId: { organizationId: id, userId: user.id } },
  });

  if (!actorMembership || !["organization_owner", "identity_admin"].includes(actorMembership.role)) {
    return c.json({ error: "forbidden" }, 403);
  }

  const updated = await db.organizationMembership.update({
    where: { id: memberId, organizationId: id },
    data: body,
  });

  if (body.role) {
    await audit({
      eventType: "organization.user.role.changed",
      actorUserId: user.id,
      organizationId: id,
      targetType: "membership",
      targetId: memberId,
      metadata: { newRole: body.role },
    });
  }

  return c.json(updated);
});

router.delete("/organizations/:id/members/:memberId", requireAuth, async (c) => {
  const user = c.get("user");
  const { id, memberId } = c.req.param();

  const actorMembership = await db.organizationMembership.findUnique({
    where: { organizationId_userId: { organizationId: id, userId: user.id } },
  });

  if (!actorMembership || !["organization_owner", "identity_admin", "user_manager"].includes(actorMembership.role)) {
    return c.json({ error: "forbidden" }, 403);
  }

  await db.organizationMembership.update({
    where: { id: memberId, organizationId: id },
    data: { status: "removed" },
  });

  await audit({
    eventType: "organization.user.removed",
    actorUserId: user.id,
    organizationId: id,
    targetType: "membership",
    targetId: memberId,
  });

  return c.json({ success: true });
});

// ─── Organization Stats ───────────────────────────────────────────────────────

router.get("/organizations/:id/stats", requireAuth, async (c) => {
  const user = c.get("user");
  const { id } = c.req.param();

  const membership = await db.organizationMembership.findUnique({
    where: { organizationId_userId: { organizationId: id, userId: user.id }, status: "active" },
    include: { organization: true },
  });
  if (!membership) return c.json({ error: "not_found" }, 404);

  const [memberCount, appCount] = await Promise.all([
    db.organizationMembership.count({ where: { organizationId: id, status: "active" } }),
    db.applicationAccess.groupBy({
      by: ["applicationId"],
      where: { organizationId: id, status: "active" },
    }),
  ]);

  return c.json({
    org: membership.organization,
    role: membership.role,
    memberCount,
    appCount: appCount.length,
  });
});

// ─── Organization App Access ──────────────────────────────────────────────────

router.get("/organizations/:id/apps", requireAuth, async (c) => {
  const user = c.get("user");
  const { id } = c.req.param();

  const membership = await db.organizationMembership.findUnique({
    where: { organizationId_userId: { organizationId: id, userId: user.id }, status: "active" },
  });
  if (!membership) return c.json({ error: "not_found" }, 404);

  const allApps = await db.application.findMany({ where: { status: "active" } });

  const accessCounts = await db.applicationAccess.groupBy({
    by: ["applicationId"],
    where: { organizationId: id, status: "active" },
    _count: { id: true },
  });

  const countMap = new Map(accessCounts.map((a) => [a.applicationId, a._count.id]));

  return c.json(allApps.map((app) => ({
    ...app,
    usersWithAccess: countMap.get(app.id) ?? 0,
    enabled: (countMap.get(app.id) ?? 0) > 0,
  })));
});

router.post("/organizations/:id/apps/:appId/grant-all", requireAuth, async (c) => {
  const user = c.get("user");
  const { id, appId } = c.req.param();

  const membership = await db.organizationMembership.findUnique({
    where: { organizationId_userId: { organizationId: id, userId: user.id } },
  });
  if (!membership || !["organization_owner", "identity_admin", "application_admin"].includes(membership.role)) {
    return c.json({ error: "forbidden" }, 403);
  }

  const app = await db.application.findUnique({ where: { id: appId, status: "active" } });
  if (!app) return c.json({ error: "not_found" }, 404);

  const members = await db.organizationMembership.findMany({
    where: { organizationId: id, status: "active" },
  });

  await Promise.all(members.map((m) =>
    db.applicationAccess.upsert({
      where: { userId_organizationId_applicationId: { userId: m.userId, organizationId: id, applicationId: appId } },
      create: { userId: m.userId, organizationId: id, applicationId: appId, status: "active" },
      update: { status: "active" },
    })
  ));

  await audit({ eventType: "organization.app.granted", actorUserId: user.id, organizationId: id, applicationId: appId });

  return c.json({ success: true, granted: members.length });
});

router.post("/organizations/:id/apps/:appId/revoke-all", requireAuth, async (c) => {
  const user = c.get("user");
  const { id, appId } = c.req.param();

  const membership = await db.organizationMembership.findUnique({
    where: { organizationId_userId: { organizationId: id, userId: user.id } },
  });
  if (!membership || !["organization_owner", "identity_admin", "application_admin"].includes(membership.role)) {
    return c.json({ error: "forbidden" }, 403);
  }

  await db.applicationAccess.updateMany({
    where: { organizationId: id, applicationId: appId },
    data: { status: "suspended" },
  });

  await audit({ eventType: "organization.app.revoked", actorUserId: user.id, organizationId: id, applicationId: appId });

  return c.json({ success: true });
});

// ─── Security Policy ──────────────────────────────────────────────────────────

router.get("/organizations/:id/security-policy", requireAuth, async (c) => {
  const user = c.get("user");
  const { id } = c.req.param();

  const membership = await db.organizationMembership.findUnique({
    where: { organizationId_userId: { organizationId: id, userId: user.id }, status: "active" },
  });
  if (!membership) return c.json({ error: "not_found" }, 404);

  const policy = await db.organizationSecurityPolicy.findUnique({ where: { organizationId: id } });
  return c.json(policy ?? { organizationId: id, requireMfa: false, requireSso: false, allowedAuthMethods: [], sessionMaxAgeSecs: 2592000 });
});

const securityPolicySchema = z.object({
  requireMfa: z.boolean().optional(),
  requireSso: z.boolean().optional(),
  allowedAuthMethods: z.array(z.string()).optional(),
  sessionMaxAgeSecs: z.number().int().min(3600).max(31536000).optional(),
});

router.patch("/organizations/:id/security-policy", requireAuth, zValidator("json", securityPolicySchema), async (c) => {
  const user = c.get("user");
  const { id } = c.req.param();
  const body = c.req.valid("json");

  const membership = await db.organizationMembership.findUnique({
    where: { organizationId_userId: { organizationId: id, userId: user.id } },
  });
  if (!membership || !["organization_owner", "identity_admin", "security_admin"].includes(membership.role)) {
    return c.json({ error: "forbidden" }, 403);
  }

  const policy = await db.organizationSecurityPolicy.upsert({
    where: { organizationId: id },
    create: { organizationId: id, ...body },
    update: body,
  });

  await audit({ eventType: "organization.security.policy.updated", actorUserId: user.id, organizationId: id });

  return c.json(policy);
});

export { router as organizationsRouter };
