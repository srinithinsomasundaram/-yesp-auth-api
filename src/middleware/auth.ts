import type { Next } from "hono";
import type { AppEnv } from "../lib/hono.js";
import type { Context } from "hono";
import { verifyToken } from "../lib/tokens.js";
import { db } from "../db/client.js";

export async function requireAuth(c: Context<AppEnv>, next: Next) {
  const authorization = c.req.header("Authorization");
  if (!authorization?.startsWith("Bearer ")) {
    return c.json({ error: "unauthorized" }, 401);
  }

  const token = authorization.slice(7);

  try {
    const payload = await verifyToken(token);
    if (!payload.sub) return c.json({ error: "unauthorized" }, 401);

    const user = await db.user.findUnique({
      where: { id: payload.sub, status: "active" },
      include: {
        sessions: {
          where: { revokedAt: null, expiresAt: { gt: new Date() } },
          take: 1,
          orderBy: { lastActivityAt: "desc" },
        },
      },
    });

    if (!user) return c.json({ error: "unauthorized" }, 401);

    // Reject if every session for this user has been revoked (logout-all was called)
    // We check at least one active session exists to confirm the token family is valid.
    // Note: for short-lived access tokens (15 min) this is a belt-and-suspenders check.
    if (user.sessions.length === 0) {
      return c.json({ error: "session_revoked" }, 401);
    }

    c.set("user", user);
    c.set("tokenPayload", payload);
    await next();
  } catch {
    return c.json({ error: "unauthorized" }, 401);
  }
}

export async function requestId(c: Context<AppEnv>, next: Next) {
  const id = c.req.header("x-request-id") ?? crypto.randomUUID();
  c.header("X-Request-ID", id);
  await next();
}
