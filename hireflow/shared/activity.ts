import { Prisma } from "@prisma/client";
import { db } from "../../src/db/client.js";

export function emitActivity(
  organizationId: string,
  applicationId: string,
  activityType: string,
  actorUserId: string | null,
  metadata: Prisma.InputJsonValue = {},
): Promise<void> {
  return db.hfApplicationActivity.create({
    data: { organizationId, applicationId, activityType, actorUserId, metadata },
  }).then(() => {}).catch(() => {});
}

export function emitAudit(
  organizationId: string,
  actorUserId: string | null,
  action: string,
  resourceType: string,
  resourceId: string,
  before?: unknown,
  after?: unknown,
  metadata: Prisma.InputJsonValue = {},
): Promise<void> {
  return db.hfAuditLog.create({
    data: {
      organizationId,
      actorUserId,
      action,
      resourceType,
      resourceId,
      before: before as never,
      after:  after  as never,
      metadata,
    },
  }).then(() => {}).catch(() => {});
}
