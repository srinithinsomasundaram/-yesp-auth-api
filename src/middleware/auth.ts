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
    });

    if (!user) return c.json({ error: "unauthorized" }, 401);

    c.set("user", user);
    c.set("tokenPayload", payload);
    await next();
  } catch {
    return c.json({ error: "unauthorized" }, 401);
  }
}
