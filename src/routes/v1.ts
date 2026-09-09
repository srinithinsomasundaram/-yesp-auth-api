import { Hono } from "hono";

// ── Yesp Identity — WHO ARE YOU? ──────────────────────────────────────────────
import { authRouter }          from "../../identity/auth/authentication.routes.js";
import { mfaRouter }           from "../../identity/mfa/mfa.routes.js";
import { passkeysRouter }      from "../../identity/passkeys/passkeys.routes.js";
import { sessionsRouter }      from "../../identity/sessions/sessions.routes.js";
import { smartLoginRouter }    from "../../identity/smart-login/smart-login.routes.js";
import { socialAuthRouter }    from "../../identity/social-auth/social-auth.routes.js";
import { enterpriseSsoRouter } from "../../identity/enterprise-sso/enterprise-sso.routes.js";

// ── Auth Server — OAuth 2.0 / OIDC ───────────────────────────────────────────
import { oauthRouter }         from "../../identity/oauth/oauth.routes.js";

// ── Yesp Accounts — WHAT DO YOU MANAGE? ──────────────────────────────────────
import { profileRouter }       from "../../accounts/profile/profile.routes.js";
import { organizationsRouter } from "../../accounts/organizations/organizations.routes.js";
import { applicationsRouter }  from "../../accounts/applications/applications.routes.js";
import { securityRouter }      from "../../accounts/security/security.routes.js";

// ── Shared services ───────────────────────────────────────────────────────────
import { auditRouter }         from "../modules/shared/audit/audit.routes.js";

// ── Admin ─────────────────────────────────────────────────────────────────────
import { adminRouter }         from "../modules/admin/admin.routes.js";

// ── HireFlow ──────────────────────────────────────────────────────────────────
import { hireflowRouter }      from "../../hireflow/hireflow.router.js";

const v1 = new Hono();

// Yesp Identity
v1.route("/", authRouter);
v1.route("/", mfaRouter);
v1.route("/", passkeysRouter);
v1.route("/", sessionsRouter);
v1.route("/", smartLoginRouter);
v1.route("/", socialAuthRouter);
v1.route("/", enterpriseSsoRouter);

// Auth Server (OIDC / OAuth 2.0)
v1.route("/", oauthRouter);

// Yesp Accounts
v1.route("/", profileRouter);
v1.route("/", organizationsRouter);
v1.route("/", applicationsRouter);
v1.route("/", securityRouter);

// Shared
v1.route("/", auditRouter);

// Admin
v1.route("/", adminRouter);

// HireFlow
v1.route("/hireflow", hireflowRouter);

export { v1 };
