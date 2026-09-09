import type { Context, Next } from "hono";
import type { AppEnv } from "../../../lib/hono.js";
import { db } from "../../../db/client.js";

export type PolicyViolation =
  | { code: "mfa_required"; message: string }
  | { code: "sso_required"; message: string }
  | { code: "auth_method_not_allowed"; message: string }
  | { code: "session_expired"; message: string };

export async function checkOrgPolicy(
  userId: string,
  organizationId: string
): Promise<PolicyViolation | null> {
  const policy = await db.organizationSecurityPolicy.findUnique({
    where: { organizationId },
  });

  if (!policy) return null;

  // Check session max age
  const activeSessions = await db.session.findMany({
    where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { lastActivityAt: "desc" },
    take: 1,
  });

  if (activeSessions.length > 0) {
    const session = activeSessions[0];
    const sessionAge = (Date.now() - session.createdAt.getTime()) / 1000;
    if (sessionAge > policy.sessionMaxAgeSecs) {
      return { code: "session_expired", message: "Session has exceeded the organization's maximum age policy." };
    }
  }

  // Check MFA requirement
  if (policy.requireMfa) {
    const activeMfa = await db.mfaMethod.findFirst({
      where: { userId, status: "active" },
    });
    if (!activeMfa) {
      return {
        code: "mfa_required",
        message: "This organization requires multi-factor authentication.",
      };
    }
  }

  // Check SSO requirement
  if (policy.requireSso) {
    const ssoCredential = await db.credential.findFirst({
      where: { userId, credentialType: "enterprise_sso" },
    });
    if (!ssoCredential) {
      return {
        code: "sso_required",
        message: "This organization requires authentication via enterprise SSO.",
      };
    }
  }

  // Check allowed auth methods
  if (policy.allowedAuthMethods.length > 0) {
    const userCredentials = await db.credential.findMany({ where: { userId } });
    const userMethods = userCredentials.map((c) => c.credentialType);
    const hasAllowedMethod = userMethods.some((m) =>
      policy.allowedAuthMethods.includes(m)
    );
    if (!hasAllowedMethod) {
      return {
        code: "auth_method_not_allowed",
        message: "Your authentication method is not permitted by this organization's policy.",
      };
    }
  }

  return null;
}

// Middleware factory — use on routes that need org policy enforcement
export function requireOrgPolicy(getOrgId: (c: Context<AppEnv>) => string) {
  return async (c: Context<AppEnv>, next: Next) => {
    const user = c.get("user");
    const orgId = getOrgId(c);

    const violation = await checkOrgPolicy(user.id, orgId);
    if (violation) {
      return c.json({ error: violation.code, message: violation.message }, 403);
    }

    await next();
  };
}
