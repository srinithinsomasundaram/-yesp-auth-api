import { createRouter } from "../../../lib/hono.js";
import { requireAuth } from "../../../middleware/auth.js";
import { db } from "../../../db/client.js";

const router = createRouter();

router.get("/account/activity", requireAuth, async (c) => {
  const user = c.get("user");
  const url = new URL(c.req.url);
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 50), 200);
  const offset = Number(url.searchParams.get("offset") ?? 0);

  const events = await db.auditEvent.findMany({
    where: { actorUserId: user.id },
    orderBy: { occurredAt: "desc" },
    take: limit,
    skip: offset,
    select: {
      id: true,
      eventType: true,
      targetType: true,
      targetId: true,
      ipAddress: true,
      occurredAt: true,
      metadata: true,
    },
  });

  return c.json(events);
});

export { router as auditRouter };
