import type { Context, Next } from "hono";
import type { HireflowEnv } from "../hireflow.env.js";
import { db } from "../../src/db/client.js";

// ─── Permission map ───────────────────────────────────────────────────────────
// HireFlow roles and what each can do.
// org-level Yesp Auth roles (owner/admin) get full access automatically.

const ROLE_PERMISSIONS: Record<string, Set<string>> = {
  admin: new Set([
    "job.view", "job.create", "job.edit", "job.close",
    "candidate.view", "candidate.create", "candidate.edit",
    "application.view", "application.move", "application.reject",
    "interview.view", "interview.schedule", "interview.edit", "interview.cancel",
    "feedback.view", "feedback.submit",
    "task.view", "task.assign", "task.complete",
    "scorecard.manage", "pipeline.manage", "member.manage", "automation.manage",
  ]),
  manager: new Set([
    "job.view", "job.create", "job.edit", "job.close",
    "candidate.view", "candidate.create", "candidate.edit",
    "application.view", "application.move", "application.reject",
    "interview.view", "interview.schedule", "interview.edit", "interview.cancel",
    "feedback.view", "feedback.submit",
    "task.view", "task.assign", "task.complete",
    "scorecard.manage", "pipeline.manage",
  ]),
  recruiter: new Set([
    "job.view", "job.create", "job.edit",
    "candidate.view", "candidate.create", "candidate.edit",
    "application.view", "application.move", "application.reject",
    "interview.view", "interview.schedule", "interview.edit",
    "feedback.view",
    "task.view", "task.assign", "task.complete",
  ]),
  coordinator: new Set([
    "job.view",
    "candidate.view",
    "application.view", "application.move",
    "interview.view", "interview.schedule", "interview.edit",
    "feedback.view",
    "task.view", "task.complete",
  ]),
  interviewer: new Set([
    "job.view",
    "candidate.view",
    "application.view",
    "interview.view",
    "feedback.submit",
    "task.view", "task.complete",
  ]),
  member: new Set([
    "job.view",
    "candidate.view",
    "application.view",
    "interview.view",
    "task.view",
  ]),
};

// Yesp Auth org roles that map to HireFlow admin access
const ELEVATED_ORG_ROLES = new Set(["owner", "admin"]);

export async function getHfRole(orgId: string, userId: string, orgRole: string): Promise<string> {
  if (ELEVATED_ORG_ROLES.has(orgRole)) return "admin";
  const member = await db.hfMember.findUnique({
    where: { organizationId_userId: { organizationId: orgId, userId } },
    select: { role: true },
  });
  return member?.role ?? "member";
}

export function can(role: string, permission: string): boolean {
  return ROLE_PERMISSIONS[role]?.has(permission) ?? false;
}

// Middleware factory — require a specific permission
export function requirePermission(permission: string) {
  return async (c: Context<HireflowEnv>, next: Next) => {
    const orgId   = c.get("orgId");
    const orgRole = c.get("orgRole");
    const user    = c.get("user");

    const hfRole = await getHfRole(orgId, user.id, orgRole);

    if (!can(hfRole, permission)) {
      return c.json({ error: "forbidden", required: permission }, 403);
    }

    await next();
  };
}
