import { setCookie } from "hono/cookie";
import { createRouter } from "../../src/lib/hono.js";
import { authCheckLimit, oauthExchangeLimit } from "../../src/middleware/rateLimit.js";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { env } from "../../src/lib/env.js";
import { redis } from "../../src/lib/redis.js";
import { db } from "../../src/db/client.js";
import { generateToken, hashToken } from "../../src/lib/crypto.js";
import { signAccessToken, signIdToken } from "../../src/lib/tokens.js";
import { audit } from "../../src/lib/audit.js";

const router = createRouter();

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function createSessionTokens(userId: string, email: string, name?: string) {
  const sessionExpiry = new Date(Date.now() + env.REFRESH_TOKEN_TTL * 1000);
  const session = await db.session.create({ data: { userId, expiresAt: sessionExpiry } });

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
    signIdToken({ sub: userId, aud: "yesp-auth", email, name }),
  ]);

  // One-time exchange code stored in Redis for 90 seconds
  const otp = generateToken(24);
  await redis.setex(
    `oauth:otp:${otp}`,
    90,
    JSON.stringify({ accessToken, refreshToken: refreshTokenRaw, idToken })
  );

  return otp;
}

async function upsertSocialUser(data: {
  email: string;
  firstName?: string | null;
  lastName?: string | null;
  displayName?: string | null;
  provider: string;
}) {
  const { email, firstName, lastName, displayName, provider } = data;
  let user = await db.user.findUnique({ where: { email } });

  if (!user) {
    user = await db.user.create({
      data: {
        email,
        firstName: firstName ?? null,
        lastName: lastName ?? null,
        displayName: displayName ?? null,
        emailVerified: true,
        status: "active",
      },
    });
  } else if (!user.emailVerified) {
    await db.user.update({ where: { id: user.id }, data: { emailVerified: true } });
  }

  await audit({ eventType: "user.login.success", actorUserId: user.id, metadata: { method: provider } });
  return user;
}

// ─── Google OAuth ─────────────────────────────────────────────────────────────

router.get("/auth/google", async (c) => {
  if (!env.GOOGLE_CLIENT_ID) {
    return c.redirect(`${env.FRONTEND_URL}/auth/login?error=google_not_configured`);
  }

  try {
    const state = generateToken(16);
    await redis.setex(`oauth:state:${state}`, 300, "google");

    const params = new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      redirect_uri: `${env.BACKEND_URL}/api/v1/auth/google/callback`,
      response_type: "code",
      scope: "openid email profile",
      state,
      access_type: "offline",
      prompt: "select_account",
    });

    return c.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
  } catch (err) {
    console.error("[Google OAuth init]", err);
    return c.redirect(`${env.FRONTEND_URL}/auth/login?error=AUTH_OAUTH_FAILED`);
  }
});

router.get("/auth/google/callback", async (c) => {
  const { code, state, error } = c.req.query();

  if (error || !code || !state) {
    return c.redirect(`${env.FRONTEND_URL}/auth/login?error=AUTH_OAUTH_CANCELLED`);
  }

  const savedState = await redis.get(`oauth:state:${state}`);
  if (savedState !== "google") {
    return c.redirect(`${env.FRONTEND_URL}/auth/login?error=AUTH_INVALID_STATE`);
  }
  await redis.del(`oauth:state:${state}`);

  try {
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: env.GOOGLE_CLIENT_ID!,
        client_secret: env.GOOGLE_CLIENT_SECRET!,
        redirect_uri: `${env.BACKEND_URL}/api/v1/auth/google/callback`,
        grant_type: "authorization_code",
      }),
    });

    if (!tokenRes.ok) throw new Error("token_exchange_failed");

    const { access_token } = await tokenRes.json() as { access_token: string };

    const userRes = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
      headers: { Authorization: `Bearer ${access_token}` },
    });

    const info = await userRes.json() as {
      email: string;
      given_name?: string;
      family_name?: string;
      name?: string;
    };

    const user = await upsertSocialUser({
      email: info.email.toLowerCase(),
      firstName: info.given_name,
      lastName: info.family_name,
      displayName: info.name,
      provider: "google",
    });

    const otp = await createSessionTokens(user.id, info.email.toLowerCase(), info.name);
    return c.redirect(`${env.FRONTEND_URL}/auth/oauth/callback?code=${otp}`);
  } catch (err) {
    console.error("[Google OAuth]", err);
    return c.redirect(`${env.FRONTEND_URL}/auth/login?error=AUTH_OAUTH_FAILED`);
  }
});

// ─── OTP Exchange — frontend exchanges one-time code for real tokens ──────────

router.post(
  "/auth/oauth/exchange",
  oauthExchangeLimit,
  zValidator("json", z.object({ code: z.string() })),
  async (c) => {
    const { code } = c.req.valid("json");

    const raw = await redis.get(`oauth:otp:${code}`);
    if (!raw) return c.json({ error: "AUTH_OAUTH_CODE_EXPIRED" }, 400);

    await redis.del(`oauth:otp:${code}`);
    const payload = JSON.parse(raw) as { accessToken: string; refreshToken: string; idToken: string };
    setCookie(c, "yesp_rt", payload.refreshToken, {
      httpOnly: true,
      sameSite: "Lax",
      path: "/",
      maxAge: env.REFRESH_TOKEN_TTL,
      secure: env.NODE_ENV === "production",
    });
    return c.json(payload);
  }
);

// ─── Email/domain check — helps frontend show right auth methods ──────────────

router.post(
  "/auth/check",
  authCheckLimit,
  zValidator("json", z.object({ email: z.string().email() })),
  async (c) => {
    const { email } = c.req.valid("json");
    const domain = email.split("@")[1]?.toLowerCase();

    const ssoConnection = domain
      ? await db.enterpriseSsoConnection.findFirst({
          where: { domains: { has: domain }, status: "active" },
          select: { id: true, protocol: true, domains: true },
        })
      : null;

    const user = domain
      ? await db.user.findUnique({ where: { email }, select: { id: true } })
      : null;

    const passkeyCount = user
      ? await db.passkey.count({ where: { userId: user.id } })
      : 0;

    return c.json({
      exists: !!user,
      sso: ssoConnection
        ? { connectionId: ssoConnection.id, provider: ssoConnection.protocol, domain: ssoConnection.domains[0] ?? domain }
        : null,
      hasPasskey: passkeyCount > 0,
      google: !!env.GOOGLE_CLIENT_ID,
    });
  }
);

export { router as socialAuthRouter };
