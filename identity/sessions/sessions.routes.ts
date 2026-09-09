import { createRouter } from "../../src/lib/hono.js";
import { requireAuth } from "../../src/middleware/auth.js";
import { db } from "../../src/db/client.js";
import { audit } from "../../src/lib/audit.js";

const router = createRouter();

router.get("/sessions", requireAuth, async (c) => {
  const user = c.get("user");

  const sessions = await db.session.findMany({
    where: { userId: user.id, revokedAt: null, expiresAt: { gt: new Date() } },
    include: { device: true },
    orderBy: { lastActivityAt: "desc" },
  });

  return c.json(sessions.map((s) => ({
    id: s.id,
    createdAt: s.createdAt,
    lastActivityAt: s.lastActivityAt,
    expiresAt: s.expiresAt,
    riskStatus: s.riskStatus,
    device: s.device
      ? { id: s.device.id, name: s.device.deviceName, userAgent: s.device.userAgent }
      : null,
  })));
});

router.delete("/sessions/:id", requireAuth, async (c) => {
  const user = c.get("user");
  const { id } = c.req.param();

  const session = await db.session.findUnique({ where: { id } });

  if (!session || session.userId !== user.id) {
    return c.json({ error: "not_found" }, 404);
  }

  await db.session.update({ where: { id }, data: { revokedAt: new Date() } });

  await audit({
    eventType: "session.revoked",
    actorUserId: user.id,
    targetType: "session",
    targetId: id,
    ipAddress: c.req.header("x-forwarded-for") ?? undefined,
  });

  return c.json({ success: true });
});

router.post("/sessions/revoke-all", requireAuth, async (c) => {
  const user = c.get("user");

  await db.session.updateMany({
    where: { userId: user.id, revokedAt: null },
    data: { revokedAt: new Date() },
  });

  await audit({
    eventType: "session.all_revoked",
    actorUserId: user.id,
    ipAddress: c.req.header("x-forwarded-for") ?? undefined,
  });

  return c.json({ success: true });
});

export { router as sessionsRouter };
