import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { createHfRouter } from "../hireflow.env.js";
import { db } from "../../src/db/client.js";
import { requirePermission } from "../middleware/permissions.middleware.js";
import { emitActivity, emitAudit } from "../shared/activity.js";

const router = createHfRouter();

// Panel status machine
// pending → scheduling → in_progress → feedback_pending → completed
//                    ↘ cancelled (from any state)
const VALID_PANEL_TRANSITIONS: Record<string, string[]> = {
  pending:          ["scheduling", "in_progress", "cancelled"],
  scheduling:       ["in_progress", "cancelled"],
  in_progress:      ["feedback_pending", "completed", "cancelled"],
  feedback_pending: ["completed", "cancelled"],
  completed:        [],
  cancelled:        [],
};

const RECOMMENDATIONS = ["strong_hire", "hire", "no_hire", "strong_no_hire"] as const;

const createPanelSchema = z.object({
  name:               z.string().min(1).max(255),
  sequence:           z.number().int().min(0).default(0),
  isRequired:         z.boolean().default(true),
  scorecardId:        z.string().uuid().optional().nullable(),
  feedbackDeadlineAt: z.string().datetime().optional().nullable(),
  members: z.array(z.object({
    userId:          z.string().uuid(),
    role:            z.enum(["lead", "interviewer", "observer"]).default("interviewer"),
    feedbackRequired: z.boolean().default(true),
  })).optional(),
});

const patchPanelSchema = z.object({
  name:               z.string().min(1).max(255).optional(),
  sequence:           z.number().int().min(0).optional(),
  isRequired:         z.boolean().optional(),
  scorecardId:        z.string().uuid().optional().nullable(),
  feedbackDeadlineAt: z.string().datetime().optional().nullable(),
  recommendation:     z.enum(RECOMMENDATIONS).optional().nullable(),
});

const PANEL_INCLUDE = {
  scorecard: { select: { id: true, name: true } },
  members:   true,
  interviews: {
    include: {
      participants: true,
      feedbacks:    { select: { id: true, participantId: true, recommendation: true, submittedAt: true, overallScore: true } },
    },
    orderBy: { scheduledStart: "asc" as const },
  },
} as const;

// ─── GET /applications/:appId/panels ──────────────────────────────────────────

router.get("/applications/:appId/panels", requirePermission("interview.view"), async (c) => {
  const orgId = c.get("orgId");
  const appId = c.req.param("appId");

  const app = await db.hfApplication.findFirst({ where: { id: appId, organizationId: orgId, deletedAt: null } });
  if (!app) return c.json({ error: "application_not_found" }, 404);

  const panels = await db.hfInterviewPanel.findMany({
    where: { applicationId: appId, organizationId: orgId },
    include: PANEL_INCLUDE,
    orderBy: { sequence: "asc" },
  });

  return c.json(panels.map(enrichPanel));
});

// ─── POST /applications/:appId/panels ─────────────────────────────────────────

router.post("/applications/:appId/panels", requirePermission("interview.schedule"), zValidator("json", createPanelSchema), async (c) => {
  const orgId = c.get("orgId");
  const user  = c.get("user");
  const appId = c.req.param("appId");
  const body  = c.req.valid("json");

  const app = await db.hfApplication.findFirst({ where: { id: appId, organizationId: orgId, deletedAt: null } });
  if (!app) return c.json({ error: "application_not_found" }, 404);

  const panel = await db.hfInterviewPanel.create({
    data: {
      organizationId:      orgId,
      applicationId:       appId,
      name:                body.name,
      sequence:            body.sequence,
      isRequired:          body.isRequired,
      scorecardId:         body.scorecardId         ?? null,
      feedbackDeadlineAt:  body.feedbackDeadlineAt  ? new Date(body.feedbackDeadlineAt) : null,
      createdByUserId:     user.id,
      members: body.members?.length ? {
        create: body.members.map(m => ({
          userId:           m.userId,
          role:             m.role,
          feedbackRequired: m.feedbackRequired,
        })),
      } : undefined,
    },
    include: PANEL_INCLUDE,
  });

  void emitActivity(orgId, appId, "PANEL_CREATED", user.id, { panelId: panel.id, name: panel.name });
  void emitAudit(orgId, user.id, "PANEL_CREATED", "panel", panel.id, null, panel);

  return c.json(enrichPanel(panel), 201);
});

// ─── GET /panels/:panelId ─────────────────────────────────────────────────────

router.get("/panels/:panelId", requirePermission("interview.view"), async (c) => {
  const orgId   = c.get("orgId");
  const panelId = c.req.param("panelId");

  const panel = await db.hfInterviewPanel.findFirst({
    where: { id: panelId, organizationId: orgId },
    include: {
      ...PANEL_INCLUDE,
      application: {
        select: {
          id: true, status: true,
          candidate: { select: { id: true, firstName: true, lastName: true, email: true } },
          job:       { select: { id: true, title: true } },
        },
      },
    },
  });
  if (!panel) return c.json({ error: "not_found" }, 404);

  return c.json(enrichPanel(panel));
});

// ─── PATCH /panels/:panelId ───────────────────────────────────────────────────

router.patch("/panels/:panelId", requirePermission("interview.edit"), zValidator("json", patchPanelSchema), async (c) => {
  const orgId   = c.get("orgId");
  const user    = c.get("user");
  const panelId = c.req.param("panelId");
  const body    = c.req.valid("json");

  const existing = await db.hfInterviewPanel.findFirst({ where: { id: panelId, organizationId: orgId } });
  if (!existing) return c.json({ error: "not_found" }, 404);
  if (existing.status === "completed" || existing.status === "cancelled") {
    return c.json({ error: "panel_locked" }, 400);
  }

  const panel = await db.hfInterviewPanel.update({
    where: { id: panelId },
    data: {
      ...(body.name               !== undefined ? { name: body.name }                   : {}),
      ...(body.sequence           !== undefined ? { sequence: body.sequence }           : {}),
      ...(body.isRequired         !== undefined ? { isRequired: body.isRequired }       : {}),
      ...(body.scorecardId        !== undefined ? { scorecardId: body.scorecardId }     : {}),
      ...(body.recommendation     !== undefined ? { recommendation: body.recommendation } : {}),
      ...(body.feedbackDeadlineAt !== undefined ? {
        feedbackDeadlineAt: body.feedbackDeadlineAt ? new Date(body.feedbackDeadlineAt) : null,
      } : {}),
    },
    include: PANEL_INCLUDE,
  });

  void emitAudit(orgId, user.id, "PANEL_UPDATED", "panel", panelId, existing, panel);
  return c.json(enrichPanel(panel));
});

// ─── POST /panels/:panelId/status ─────────────────────────────────────────────

router.post("/panels/:panelId/status", requirePermission("interview.edit"), zValidator("json", z.object({
  status:         z.string(),
  recommendation: z.enum(RECOMMENDATIONS).optional().nullable(),
  reason:         z.string().optional().nullable(),
})), async (c) => {
  const orgId   = c.get("orgId");
  const user    = c.get("user");
  const panelId = c.req.param("panelId");
  const body    = c.req.valid("json");

  const existing = await db.hfInterviewPanel.findFirst({ where: { id: panelId, organizationId: orgId } });
  if (!existing) return c.json({ error: "not_found" }, 404);

  const allowed = VALID_PANEL_TRANSITIONS[existing.status];
  if (!allowed?.includes(body.status)) {
    return c.json({ error: "invalid_transition", from: existing.status, to: body.status, allowed }, 400);
  }

  const now = new Date();
  const panel = await db.hfInterviewPanel.update({
    where: { id: panelId },
    data: {
      status:         body.status,
      ...(body.recommendation !== undefined ? { recommendation: body.recommendation } : {}),
      ...(body.status === "completed" ? { completedAt: now } : {}),
      ...(body.status === "cancelled" ? { cancelledAt: now } : {}),
    },
    include: PANEL_INCLUDE,
  });

  void emitActivity(orgId, existing.applicationId, `PANEL_${body.status.toUpperCase()}`, user.id, {
    panelId, name: existing.name, recommendation: body.recommendation,
  });

  return c.json(enrichPanel(panel));
});

// ─── POST /panels/:panelId/members ────────────────────────────────────────────

router.post("/panels/:panelId/members", requirePermission("interview.edit"), zValidator("json", z.object({
  members: z.array(z.object({
    userId:           z.string().uuid(),
    role:             z.enum(["lead", "interviewer", "observer"]).default("interviewer"),
    feedbackRequired: z.boolean().default(true),
  })).min(1),
})), async (c) => {
  const orgId   = c.get("orgId");
  const panelId = c.req.param("panelId");
  const { members } = c.req.valid("json");

  const existing = await db.hfInterviewPanel.findFirst({ where: { id: panelId, organizationId: orgId } });
  if (!existing) return c.json({ error: "not_found" }, 404);

  await Promise.all(members.map(m =>
    db.hfPanelMember.upsert({
      where: { panelId_userId: { panelId, userId: m.userId } },
      create: { panelId, userId: m.userId, role: m.role, feedbackRequired: m.feedbackRequired },
      update: { role: m.role, feedbackRequired: m.feedbackRequired },
    })
  ));

  const panel = await db.hfInterviewPanel.findFirst({ where: { id: panelId }, include: PANEL_INCLUDE });
  return c.json(enrichPanel(panel!));
});

// ─── DELETE /panels/:panelId/members/:userId ──────────────────────────────────

router.delete("/panels/:panelId/members/:userId", requirePermission("interview.edit"), async (c) => {
  const orgId   = c.get("orgId");
  const panelId = c.req.param("panelId");
  const userId  = c.req.param("userId");

  const existing = await db.hfInterviewPanel.findFirst({ where: { id: panelId, organizationId: orgId } });
  if (!existing) return c.json({ error: "not_found" }, 404);

  await db.hfPanelMember.deleteMany({ where: { panelId, userId } });
  return c.body(null, 204);
});

// ─── DELETE /panels/:panelId ──────────────────────────────────────────────────

router.delete("/panels/:panelId", requirePermission("interview.cancel"), async (c) => {
  const orgId   = c.get("orgId");
  const panelId = c.req.param("panelId");

  const existing = await db.hfInterviewPanel.findFirst({ where: { id: panelId, organizationId: orgId } });
  if (!existing) return c.json({ error: "not_found" }, 404);
  if (existing.status === "completed") return c.json({ error: "cannot_delete_completed_panel" }, 400);

  await db.hfInterviewPanel.delete({ where: { id: panelId } });
  return c.body(null, 204);
});

// ─── GET /panels — Operations view ────────────────────────────────────────────
// Org-wide view: all panels with their completion state, useful for recruiter ops

router.get("/panels", requirePermission("interview.view"), async (c) => {
  const orgId       = c.get("orgId");
  const status      = c.req.query("status");
  const appId       = c.req.query("applicationId");
  const blocked     = c.req.query("blocked") === "true";  // panels with missing feedback
  const approaching = c.req.query("approaching") === "true"; // deadline within 24h

  const now = new Date();
  const in24h = new Date(now.getTime() + 24 * 60 * 60 * 1000);

  const panels = await db.hfInterviewPanel.findMany({
    where: {
      organizationId: orgId,
      ...(status ? { status } : {}),
      ...(appId  ? { applicationId: appId } : {}),
      ...(blocked ? { status: "feedback_pending" } : {}),
      ...(approaching ? {
        feedbackDeadlineAt: { gte: now, lte: in24h },
        status: { notIn: ["completed", "cancelled"] },
      } : {}),
    },
    include: {
      ...PANEL_INCLUDE,
      application: {
        select: {
          id: true, status: true,
          candidate: { select: { id: true, firstName: true, lastName: true } },
          job:       { select: { id: true, title: true } },
        },
      },
    },
    orderBy: [{ applicationId: "asc" }, { sequence: "asc" }],
  });

  return c.json(panels.map(enrichPanel));
});

// ─── helpers ──────────────────────────────────────────────────────────────────

function enrichPanel(panel: Record<string, unknown> & {
  members?: { feedbackRequired: boolean }[];
  interviews?: {
    feedbacks?: { submittedAt: Date | null; participantId: string }[];
    participants?: { feedbackRequired: boolean; id: string }[];
  }[];
}) {
  // Compute feedback completion across all interviews in this panel
  let totalRequired = 0;
  let totalSubmitted = 0;

  for (const interview of panel.interviews as typeof panel.interviews ?? []) {
    const required  = (interview.participants ?? []).filter(p => p.feedbackRequired);
    const submitted = (interview.feedbacks   ?? []).filter(f => f.submittedAt);
    totalRequired  += required.length;
    totalSubmitted += submitted.length;
  }

  return {
    ...panel,
    feedbackProgress: {
      required:  totalRequired,
      submitted: totalSubmitted,
      complete:  totalRequired > 0 && totalSubmitted >= totalRequired,
    },
  };
}

export { router as panelsRouter };
