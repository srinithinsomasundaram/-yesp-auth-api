import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { createRouter } from "../../src/lib/hono.js";
import { db } from "../../src/db/client.js";
import { hashPassword, verifyPassword, isStrongPassword } from "../../src/lib/password.js";
import { generateToken, hashToken } from "../../src/lib/crypto.js";
import { signAccessToken, signIdToken } from "../../src/lib/tokens.js";
import { audit } from "../../src/lib/audit.js";
import {
  loginRateLimit,
  registerLimit,
  emailVerifyLimit,
  passwordResetRequestLimit,
  passwordResetConfirmLimit,
  tokenRefreshLimit,
} from "../../src/middleware/rateLimit.js";
import { requireAuth } from "../../src/middleware/auth.js";
import { env } from "../../src/lib/env.js";
import {
  sendVerificationEmail,
  sendPasswordResetEmail,
} from "../../src/modules/shared/notifications/notifications.service.js";

const router = createRouter();

function setRefreshCookie(c: Parameters<typeof setCookie>[0], token: string, maxAge: number) {
  setCookie(c, "yesp_rt", token, {
    httpOnly: true,
    sameSite: "Lax",
    path: "/",
    maxAge,
    secure: env.NODE_ENV === "production",
  });
}

// ─── Register ─────────────────────────────────────────────────────────────────

const registerSchema = z.object({
  email: z.string().email().toLowerCase(),
  password: z.string().min(12),
  firstName: z.string().min(1).max(100).optional(),
  lastName: z.string().min(1).max(100).optional(),
});

router.post("/auth/register", registerLimit, zValidator("json", registerSchema), async (c) => {
  const body = c.req.valid("json");

  if (!isStrongPassword(body.password)) {
    return c.json({ error: "password_too_weak" }, 422);
  }

  const existing = await db.user.findUnique({ where: { email: body.email } });
  if (existing) {
    // Avoid email enumeration — return same shape
    return c.json({ message: "If this email is new, a verification email has been sent." }, 200);
  }

  const user = await db.user.create({
    data: {
      email: body.email,
      firstName: body.firstName,
      lastName: body.lastName,
      displayName: body.firstName
        ? [body.firstName, body.lastName].filter(Boolean).join(" ")
        : undefined,
      credentials: {
        create: {
          credentialType: "password",
          passwordHash: await hashPassword(body.password),
        },
      },
    },
  });

  const token = generateToken();
  await db.emailVerification.create({
    data: {
      userId: user.id,
      tokenHash: hashToken(token),
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    },
  });

  await sendVerificationEmail(user.email, token).catch(() => {});

  await audit({
    eventType: "user.registered",
    actorUserId: user.id,
    targetType: "user",
    targetId: user.id,
    ipAddress: c.req.header("x-forwarded-for") ?? undefined,
  });

  return c.json({ message: "If this email is new, a verification email has been sent." }, 201);
});

// ─── Verify Email ─────────────────────────────────────────────────────────────

const verifyEmailSchema = z.object({ token: z.string() });

router.post("/auth/email/verify", emailVerifyLimit, zValidator("json", verifyEmailSchema), async (c) => {
  const { token } = c.req.valid("json");
  const tokenHash = hashToken(token);

  const record = await db.emailVerification.findUnique({ where: { tokenHash } });

  if (!record || record.usedAt || record.expiresAt < new Date()) {
    return c.json({ error: "invalid_or_expired_token" }, 400);
  }

  await db.$transaction([
    db.emailVerification.update({
      where: { id: record.id },
      data: { usedAt: new Date() },
    }),
    db.user.update({
      where: { id: record.userId },
      data: { emailVerified: true },
    }),
  ]);

  await audit({
    eventType: "user.email.verified",
    actorUserId: record.userId,
    targetType: "user",
    targetId: record.userId,
  });

  return c.json({ success: true });
});

// ─── Login ────────────────────────────────────────────────────────────────────

const loginSchema = z.object({
  email: z.string().email().toLowerCase(),
  password: z.string(),
});

router.post("/auth/password/login", loginRateLimit, zValidator("json", loginSchema), async (c) => {
  const body = c.req.valid("json");
  const ip = c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  const userAgent = c.req.header("user-agent") ?? undefined;

  const recordAttempt = (success: boolean, userId?: string) =>
    db.loginAttempt.create({
      data: { identifier: body.email, ipAddress: ip, success },
    }).then(() =>
      audit({
        eventType: success ? "user.login.success" : "user.login.failed",
        actorUserId: userId,
        ipAddress: ip,
        userAgent,
        metadata: { email: body.email },
      })
    );

  const user = await db.user.findUnique({
    where: { email: body.email },
    include: { credentials: { where: { credentialType: "password" } } },
  });

  if (!user || user.status !== "active" || !user.credentials[0]?.passwordHash) {
    await recordAttempt(false);
    return c.json({ error: "invalid_credentials" }, 401);
  }

  const valid = await verifyPassword(user.credentials[0].passwordHash, body.password);
  if (!valid) {
    await recordAttempt(false, user.id);
    return c.json({ error: "invalid_credentials" }, 401);
  }

  await db.credential.update({
    where: { id: user.credentials[0].id },
    data: { lastUsedAt: new Date() },
  });

  const sessionExpiry = new Date(Date.now() + env.REFRESH_TOKEN_TTL * 1000);
  const session = await db.session.create({
    data: {
      userId: user.id,
      expiresAt: sessionExpiry,
      lastActivityAt: new Date(),
    },
  });

  const refreshTokenRaw = generateToken();
  await db.refreshToken.create({
    data: {
      sessionId: session.id,
      userId: user.id,
      tokenHash: hashToken(refreshTokenRaw),
      expiresAt: sessionExpiry,
    },
  });

  const [accessToken, idToken] = await Promise.all([
    signAccessToken({
      sub: user.id,
      aud: "yesp-auth",
      scopes: ["openid", "profile", "email"],
    }),
    signIdToken({
      sub: user.id,
      aud: "yesp-auth",
      email: user.email,
      name: user.displayName ?? undefined,
    }),
  ]);

  const ssoToken = generateToken();
  await db.ssoSession.create({
    data: {
      userId: user.id,
      tokenHash: hashToken(ssoToken),
      expiresAt: sessionExpiry,
      ipAddress: ip,
      userAgent,
    },
  });

  await recordAttempt(true, user.id);

  setRefreshCookie(c, refreshTokenRaw, env.REFRESH_TOKEN_TTL);

  return c.json({
    accessToken,
    idToken,
    refreshToken: refreshTokenRaw,
    ssoToken,
    tokenType: "Bearer",
    expiresIn: env.ACCESS_TOKEN_TTL,
  });
});

// ─── Refresh Token ────────────────────────────────────────────────────────────

router.post("/auth/token/refresh", tokenRefreshLimit, async (c) => {
  let bodyToken: string | undefined;
  try {
    const body = await c.req.json() as { refreshToken?: string };
    bodyToken = body?.refreshToken;
  } catch { /* no body or invalid JSON — fine, use cookie */ }

  const refreshToken = bodyToken ?? getCookie(c, "yesp_rt");
  if (!refreshToken) return c.json({ error: "invalid_refresh_token" }, 401);
  const tokenHash = hashToken(refreshToken);

  const record = await db.refreshToken.findUnique({
    where: { tokenHash },
    include: { session: true, user: true },
  });

  if (
    !record ||
    record.usedAt ||
    record.revokedAt ||
    record.expiresAt < new Date() ||
    record.session.revokedAt ||
    record.user.status !== "active"
  ) {
    // Possible reuse — revoke the session family
    if (record?.sessionId) {
      await db.session.update({
        where: { id: record.sessionId },
        data: { revokedAt: new Date() },
      });
    }
    return c.json({ error: "invalid_refresh_token" }, 401);
  }

  await db.$transaction(async (tx: Prisma.TransactionClient) => {
    await tx.refreshToken.update({ where: { id: record.id }, data: { usedAt: new Date() } });
    await tx.session.update({
      where: { id: record.sessionId },
      data: { lastActivityAt: new Date() },
    });
  });

  const newRefreshRaw = generateToken();
  await db.refreshToken.create({
    data: {
      sessionId: record.sessionId,
      userId: record.userId,
      tokenHash: hashToken(newRefreshRaw),
      expiresAt: record.expiresAt,
    },
  });

  const accessToken = await signAccessToken({
    sub: record.userId,
    aud: "yesp-auth",
    scopes: ["openid", "profile", "email"],
  });

  const remainingSecs = Math.max(0, Math.floor((record.expiresAt.getTime() - Date.now()) / 1000));
  setRefreshCookie(c, newRefreshRaw, remainingSecs);

  return c.json({
    accessToken,
    refreshToken: newRefreshRaw,
    tokenType: "Bearer",
    expiresIn: env.ACCESS_TOKEN_TTL,
  });
});

// ─── Logout ───────────────────────────────────────────────────────────────────

router.post("/auth/logout", requireAuth, async (c) => {
  const user = c.get("user");

  deleteCookie(c, "yesp_rt", { path: "/" });

  await audit({
    eventType: "user.logout",
    actorUserId: user.id,
    ipAddress: c.req.header("x-forwarded-for") ?? undefined,
  });

  return c.json({ success: true });
});

router.post("/auth/logout-all", requireAuth, async (c) => {
  const user = c.get("user");

  deleteCookie(c, "yesp_rt", { path: "/" });

  await db.session.updateMany({
    where: { userId: user.id, revokedAt: null },
    data: { revokedAt: new Date() },
  });

  await audit({
    eventType: "user.logout.all",
    actorUserId: user.id,
    ipAddress: c.req.header("x-forwarded-for") ?? undefined,
  });

  return c.json({ success: true });
});

// ─── Password Reset Request ───────────────────────────────────────────────────

const resetRequestSchema = z.object({ email: z.string().email().toLowerCase() });

router.post("/auth/password/reset/request", passwordResetRequestLimit, zValidator("json", resetRequestSchema), async (c) => {
  const { email } = c.req.valid("json");

  const user = await db.user.findUnique({ where: { email, status: "active" } });

  if (user) {
    const token = generateToken();
    await db.passwordReset.create({
      data: {
        userId: user.id,
        tokenHash: hashToken(token),
        expiresAt: new Date(Date.now() + 60 * 60 * 1000), // 1 hour
      },
    });

    await sendPasswordResetEmail(user.email, token).catch(() => {});

    await audit({
      eventType: "password.reset.requested",
      actorUserId: user.id,
      targetType: "user",
      targetId: user.id,
      ipAddress: c.req.header("x-forwarded-for") ?? undefined,
    });
  }

  return c.json({ message: "If an account exists for this email, a reset link has been sent." });
});

// ─── Password Reset Confirm ───────────────────────────────────────────────────

const resetConfirmSchema = z.object({
  token: z.string(),
  password: z.string().min(12),
});

router.post("/auth/password/reset/confirm", passwordResetConfirmLimit, zValidator("json", resetConfirmSchema), async (c) => {
  const { token, password } = c.req.valid("json");

  if (!isStrongPassword(password)) {
    return c.json({ error: "password_too_weak" }, 422);
  }

  const tokenHash = hashToken(token);
  const record = await db.passwordReset.findUnique({ where: { tokenHash } });

  if (!record || record.usedAt || record.expiresAt < new Date()) {
    return c.json({ error: "invalid_or_expired_token" }, 400);
  }

  const newHash = await hashPassword(password);

  await db.$transaction([
    db.passwordReset.update({ where: { id: record.id }, data: { usedAt: new Date() } }),
    db.credential.upsert({
      where: { userId_credentialType: { userId: record.userId, credentialType: "password" } },
      create: { userId: record.userId, credentialType: "password", passwordHash: newHash },
      update: { passwordHash: newHash, updatedAt: new Date() },
    }),
    // Revoke all active sessions for security
    db.session.updateMany({
      where: { userId: record.userId, revokedAt: null },
      data: { revokedAt: new Date() },
    }),
  ]);

  await audit({
    eventType: "password.reset.completed",
    actorUserId: record.userId,
    targetType: "user",
    targetId: record.userId,
    ipAddress: c.req.header("x-forwarded-for") ?? undefined,
  });

  return c.json({ success: true });
});

// ─── Redirect URI validation ──────────────────────────────────────────────────
// Called by the login page before login to validate a redirect_uri + client_id.
// No auth required — this is a public endpoint (returns no sensitive data).

router.get("/auth/redirect-validate", async (c) => {
  const { client_id, redirect_uri } = c.req.query();

  if (!redirect_uri) return c.json({ valid: false, reason: "missing_redirect_uri" }, 400);

  // Built-in: the accounts console bridge is always valid (it's the home app)
  if (redirect_uri === `${env.FRONTEND_URL}/bridge`) {
    return c.json({ valid: true, appName: "Yesp Accounts", slug: "yesp-accounts" });
  }

  // All other redirect URIs require a registered client_id
  if (!client_id) return c.json({ valid: false, reason: "missing_client_id" });

  const client = await db.oAuthClient.findUnique({
    where: { clientId: client_id, status: "active" },
    include: { application: { select: { name: true, slug: true } } },
  });

  if (!client) return c.json({ valid: false, reason: "invalid_client" });
  if (!client.redirectUris.includes(redirect_uri)) return c.json({ valid: false, reason: "redirect_uri_mismatch" });

  return c.json({ valid: true, appName: client.application.name, slug: client.application.slug });
});

export { router as authRouter };
