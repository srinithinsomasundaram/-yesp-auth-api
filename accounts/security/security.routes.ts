import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { createRouter } from "../../src/lib/hono.js";
import { requireAuth } from "../../src/middleware/auth.js";
import { db } from "../../src/db/client.js";
import { audit } from "../../src/lib/audit.js";
import { sendSuspiciousActivityEmail } from "../../src/modules/shared/notifications/notifications.service.js";

const router = createRouter();

// ─── Devices ──────────────────────────────────────────────────────────────────

router.get("/devices", requireAuth, async (c) => {
  const user = c.get("user");
  const devices = await db.device.findMany({
    where: { userId: user.id },
    orderBy: { lastSeenAt: "desc" },
  });
  return c.json(devices.map((d) => ({
    id: d.id,
    deviceName: d.deviceName,
    userAgent: d.userAgent,
    trustedStatus: d.trustedStatus,
    firstSeenAt: d.firstSeenAt,
    lastSeenAt: d.lastSeenAt,
  })));
});

const updateDeviceSchema = z.object({
  deviceName: z.string().max(100).optional(),
  trustedStatus: z.enum(["trusted", "untrusted"]).optional(),
});

router.patch("/devices/:id", requireAuth, zValidator("json", updateDeviceSchema), async (c) => {
  const user = c.get("user");
  const { id } = c.req.param();
  const body = c.req.valid("json");

  const device = await db.device.findUnique({ where: { id } });
  if (!device || device.userId !== user.id) return c.json({ error: "not_found" }, 404);

  const updated = await db.device.update({ where: { id }, data: body });
  return c.json(updated);
});

router.delete("/devices/:id", requireAuth, async (c) => {
  const user = c.get("user");
  const { id } = c.req.param();

  const device = await db.device.findUnique({ where: { id } });
  if (!device || device.userId !== user.id) return c.json({ error: "not_found" }, 404);

  // Revoke all sessions associated with this device
  await db.session.updateMany({
    where: { deviceId: id, revokedAt: null },
    data: { revokedAt: new Date() },
  });

  await db.device.delete({ where: { id } });

  return c.json({ success: true });
});

// ─── Security Summary ─────────────────────────────────────────────────────────

router.get("/security/summary", requireAuth, async (c) => {
  const user = c.get("user");
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000); // 30 days

  const [activeSessions, activeDevices, mfaMethods, recentFailures, recentSuccesses] =
    await Promise.all([
      db.session.count({ where: { userId: user.id, revokedAt: null, expiresAt: { gt: new Date() } } }),
      db.device.count({ where: { userId: user.id } }),
      db.mfaMethod.findMany({
        where: { userId: user.id, status: "active" },
        select: { type: true },
      }),
      db.loginAttempt.count({ where: { identifier: user.email, success: false, occurredAt: { gte: since } } }),
      db.loginAttempt.count({ where: { identifier: user.email, success: true, occurredAt: { gte: since } } }),
    ]);

  return c.json({
    activeSessions,
    activeDevices,
    mfaEnabled: mfaMethods.length > 0,
    mfaMethods: mfaMethods.map((m) => m.type),
    last30Days: { loginSuccess: recentSuccesses, loginFailures: recentFailures },
  });
});

// ─── Security Events ──────────────────────────────────────────────────────────

router.get("/security/events", requireAuth, async (c) => {
  const user = c.get("user");
  const url = new URL(c.req.url);
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 50), 200);

  const securityEventTypes = [
    "user.login.success",
    "user.login.failed",
    "password.changed",
    "password.reset.requested",
    "password.reset.completed",
    "passkey.added",
    "passkey.removed",
    "mfa.enabled",
    "mfa.disabled",
    "mfa.recovery_code.used",
    "session.revoked",
    "session.all_revoked",
    "oauth.token.revoked",
  ];

  const events = await db.auditEvent.findMany({
    where: { actorUserId: user.id, eventType: { in: securityEventTypes } },
    orderBy: { occurredAt: "desc" },
    take: limit,
    select: { id: true, eventType: true, ipAddress: true, userAgent: true, occurredAt: true, metadata: true },
  });

  return c.json(events);
});

// ─── Login History ────────────────────────────────────────────────────────────

router.get("/security/login-history", requireAuth, async (c) => {
  const user = c.get("user");
  const url = new URL(c.req.url);
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 20), 100);

  const attempts = await db.loginAttempt.findMany({
    where: { identifier: user.email },
    orderBy: { occurredAt: "desc" },
    take: limit,
    select: { id: true, ipAddress: true, success: true, occurredAt: true },
  });

  return c.json(attempts);
});

// ─── Anomaly Detection (internal helper — called from auth flow) ──────────────

export async function runAnomalyChecks(
  userId: string,
  email: string,
  ipAddress: string,
  userAgent: string
): Promise<void> {
  const windowStart = new Date(Date.now() - 60 * 60 * 1000); // 1 hour

  // Check: unusually high failure rate
  const recentFailures = await db.loginAttempt.count({
    where: { identifier: email, success: false, occurredAt: { gte: windowStart } },
  });

  if (recentFailures >= 5) {
    await audit({
      eventType: "user.login.failed",
      actorUserId: userId,
      ipAddress,
      userAgent,
      metadata: { anomaly: "high_failure_rate", count: recentFailures },
    });

    const user = await db.user.findUnique({ where: { id: userId } });
    if (user) {
      await sendSuspiciousActivityEmail(
        user.email,
        `${recentFailures} failed login attempts were detected in the last hour.`,
        ipAddress
      ).catch(() => {});
    }
  }

  // Check: IP seen for the first time for this user
  const ipSeen = await db.loginAttempt.findFirst({
    where: { identifier: email, ipAddress, success: true, occurredAt: { lt: new Date(Date.now() - 5000) } },
  });

  if (!ipSeen) {
    const user = await db.user.findUnique({ where: { id: userId } });
    if (user) {
      await sendSuspiciousActivityEmail(
        user.email,
        `A successful sign-in was detected from a new IP address (${ipAddress}).`,
        ipAddress
      ).catch(() => {});
    }
  }
}

export { router as securityRouter };
