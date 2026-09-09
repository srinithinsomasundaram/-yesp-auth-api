import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { createHfRouter } from "../hireflow.env.js";
import { db } from "../../src/db/client.js";
import { requirePermission } from "../middleware/permissions.middleware.js";
import { emitActivity } from "../shared/activity.js";

const router = createHfRouter();

const submitSchema = z.object({
  interviewId:    z.string().uuid(),
  scorecardId:    z.string().uuid().optional().nullable(),
  recommendation: z.enum(["strong_hire", "hire", "no_hire", "strong_no_hire"]).optional().nullable(),
  strengths:      z.string().optional().nullable(),
  concerns:       z.string().optional().nullable(),
  privateNotes:   z.string().optional().nullable(),
  answers:        z.array(z.object({
    competencyId: z.string().uuid(),
    rating:       z.number().int().min(1).max(10).optional().nullable(),
    comment:      z.string().optional().nullable(),
  })).optional(),
  submit: z.boolean().default(false), // false = draft, true = final
});

// ─── GET /feedback?interviewId=xxx ────────────────────────────────────────────

router.get("/", requirePermission("feedback.view"), async (c) => {
  const orgId       = c.get("orgId");
  const interviewId = c.req.query("interviewId");

  const feedbacks = await db.hfFeedback.findMany({
    where: {
      organizationId: orgId,
      ...(interviewId ? { interviewId } : {}),
    },
    include: {
      answers: { include: { competency: true } },
    },
    orderBy: { createdAt: "asc" },
  });

  return c.json(feedbacks.map(f => ({
    ...f,
    overallScore: computeScore(f.answers),
  })));
});

// ─── POST /feedback ────────────────────────────────────────────────────────────

router.post("/", requirePermission("feedback.submit"), zValidator("json", submitSchema), async (c) => {
  const orgId = c.get("orgId");
  const user  = c.get("user");
  const body  = c.req.valid("json");

  // Verify interview belongs to org
  const interview = await db.hfInterview.findFirst({
    where: { id: body.interviewId, organizationId: orgId },
  });
  if (!interview) return c.json({ error: "interview_not_found" }, 404);

  // Find the participant record for this user
  const participant = await db.hfInterviewParticipant.findUnique({
    where: { interviewId_userId: { interviewId: body.interviewId, userId: user.id } },
  });
  if (!participant) return c.json({ error: "not_a_participant" }, 403);

  // Upsert feedback (allow drafts before final submit)
  const existing = await db.hfFeedback.findUnique({
    where: { interviewId_participantId: { interviewId: body.interviewId, participantId: participant.id } },
  });

  if (existing?.submittedAt) {
    return c.json({ error: "feedback_already_submitted" }, 409);
  }

  const feedbackData = {
    organizationId: orgId,
    interviewId:    body.interviewId,
    participantId:  participant.id,
    scorecardId:    body.scorecardId ?? null,
    recommendation: body.recommendation ?? null,
    strengths:      body.strengths    ?? null,
    concerns:       body.concerns     ?? null,
    privateNotes:   body.privateNotes ?? null,
    submittedAt:    body.submit ? new Date() : null,
  };

  let feedback;
  if (existing) {
    feedback = await db.hfFeedback.update({
      where: { id: existing.id },
      data: feedbackData,
      include: { answers: { include: { competency: true } } },
    });
    // Replace answers
    if (body.answers?.length) {
      await db.hfFeedbackAnswer.deleteMany({ where: { feedbackId: existing.id } });
      await db.hfFeedbackAnswer.createMany({
        data: body.answers.map(a => ({
          feedbackId:   existing.id,
          competencyId: a.competencyId,
          rating:       a.rating  ?? null,
          comment:      a.comment ?? null,
        })),
      });
    }
  } else {
    feedback = await db.hfFeedback.create({
      data: {
        ...feedbackData,
        answers: body.answers?.length ? {
          create: body.answers.map(a => ({
            competencyId: a.competencyId,
            rating:       a.rating  ?? null,
            comment:      a.comment ?? null,
          })),
        } : undefined,
      },
      include: { answers: { include: { competency: true } } },
    });
  }

  if (body.submit) {
    void emitActivity(orgId, interview.applicationId, "FEEDBACK_SUBMITTED", user.id, {
      interviewId:    body.interviewId,
      recommendation: body.recommendation,
    });

    // Check if all required feedback is now complete — if so, auto-advance interview status
    void checkFeedbackComplete(orgId, body.interviewId, interview.applicationId, user.id);
  }

  return c.json({ ...feedback, overallScore: computeScore(feedback.answers) }, existing ? 200 : 201);
});

// ─── GET /feedback/:id ────────────────────────────────────────────────────────

router.get("/:id", requirePermission("feedback.view"), async (c) => {
  const orgId = c.get("orgId");
  const id    = c.req.param("id");

  const feedback = await db.hfFeedback.findFirst({
    where: { id, organizationId: orgId },
    include: { answers: { include: { competency: true } } },
  });
  if (!feedback) return c.json({ error: "not_found" }, 404);

  return c.json({ ...feedback, overallScore: computeScore(feedback.answers) });
});

// ─── helpers ──────────────────────────────────────────────────────────────────

function computeScore(answers: { rating: number | null; competency: { weight: unknown } }[]): number | null {
  const rated = answers.filter(a => a.rating !== null);
  if (!rated.length) return null;
  const totalWeight = rated.reduce((s, a) => s + Number(a.competency.weight), 0);
  const weightedSum = rated.reduce((s, a) => s + (a.rating! * Number(a.competency.weight)), 0);
  return totalWeight > 0 ? Math.round((weightedSum / totalWeight) * 100) / 100 : null;
}

async function checkFeedbackComplete(
  orgId: string,
  interviewId: string,
  applicationId: string,
  actorId: string,
) {
  const [participants, feedbacks] = await Promise.all([
    db.hfInterviewParticipant.findMany({ where: { interviewId, feedbackRequired: true } }),
    db.hfFeedback.findMany({ where: { interviewId, submittedAt: { not: null } } }),
  ]);

  const submittedIds = new Set(feedbacks.map(f => f.participantId));
  const allDone = participants.every(p => submittedIds.has(p.id));

  if (allDone) {
    await db.hfInterview.update({
      where: { id: interviewId },
      data: { status: "feedback_complete" },
    });
    void emitActivity(orgId, applicationId, "FEEDBACK_COMPLETE", actorId, { interviewId });
  }
}

export { router as feedbackRouter };
