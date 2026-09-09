import { db } from "../db/client.js";

export type AuditEventType =
  | "user.registered"
  | "user.email.verification.sent"
  | "user.email.verified"
  | "user.login.success"
  | "user.login.failed"
  | "user.logout"
  | "user.logout.all"
  | "user.deleted"
  | "password.changed"
  | "password.reset.requested"
  | "password.reset.completed"
  | "passkey.added"
  | "passkey.removed"
  | "mfa.enabled"
  | "mfa.disabled"
  | "mfa.verified"
  | "mfa.recovery_code.used"
  | "session.revoked"
  | "session.all_revoked"
  | "organization.created"
  | "organization.user.invited"
  | "organization.user.joined"
  | "organization.user.removed"
  | "organization.user.role.changed"
  | "sso.configuration.changed"
  | "oauth.code.issued"
  | "oauth.token.issued"
  | "oauth.token.revoked"
  | "user.smart_login.approved"
  | "user.smart_login.declined"
  | "organization.app.granted"
  | "organization.app.revoked"
  | "organization.security.policy.updated"
  | "admin.app.registered"
  | "admin.app.updated"
  | "admin.app.deleted"
  | "user.email.change.requested"
  | "user.email.changed"
  | "user.password.changed";

interface AuditParams {
  eventType: AuditEventType;
  actorUserId?: string;
  organizationId?: string;
  applicationId?: string;
  targetType?: string;
  targetId?: string;
  ipAddress?: string;
  userAgent?: string;
  metadata?: Record<string, unknown>;
}

export async function audit(params: AuditParams): Promise<void> {
  try {
    await db.auditEvent.create({
      data: {
        eventType: params.eventType,
        actorUserId: params.actorUserId,
        organizationId: params.organizationId,
        applicationId: params.applicationId,
        targetType: params.targetType,
        targetId: params.targetId,
        ipAddress: params.ipAddress,
        userAgent: params.userAgent,
        metadata: (params.metadata ?? {}) as Record<string, string | number | boolean | null>,
      },
    });
  } catch (err) {
    // Audit failure must not crash the main flow but must be visible
    console.error("[AUDIT ERROR]", params.eventType, err);
  }
}
