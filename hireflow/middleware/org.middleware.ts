import type { Context, Next } from "hono";
import type { HireflowEnv } from "../hireflow.env.js";
import { db } from "../../src/db/client.js";

/**
 * Validates that the authenticated user is an active member of the org
 * referenced by :orgId in the URL. Sets ctx.orgId and ctx.orgRole.
 *
 * Must run after requireAuth.
 */
export async function requireOrgMember(c: Context<HireflowEnv>, next: Next) {
  const orgId = c.req.param("orgId");
  if (!orgId) return c.json({ error: "missing_org_id" }, 400);

  const user = c.get("user");

  const membership = await db.organizationMembership.findFirst({
    where: { organizationId: orgId, userId: user.id, status: "active" },
  });

  if (!membership) return c.json({ error: "forbidden" }, 403);

  c.set("orgId", orgId);
  c.set("orgRole", membership.role);
  await next();
}
