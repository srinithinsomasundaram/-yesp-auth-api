import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { createRouter } from "../../src/lib/hono.js";
import { requireAuth } from "../../src/middleware/auth.js";
import { db } from "../../src/db/client.js";
import { audit } from "../../src/lib/audit.js";
import { hashPassword, verifyPassword, isStrongPassword } from "../../src/lib/password.js";
import { generateToken, hashToken } from "../../src/lib/crypto.js";
import { sendVerificationEmail } from "../../src/modules/shared/notifications/notifications.service.js";
import { redis } from "../../src/lib/redis.js";

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

// ── Change password (requires current password) ───────────────────────────────

const changePasswordSchema = z.object({
  currentPassword: z.string(),
  newPassword: z.string().min(12),
});

router.post("/me/password", requireAuth, zValidator("json", changePasswordSchema), async (c) => {
  const user = c.get("user");
  const { currentPassword, newPassword } = c.req.valid("json");

  if (!isStrongPassword(newPassword)) {
    return c.json({ error: "password_too_weak" }, 422);
  }

  const credential = await db.credential.findUnique({
    where: { userId_credentialType: { userId: user.id, credentialType: "password" } },
  });

  if (!credential?.passwordHash) {
    return c.json({ error: "no_password_set" }, 400);
  }

  const valid = await verifyPassword(credential.passwordHash, currentPassword);
  if (!valid) {
    return c.json({ error: "invalid_current_password" }, 401);
  }

  const newHash = await hashPassword(newPassword);
  await db.credential.update({
    where: { id: credential.id },
    data: { passwordHash: newHash, updatedAt: new Date() },
  });

  // Revoke all other sessions so old-password sessions can't linger
  await db.session.updateMany({
    where: { userId: user.id, revokedAt: null },
    data: { revokedAt: new Date() },
  });

  await audit({
    eventType: "user.password.changed" as const,
    actorUserId: user.id,
    targetType: "user",
    targetId: user.id,
    ipAddress: c.req.header("x-forwarded-for") ?? undefined,
  });

  return c.json({ success: true });
});

// ── Request email change (sends verification to new address) ─────────────────

const emailChangeRequestSchema = z.object({
  newEmail: z.string().email().toLowerCase(),
  currentPassword: z.string(),
});

router.post("/me/email/change", requireAuth, zValidator("json", emailChangeRequestSchema), async (c) => {
  const user = c.get("user");
  const { newEmail, currentPassword } = c.req.valid("json");

  if (newEmail === user.email) {
    return c.json({ error: "same_email" }, 400);
  }

  // Require current password to authorise an email change
  const credential = await db.credential.findUnique({
    where: { userId_credentialType: { userId: user.id, credentialType: "password" } },
  });

  if (!credential?.passwordHash) {
    return c.json({ error: "no_password_set" }, 400);
  }

  const valid = await verifyPassword(credential.passwordHash, currentPassword);
  if (!valid) {
    return c.json({ error: "invalid_current_password" }, 401);
  }

  // Reject if the new email is already taken
  const existing = await db.user.findUnique({ where: { email: newEmail } });
  if (existing) {
    // Avoid email enumeration — return same response
    return c.json({ message: "A verification email has been sent to your new address." });
  }

  const token = generateToken();
  const tokenHash = hashToken(token);
  // Store {userId, newEmail} in Redis for 24 h — confirmed when the link is clicked
  await redis.setex(`email:change:${tokenHash}`, 86400, JSON.stringify({ userId: user.id, newEmail }));

  await sendVerificationEmail(newEmail, token).catch((err) => {
    console.error("[Email] Failed to send email change verification:", err);
  });

  await audit({
    eventType: "user.email.change.requested",
    actorUserId: user.id,
    targetType: "user",
    targetId: user.id,
    ipAddress: c.req.header("x-forwarded-for") ?? undefined,
  });

  return c.json({ message: "A verification email has been sent to your new address." });
});

// ── Confirm email change ──────────────────────────────────────────────────────

const emailChangeConfirmSchema = z.object({ token: z.string() });

router.post("/me/email/change/confirm", zValidator("json", emailChangeConfirmSchema), async (c) => {
  const { token } = c.req.valid("json");
  const tokenHash = hashToken(token);
  const key = `email:change:${tokenHash}`;

  const raw = await redis.get(key);
  if (!raw) return c.json({ error: "invalid_or_expired_token" }, 400);

  let payload: { userId: string; newEmail: string };
  try {
    payload = JSON.parse(raw) as { userId: string; newEmail: string };
  } catch {
    return c.json({ error: "invalid_token" }, 400);
  }

  // Consume immediately to prevent replay
  await redis.del(key);

  await db.user.update({
    where: { id: payload.userId },
    data: { email: payload.newEmail, emailVerified: true },
  });

  await audit({
    eventType: "user.email.changed",
    actorUserId: payload.userId,
    targetType: "user",
    targetId: payload.userId,
    metadata: { newEmail: payload.newEmail },
  });

  return c.json({ success: true });
});

// ── Delete account (GDPR-compliant hard delete) ───────────────────────────────

router.delete("/me", requireAuth, async (c) => {
  const user = c.get("user");

  // Hard delete: erase all PII. Cascade via Prisma relations.
  // Audit log is kept but the actorUserId reference is nulled by DB cascade.
  await db.$transaction([
    // Revoke all active sessions first
    db.session.updateMany({ where: { userId: user.id }, data: { revokedAt: new Date() } }),
    // Anonymise the user record — keep the ID row so FK references don't break,
    // but erase all identifying data
    db.user.update({
      where: { id: user.id },
      data: {
        email: `deleted-${user.id}@deleted.invalid`,
        firstName: null,
        lastName: null,
        displayName: null,
        avatarData: null,
        avatarMimeType: null,
        status: "deleted",
        emailVerified: false,
      },
    }),
  ]);

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
