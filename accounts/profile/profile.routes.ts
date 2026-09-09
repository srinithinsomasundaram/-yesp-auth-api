import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { createRouter } from "../../src/lib/hono.js";
import { requireAuth } from "../../src/middleware/auth.js";
import { db } from "../../src/db/client.js";
import { audit } from "../../src/lib/audit.js";

const router = createRouter();

router.get("/me", requireAuth, async (c) => {
  const user = c.get("user");
  return c.json({
    id: user.id,
    email: user.email,
    emailVerified: user.emailVerified,
    firstName: user.firstName,
    lastName: user.lastName,
    displayName: user.displayName,
    avatarUrl: user.avatarData ? `/api/v1/users/${user.id}/avatar` : null,
    status: user.status,
    createdAt: user.createdAt,
  });
});

// ── Serve avatar from DB ──────────────────────────────────────────────────────

router.get("/users/:id/avatar", async (c) => {
  const { id } = c.req.param();
  const user = await db.user.findUnique({
    where: { id },
    select: { avatarData: true, avatarMimeType: true },
  });

  if (!user?.avatarData) return c.json({ error: "not_found" }, 404);

  return new Response(user.avatarData, {
    headers: {
      "Content-Type": user.avatarMimeType ?? "image/jpeg",
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
});

// ── Upload avatar → store in DB ───────────────────────────────────────────────

const ALLOWED_MIME = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
const MAX_BYTES = 5 * 1024 * 1024;

router.post("/account/avatar", requireAuth, async (c) => {
  const user = c.get("user");
  const body = await c.req.parseBody();
  const file = body["avatar"];

  if (!file || typeof file === "string") {
    return c.json({ error: "no_file" }, 400);
  }
  if (!ALLOWED_MIME.has(file.type)) {
    return c.json({ error: "invalid_type" }, 422);
  }

  const buffer = await file.arrayBuffer();
  if (buffer.byteLength > MAX_BYTES) {
    return c.json({ error: "file_too_large" }, 422);
  }

  await db.user.update({
    where: { id: user.id },
    data: {
      avatarData: Buffer.from(buffer),
      avatarMimeType: file.type,
    },
  });

  return c.json({ avatarUrl: `/api/v1/users/${user.id}/avatar` });
});

const updateMeSchema = z.object({
  firstName: z.string().min(1).max(100).optional(),
  lastName: z.string().min(1).max(100).optional(),
  displayName: z.string().min(1).max(150).optional(),
});

router.patch("/me", requireAuth, zValidator("json", updateMeSchema), async (c) => {
  const user = c.get("user");
  const body = c.req.valid("json");

  const updated = await db.user.update({
    where: { id: user.id },
    data: {
      ...(body.firstName !== undefined && { firstName: body.firstName }),
      ...(body.lastName !== undefined && { lastName: body.lastName }),
      ...(body.displayName !== undefined && { displayName: body.displayName }),
    },
  });

  return c.json({
    id: updated.id,
    email: updated.email,
    firstName: updated.firstName,
    lastName: updated.lastName,
    displayName: updated.displayName,
  });
});

router.delete("/me", requireAuth, async (c) => {
  const user = c.get("user");

  await db.user.update({
    where: { id: user.id },
    data: { status: "deleted" },
  });

  await audit({
    eventType: "user.deleted",
    actorUserId: user.id,
    targetType: "user",
    targetId: user.id,
    ipAddress: c.req.header("x-forwarded-for") ?? undefined,
  });

  return c.json({ success: true });
});

export { router as profileRouter };
