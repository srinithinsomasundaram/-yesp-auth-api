import { zValidator } from "@hono/zod-validator";
import { createRouter } from "../../src/lib/hono.js";
import { z } from "zod";
import argon2 from "argon2";
import { authenticator } from "otplib";
import { requireAuth } from "../../src/middleware/auth.js";
import { mfaChallengeLimit, recoveryCodeLimit } from "../../src/middleware/rateLimit.js";
import { db } from "../../src/db/client.js";
import { generateToken } from "../../src/lib/crypto.js";
import { audit } from "../../src/lib/audit.js";

const router = createRouter();

router.get("/mfa/methods", requireAuth, async (c) => {
  const user = c.get("user");
  const methods = await db.mfaMethod.findMany({
    where: { userId: user.id, status: { not: "disabled" } },
    select: { id: true, type: true, status: true, createdAt: true, verifiedAt: true },
  });
  return c.json(methods);
});

// ─── TOTP Setup ───────────────────────────────────────────────────────────────

router.post("/mfa/totp/setup", requireAuth, async (c) => {
  const user = c.get("user");
  const secret = authenticator.generateSecret();

  const existing = await db.mfaMethod.findFirst({
    where: { userId: user.id, type: "totp" },
  });

  const method = existing
    ? await db.mfaMethod.update({
        where: { id: existing.id },
        data: { status: "pending", secretReference: secret },
      })
    : await db.mfaMethod.create({
        data: { userId: user.id, type: "totp", status: "pending", secretReference: secret },
      });

  const otpauth = authenticator.keyuri(user.email, "Yesp Auth", secret);

  return c.json({ methodId: method.id, secret, otpauthUrl: otpauth });
});

const totpVerifySchema = z.object({ methodId: z.string(), code: z.string().length(6) });

router.post("/mfa/totp/verify", requireAuth, zValidator("json", totpVerifySchema), async (c) => {
  const user = c.get("user");
  const { methodId, code } = c.req.valid("json");

  const method = await db.mfaMethod.findUnique({ where: { id: methodId, userId: user.id } });

  if (!method || method.type !== "totp" || !method.secretReference) {
    return c.json({ error: "not_found" }, 404);
  }

  const valid = authenticator.verify({ token: code, secret: method.secretReference });
  if (!valid) return c.json({ error: "invalid_code" }, 400);

  // Generate recovery codes — hashed with argon2id (not SHA-256) so they're
  // resistant to offline attacks if the DB is ever compromised
  const codes = Array.from({ length: 10 }, () => generateToken(12));
  const codeHashes = await Promise.all(codes.map((c) => argon2.hash(c, { type: argon2.argon2id })));

  await db.mfaMethod.update({ where: { id: methodId }, data: { status: "active", verifiedAt: new Date() } });
  await db.recoveryCode.deleteMany({ where: { mfaMethodId: methodId } });
  for (const hash of codeHashes) {
    await db.recoveryCode.create({ data: { mfaMethodId: methodId, codeHash: hash } });
  }

  await audit({
    eventType: "mfa.enabled",
    actorUserId: user.id,
    metadata: { type: "totp" },
  });

  return c.json({ success: true, recoveryCodes: codes });
});

// ─── TOTP Challenge (during login) ───────────────────────────────────────────

const totpChallengeSchema = z.object({
  userId: z.string(),
  code: z.string().length(6),
});

router.post("/mfa/totp/challenge", mfaChallengeLimit, zValidator("json", totpChallengeSchema), async (c) => {
  const { userId, code } = c.req.valid("json");

  const method = await db.mfaMethod.findFirst({
    where: { userId, type: "totp", status: "active" },
  });

  if (!method?.secretReference) return c.json({ error: "mfa_not_configured" }, 400);

  const valid = authenticator.verify({ token: code, secret: method.secretReference });
  if (!valid) return c.json({ error: "invalid_code" }, 401);

  await audit({ eventType: "mfa.verified", actorUserId: userId, metadata: { type: "totp" } });

  return c.json({ success: true });
});

// ─── Recovery Code ────────────────────────────────────────────────────────────

const recoverySchema = z.object({ userId: z.string(), code: z.string() });

router.post("/mfa/recovery", recoveryCodeLimit, zValidator("json", recoverySchema), async (c) => {
  const { userId, code } = c.req.valid("json");

  // Fetch unused codes for this user and verify with argon2 (constant-time)
  const candidates = await db.recoveryCode.findMany({
    where: { usedAt: null, mfaMethod: { userId } },
  });

  let recovery: typeof candidates[0] | null = null;
  for (const candidate of candidates) {
    if (await argon2.verify(candidate.codeHash, code)) {
      recovery = candidate;
      break;
    }
  }

  if (!recovery) return c.json({ error: "invalid_recovery_code" }, 401);

  await db.recoveryCode.update({ where: { id: recovery.id }, data: { usedAt: new Date() } });

  await audit({
    eventType: "mfa.recovery_code.used",
    actorUserId: userId,
  });

  return c.json({ success: true });
});

router.post("/mfa/disable", requireAuth, async (c) => {
  const user = c.get("user");

  await db.mfaMethod.updateMany({
    where: { userId: user.id },
    data: { status: "disabled" },
  });

  await audit({ eventType: "mfa.disabled", actorUserId: user.id });

  return c.json({ success: true });
});

export { router as mfaRouter };
