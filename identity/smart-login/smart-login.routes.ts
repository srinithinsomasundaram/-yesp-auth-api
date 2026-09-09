import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { createRouter } from "../../src/lib/hono.js";
import { requireAuth } from "../../src/middleware/auth.js";
import { redis } from "../../src/lib/redis.js";
import { db } from "../../src/db/client.js";
import { generateToken, hashToken } from "../../src/lib/crypto.js";
import { signAccessToken, signIdToken } from "../../src/lib/tokens.js";
import { env } from "../../src/lib/env.js";
import { audit } from "../../src/lib/audit.js";

const router = createRouter();

const SL_TTL = 300; // 5 minutes
const KEY = (token: string) => `sl:${token}`;

type SlStatus = "pending" | "scanned" | "approved" | "declined";

interface SlSession {
  status: SlStatus;
  requestInfo?: { userAgent: string; ip: string; createdAt: string };
  tokens?: { accessToken: string; idToken: string; refreshToken: string; expiresIn: number };
}

// ─── Init — waiting device creates a QR session ───────────────────────────────

router.post("/auth/smart-login/init", async (c) => {
  try {
    const token = generateToken(32);

    const session: SlSession = { status: "pending" };
    await redis.setex(KEY(token), SL_TTL, JSON.stringify(session));

    const origin = c.req.header("origin") ?? env.FRONTEND_URL;
    const qrUrl = `${origin}/auth/smart-login/approve?token=${token}`;

    return c.json({ token, qrUrl, expiresIn: SL_TTL });
  } catch (err) {
    console.error("[Smart Login init]", err);
    return c.json({ error: "service_unavailable" }, 503);
  }
});

// ─── Status — waiting device polls this ──────────────────────────────────────

router.get(
  "/auth/smart-login/status",
  zValidator("query", z.object({ token: z.string() })),
  async (c) => {
    const { token } = c.req.valid("query");

    const raw = await redis.get(KEY(token));
    if (!raw) return c.json({ status: "expired" });

    const session = JSON.parse(raw) as SlSession;

    if (session.status === "approved" && session.tokens) {
      // One-time — delete immediately after read
      await redis.del(KEY(token));
      return c.json({ status: "approved", tokens: session.tokens });
    }

    return c.json({
      status: session.status,
      requestInfo: session.requestInfo ?? null,
    });
  }
);

// ─── Scan — approving device calls this after opening the QR URL ─────────────

router.post(
  "/auth/smart-login/scan",
  zValidator("json", z.object({ token: z.string() })),
  async (c) => {
    const { token } = c.req.valid("json");

    const raw = await redis.get(KEY(token));
    if (!raw) return c.json({ error: "expired" }, 404);

    const session = JSON.parse(raw) as SlSession;
    if (session.status !== "pending") return c.json({ error: "already_processed" }, 409);

    session.status = "scanned";
    session.requestInfo = {
      userAgent: c.req.header("user-agent") ?? "Unknown browser",
      ip: c.req.header("x-forwarded-for")?.split(",")[0].trim() ?? "Unknown",
      createdAt: new Date().toISOString(),
    };

    const ttl = await redis.ttl(KEY(token));
    await redis.setex(KEY(token), Math.max(ttl, 1), JSON.stringify(session));

    return c.json({ status: "scanned", requestInfo: session.requestInfo });
  }
);

// ─── Approve — authenticated approving device grants/declines ─────────────────

router.post(
  "/auth/smart-login/approve",
  requireAuth,
  zValidator("json", z.object({ token: z.string(), approved: z.boolean() })),
  async (c) => {
    const user = c.get("user");
    const { token, approved } = c.req.valid("json");

    const raw = await redis.get(KEY(token));
    if (!raw) return c.json({ error: "expired" }, 404);

    const session = JSON.parse(raw) as SlSession;
    if (session.status === "approved" || session.status === "declined") {
      return c.json({ error: "already_processed" }, 409);
    }

    if (!approved) {
      session.status = "declined";
      const ttl = await redis.ttl(KEY(token));
      await redis.setex(KEY(token), Math.max(ttl, 1), JSON.stringify(session));

      await audit({
        eventType: "user.smart_login.declined",
        actorUserId: user.id,
        metadata: { token: token.slice(0, 8) },
      });

      return c.json({ success: true });
    }

    // Generate session + tokens for the waiting device
    const sessionExpiry = new Date(Date.now() + env.REFRESH_TOKEN_TTL * 1000);
    const dbSession = await db.session.create({
      data: { userId: user.id, expiresAt: sessionExpiry },
    });

    const refreshTokenRaw = generateToken();
    await db.refreshToken.create({
      data: {
        sessionId: dbSession.id,
        userId: user.id,
        tokenHash: hashToken(refreshTokenRaw),
        expiresAt: sessionExpiry,
      },
    });

    const [accessToken, idToken] = await Promise.all([
      signAccessToken({ sub: user.id, aud: "yesp-auth", scopes: ["openid", "profile", "email"] }),
      signIdToken({ sub: user.id, aud: "yesp-auth", email: user.email, name: user.displayName ?? undefined }),
    ]);

    session.status = "approved";
    session.tokens = {
      accessToken,
      idToken,
      refreshToken: refreshTokenRaw,
      expiresIn: env.ACCESS_TOKEN_TTL,
    };

    const ttl = await redis.ttl(KEY(token));
    await redis.setex(KEY(token), Math.max(ttl, 30), JSON.stringify(session));

    await audit({
      eventType: "user.smart_login.approved",
      actorUserId: user.id,
      metadata: { token: token.slice(0, 8) },
      ipAddress: session.requestInfo?.ip,
    });

    return c.json({ success: true });
  }
);

export { router as smartLoginRouter };
