import { createRouter } from "../../src/lib/hono.js";
import { requireAuth } from "../../src/middleware/auth.js";
import { db } from "../../src/db/client.js";

const router = createRouter();

router.get("/applications", requireAuth, async (c) => {
  const apps = await db.application.findMany({
    where: { status: "active" },
    select: { id: true, name: true, slug: true, createdAt: true },
  });
  return c.json(apps);
});

router.get("/applications/:id", requireAuth, async (c) => {
  const { id } = c.req.param();
  const app = await db.application.findUnique({
    where: { id, status: "active" },
    select: { id: true, name: true, slug: true, createdAt: true },
  });
  if (!app) return c.json({ error: "not_found" }, 404);
  return c.json(app);
});

export { router as applicationsRouter };
