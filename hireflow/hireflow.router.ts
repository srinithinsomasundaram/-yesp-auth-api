import { Hono } from "hono";
import type { HireflowEnv } from "./hireflow.env.js";
import { requireAuth }       from "../src/middleware/auth.js";
import { requireOrgMember }  from "./middleware/org.middleware.js";
import { jobsRouter }         from "./jobs/jobs.routes.js";
import { candidatesRouter }   from "./candidates/candidates.routes.js";
import { applicationsRouter } from "./applications/applications.routes.js";
import { interviewsRouter }   from "./interviews/interviews.routes.js";
import { panelsRouter }       from "./panels/panels.routes.js";
import { scorecardsRouter }   from "./scorecards/scorecards.routes.js";
import { feedbackRouter }     from "./scorecards/feedback.routes.js";
import { tasksRouter }        from "./tasks/tasks.routes.js";

const hireflowRouter = new Hono<HireflowEnv>();

// Every HireFlow route requires a valid bearer token
hireflowRouter.use("/*", requireAuth as any);

// Routes under /organizations/:orgId/ additionally require active org membership
hireflowRouter.use("/organizations/:orgId/*", requireOrgMember);

// ── Hiring Engine ─────────────────────────────────────────────────────────────
hireflowRouter.route("/organizations/:orgId/jobs",         jobsRouter);
hireflowRouter.route("/organizations/:orgId/candidates",   candidatesRouter);
hireflowRouter.route("/organizations/:orgId/applications", applicationsRouter);

// ── Interview Engine ──────────────────────────────────────────────────────────
hireflowRouter.route("/organizations/:orgId/interviews",   interviewsRouter);
// Panels: nested under applications (POST/GET) + flat ops view (GET /panels, GET/PATCH/DELETE /panels/:id)
hireflowRouter.route("/organizations/:orgId",              panelsRouter);
hireflowRouter.route("/organizations/:orgId/scorecards",   scorecardsRouter);
hireflowRouter.route("/organizations/:orgId/feedback",     feedbackRouter);

// ── Operations Engine ─────────────────────────────────────────────────────────
hireflowRouter.route("/organizations/:orgId/tasks",        tasksRouter);

export { hireflowRouter };
