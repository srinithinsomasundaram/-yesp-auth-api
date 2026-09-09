import { Hono } from "hono";
import type { HireflowEnv } from "./hireflow.env.js";
import { requireAuth }       from "../src/middleware/auth.js";
import { requireOrgMember }  from "./middleware/org.middleware.js";
import { jobsRouter }         from "./jobs/jobs.routes.js";
import { candidatesRouter }   from "./candidates/candidates.routes.js";
import { applicationsRouter } from "./applications/applications.routes.js";

const hireflowRouter = new Hono<HireflowEnv>();

// Every HireFlow route requires a valid bearer token
hireflowRouter.use("/*", requireAuth as any);

// Routes under /organizations/:orgId/ additionally require active org membership
hireflowRouter.use("/organizations/:orgId/*", requireOrgMember);

hireflowRouter.route("/organizations/:orgId/jobs",         jobsRouter);
hireflowRouter.route("/organizations/:orgId/candidates",   candidatesRouter);
hireflowRouter.route("/organizations/:orgId/applications", applicationsRouter);

export { hireflowRouter };
