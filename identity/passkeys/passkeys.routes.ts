import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from "@simplewebauthn/server";
import type {
  AuthenticatorTransport,
  RegistrationResponseJSON,
  AuthenticationResponseJSON,
} from "@simplewebauthn/server";
import { createRouter } from "../../src/lib/hono.js";
import { requireAuth } from "../../src/middleware/auth.js";
import { passkeyAuthLimit } from "../../src/middleware/rateLimit.js";
import { db } from "../../src/db/client.js";
import { redis } from "../../src/lib/redis.js";
import { audit } from "../../src/lib/audit.js";
import { env } from "../../src/lib/env.js";

const router = createRouter();

const CHALLENGE_TTL = 300; // 5 minutes

// ─── List ─────────────────────────────────────────────────────────────────────

router.get("/passkeys", requireAuth, async (c) => {
  const user = c.get("user");
  const passkeys = await db.passkey.findMany({
    where: { userId: user.id },
    select: { id: true, deviceName: true, createdAt: true, lastUsedAt: true },
  });
  return c.json(passkeys);
});

// ─── Register: Options ────────────────────────────────────────────────────────

router.post("/passkeys/register/options", requireAuth, async (c) => {
  const user = c.get("user");

  const existing = await db.passkey.findMany({ where: { userId: user.id } });

  const options = await generateRegistrationOptions({
    rpName: env.WEBAUTHN_RP_NAME,
    rpID: env.WEBAUTHN_RP_ID,
    userName: user.email,
    userDisplayName: user.displayName ?? user.email,
    attestationType: "none",
    excludeCredentials: existing.map((p) => ({
      id: p.credentialId,
      transports: ["internal", "hybrid"] as AuthenticatorTransport[],
    })),
    authenticatorSelection: {
      residentKey: "preferred",
      userVerification: "required",
    },
  });

  await redis.setex(`passkey:reg:${user.id}`, CHALLENGE_TTL, options.challenge);

  return c.json(options);
});

// ─── Register: Verify ─────────────────────────────────────────────────────────

const registerVerifySchema = z.object({
  response: z.any(),
  deviceName: z.string().max(100).optional(),
});

router.post("/passkeys/register/verify", requireAuth, zValidator("json", registerVerifySchema), async (c) => {
  const user = c.get("user");
  const { response, deviceName } = c.req.valid("json");

  const challenge = await redis.get(`passkey:reg:${user.id}`);
  if (!challenge) return c.json({ error: "challenge_expired" }, 400);

  const verification = await verifyRegistrationResponse({
    response: response as RegistrationResponseJSON,
    expectedChallenge: challenge,
    expectedOrigin: env.WEBAUTHN_ORIGIN.split(",").map((o) => o.trim()),
    expectedRPID: env.WEBAUTHN_RP_ID,
    requireUserVerification: true,
  });

  if (!verification.verified || !verification.registrationInfo) {
    return c.json({ error: "verification_failed" }, 400);
  }

  await redis.del(`passkey:reg:${user.id}`);

  const { credential } = verification.registrationInfo;

  await db.passkey.create({
    data: {
      userId: user.id,
      credentialId: credential.id,
      publicKey: Buffer.from(credential.publicKey),
      counter: credential.counter,
      deviceName: deviceName ?? null,
    },
  });

  await audit({ eventType: "passkey.added", actorUserId: user.id });

  return c.json({ verified: true });
});

// ─── Authenticate: Options ────────────────────────────────────────────────────

const authenticateOptionsSchema = z.object({ email: z.string().email().toLowerCase() });

router.post("/passkeys/authenticate/options", passkeyAuthLimit, zValidator("json", authenticateOptionsSchema), async (c) => {
  const { email } = c.req.valid("json");

  const user = await db.user.findUnique({ where: { email, status: "active" } });
  if (!user) {
    // Return empty options to avoid enumeration
    const options = await generateAuthenticationOptions({ rpID: env.WEBAUTHN_RP_ID });
    return c.json(options);
  }

  const passkeys = await db.passkey.findMany({ where: { userId: user.id } });

  const options = await generateAuthenticationOptions({
    rpID: env.WEBAUTHN_RP_ID,
    allowCredentials: passkeys.map((p) => ({
      id: p.credentialId,
      transports: ["internal", "hybrid"] as AuthenticatorTransport[],
    })),
    userVerification: "required",
  });

  await redis.setex(`passkey:auth:${user.id}`, CHALLENGE_TTL, options.challenge);

  return c.json({ ...options, userId: user.id });
});

// ─── Authenticate: Verify ─────────────────────────────────────────────────────

const authenticateVerifySchema = z.object({
  userId: z.string(),
  response: z.any(),
});

router.post("/passkeys/authenticate/verify", passkeyAuthLimit, zValidator("json", authenticateVerifySchema), async (c) => {
  const { userId, response } = c.req.valid("json");

  const challenge = await redis.get(`passkey:auth:${userId}`);
  if (!challenge) return c.json({ error: "challenge_expired" }, 400);

  const authResponse = response as AuthenticationResponseJSON;

  const passkey = await db.passkey.findUnique({ where: { credentialId: authResponse.id } });
  if (!passkey || passkey.userId !== userId) return c.json({ error: "invalid_credential" }, 401);

  const verification = await verifyAuthenticationResponse({
    response: authResponse,
    expectedChallenge: challenge,
    expectedOrigin: env.WEBAUTHN_ORIGIN.split(",").map((o) => o.trim()),
    expectedRPID: env.WEBAUTHN_RP_ID,
    requireUserVerification: true,
    credential: {
      id: passkey.credentialId,
      publicKey: new Uint8Array(passkey.publicKey),
      counter: Number(passkey.counter),
    },
  });

  if (!verification.verified) return c.json({ error: "verification_failed" }, 401);

  await redis.del(`passkey:auth:${userId}`);

  await db.passkey.update({
    where: { id: passkey.id },
    data: {
      counter: verification.authenticationInfo.newCounter,
      lastUsedAt: new Date(),
    },
  });

  const user = await db.user.findUnique({ where: { id: userId, status: "active" } });
  if (!user) return c.json({ error: "user_not_found" }, 401);

  const { signAccessToken, signIdToken } = await import("../../src/lib/tokens.js");
  const { generateToken, hashToken } = await import("../../src/lib/crypto.js");
  const { env: envLib } = await import("../../src/lib/env.js");

  const sessionExpiry = new Date(Date.now() + envLib.REFRESH_TOKEN_TTL * 1000);
  const session = await db.session.create({
    data: { userId, expiresAt: sessionExpiry },
  });

  const refreshTokenRaw = generateToken();
  await db.refreshToken.create({
    data: {
      sessionId: session.id,
      userId,
      tokenHash: hashToken(refreshTokenRaw),
      expiresAt: sessionExpiry,
    },
  });

  const [accessToken, idToken] = await Promise.all([
    signAccessToken({ sub: userId, aud: "yesp-auth", scopes: ["openid", "profile", "email"] }),
    signIdToken({ sub: userId, aud: "yesp-auth", email: user.email, name: user.displayName ?? undefined }),
  ]);

  await audit({
    eventType: "user.login.success",
    actorUserId: userId,
    metadata: { method: "passkey" },
    ipAddress: c.req.header("x-forwarded-for") ?? undefined,
  });

  return c.json({
    accessToken,
    idToken,
    refreshToken: refreshTokenRaw,
    tokenType: "Bearer",
    expiresIn: envLib.ACCESS_TOKEN_TTL,
  });
});

// ─── Delete ───────────────────────────────────────────────────────────────────

router.delete("/passkeys/:id", requireAuth, async (c) => {
  const user = c.get("user");
  const { id } = c.req.param();

  const passkey = await db.passkey.findUnique({ where: { id } });
  if (!passkey || passkey.userId !== user.id) return c.json({ error: "not_found" }, 404);

  await db.passkey.delete({ where: { id } });

  await audit({ eventType: "passkey.removed", actorUserId: user.id, targetType: "passkey", targetId: id });

  return c.json({ success: true });
});

export { router as passkeysRouter };
