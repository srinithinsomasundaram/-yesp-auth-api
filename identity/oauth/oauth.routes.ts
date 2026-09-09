import { zValidator } from "@hono/zod-validator";
import { createRouter } from "../../src/lib/hono.js";
import { z } from "zod";
import { db } from "../../src/db/client.js";
import { generateToken, hashToken, generatePkceChallenge } from "../../src/lib/crypto.js";
import { signAccessToken, signIdToken, getJwks } from "../../src/lib/tokens.js";
import { audit } from "../../src/lib/audit.js";
import { env } from "../../src/lib/env.js";
import { requireAuth } from "../../src/middleware/auth.js";

const router = createRouter();

// ─── JWKS ─────────────────────────────────────────────────────────────────────

router.get("/jwks.json", async (c) => {
  const jwks = await getJwks();
  return c.json(jwks);
});

// ─── OpenID Configuration ─────────────────────────────────────────────────────

router.get("/.well-known/openid-configuration", (c) => {
  return c.json({
    issuer: env.APP_URL,
    authorization_endpoint: `${env.APP_URL}/authorize`,
    token_endpoint: `${env.APP_URL}/api/v1/token`,
    userinfo_endpoint: `${env.APP_URL}/api/v1/userinfo`,
    jwks_uri: `${env.APP_URL}/api/v1/jwks.json`,
    revocation_endpoint: `${env.APP_URL}/api/v1/revoke`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    subject_types_supported: ["public"],
    id_token_signing_alg_values_supported: ["RS256"],
    scopes_supported: ["openid", "profile", "email"],
    token_endpoint_auth_methods_supported: ["client_secret_basic", "none"],
    code_challenge_methods_supported: ["S256"],
  });
});

// ─── Authorization Endpoint ───────────────────────────────────────────────────
// In production this is a GET that renders a login page or redirects.
// Here we provide a machine-readable handler for the auth flow.

const authorizeSchema = z.object({
  client_id: z.string(),
  redirect_uri: z.string().url(),
  response_type: z.literal("code"),
  scope: z.string().default("openid"),
  state: z.string().optional(),
  code_challenge: z.string(),
  code_challenge_method: z.literal("S256"),
});

// POST /authorize — called after user is authenticated (server-side login flow)
router.post("/authorize", requireAuth, zValidator("json", authorizeSchema), async (c) => {
  const user = c.get("user");
  const body = c.req.valid("json");

  const client = await db.oAuthClient.findUnique({
    where: { clientId: body.client_id, status: "active" },
    include: { application: true },
  });

  if (!client) return c.json({ error: "invalid_client" }, 400);

  if (!client.redirectUris.includes(body.redirect_uri)) {
    return c.json({ error: "invalid_redirect_uri" }, 400);
  }

  const requestedScopes = body.scope.split(" ");
  const invalidScopes = requestedScopes.filter((s) => !client.allowedScopes.includes(s));
  if (invalidScopes.length > 0) return c.json({ error: "invalid_scope" }, 400);

  const code = generateToken();
  await db.authorizationCode.create({
    data: {
      clientId: body.client_id,
      applicationId: client.applicationId,
      userId: user.id,
      codeHash: hashToken(code),
      redirectUri: body.redirect_uri,
      scopes: requestedScopes,
      pkceChallenge: body.code_challenge,
      pkceMethod: body.code_challenge_method,
      expiresAt: new Date(Date.now() + env.AUTH_CODE_TTL * 1000),
    },
  });

  await audit({
    eventType: "oauth.code.issued",
    actorUserId: user.id,
    applicationId: client.applicationId,
  });

  const redirectUrl = new URL(body.redirect_uri);
  redirectUrl.searchParams.set("code", code);
  if (body.state) redirectUrl.searchParams.set("state", body.state);

  return c.json({ redirectUrl: redirectUrl.toString() });
});

// GET /authorize — silent SSO: user is already authenticated, just issue the code
router.get("/authorize", requireAuth, async (c) => {
  const user = c.get("user");
  const { client_id, redirect_uri, code_challenge, code_challenge_method = "S256", state, scope = "openid profile email" } = c.req.query();

  if (!client_id || !redirect_uri || !code_challenge) {
    return c.json({ error: "invalid_request", description: "Missing required parameters" }, 400);
  }

  const client = await db.oAuthClient.findUnique({
    where: { clientId: client_id, status: "active" },
    include: { application: { select: { id: true, name: true, slug: true, logoUrl: true } } },
  });

  if (!client) return c.json({ error: "invalid_client" }, 400);
  if (!client.redirectUris.includes(redirect_uri)) return c.json({ error: "invalid_redirect_uri" }, 400);

  const requestedScopes = scope.split(" ").filter(Boolean);

  const code = generateToken();
  await db.authorizationCode.create({
    data: {
      clientId: client_id,
      applicationId: client.applicationId,
      userId: user.id,
      codeHash: hashToken(code),
      redirectUri: redirect_uri,
      scopes: requestedScopes,
      pkceChallenge: code_challenge,
      pkceMethod: code_challenge_method,
      expiresAt: new Date(Date.now() + env.AUTH_CODE_TTL * 1000),
    },
  });

  await audit({ eventType: "oauth.code.issued", actorUserId: user.id, applicationId: client.applicationId });

  const redirectUrl = new URL(redirect_uri);
  redirectUrl.searchParams.set("code", code);
  if (state) redirectUrl.searchParams.set("state", state);

  return c.json({
    redirectTo: redirectUrl.toString(),
    appName: client.application.name,
    appSlug: client.application.slug,
  });
});

// ─── Token Endpoint ───────────────────────────────────────────────────────────

const tokenSchema = z.discriminatedUnion("grant_type", [
  z.object({
    grant_type: z.literal("authorization_code"),
    code: z.string(),
    redirect_uri: z.string().url(),
    client_id: z.string(),
    code_verifier: z.string(),
  }),
  z.object({
    grant_type: z.literal("refresh_token"),
    refresh_token: z.string(),
    client_id: z.string(),
  }),
]);

router.post("/token", zValidator("json", tokenSchema), async (c) => {
  const body = c.req.valid("json");

  if (body.grant_type === "authorization_code") {
    const codeHash = hashToken(body.code);
    const record = await db.authorizationCode.findUnique({
      where: { codeHash },
      include: { application: true },
    });

    if (!record || record.usedAt || record.expiresAt < new Date()) {
      return c.json({ error: "invalid_grant" }, 400);
    }

    if (record.redirectUri !== body.redirect_uri || record.clientId !== body.client_id) {
      return c.json({ error: "invalid_grant" }, 400);
    }

    // Verify PKCE
    const challenge = generatePkceChallenge(body.code_verifier);
    if (challenge !== record.pkceChallenge) {
      return c.json({ error: "invalid_grant" }, 400);
    }

    await db.authorizationCode.update({ where: { id: record.id }, data: { usedAt: new Date() } });

    const user = await db.user.findUnique({ where: { id: record.userId, status: "active" } });
    if (!user) return c.json({ error: "invalid_grant" }, 400);

    const [accessToken, idToken] = await Promise.all([
      signAccessToken({
        sub: user.id,
        aud: record.application.slug,
        scopes: record.scopes,
      }),
      signIdToken({ sub: user.id, aud: record.application.slug, email: user.email, name: user.displayName ?? undefined }),
    ]);

    const refreshTokenRaw = generateToken();
    const session = await db.session.create({
      data: {
        userId: user.id,
        expiresAt: new Date(Date.now() + env.REFRESH_TOKEN_TTL * 1000),
      },
    });

    await db.refreshToken.create({
      data: {
        sessionId: session.id,
        userId: user.id,
        tokenHash: hashToken(refreshTokenRaw),
        expiresAt: session.expiresAt,
      },
    });

    await audit({
      eventType: "oauth.token.issued",
      actorUserId: user.id,
      applicationId: record.applicationId,
    });

    return c.json({
      access_token: accessToken,
      id_token: idToken,
      refresh_token: refreshTokenRaw,
      token_type: "Bearer",
      expires_in: env.ACCESS_TOKEN_TTL,
      scope: record.scopes.join(" "),
    });
  }

  // refresh_token grant
  const tokenHash = hashToken(body.refresh_token);
  const record = await db.refreshToken.findUnique({
    where: { tokenHash },
    include: { session: true, user: true },
  });

  if (!record || record.usedAt || record.revokedAt || record.expiresAt < new Date()) {
    if (record?.sessionId) {
      await db.session.update({ where: { id: record.sessionId }, data: { revokedAt: new Date() } });
    }
    return c.json({ error: "invalid_grant" }, 400);
  }

  await db.refreshToken.update({ where: { id: record.id }, data: { usedAt: new Date() } });

  const newRefreshRaw = generateToken();
  await db.refreshToken.create({
    data: {
      sessionId: record.sessionId,
      userId: record.userId,
      tokenHash: hashToken(newRefreshRaw),
      expiresAt: record.expiresAt,
    },
  });

  const accessToken = await signAccessToken({
    sub: record.userId,
    aud: body.client_id,
    scopes: ["openid", "profile", "email"],
  });

  return c.json({
    access_token: accessToken,
    refresh_token: newRefreshRaw,
    token_type: "Bearer",
    expires_in: env.ACCESS_TOKEN_TTL,
  });
});

// ─── Userinfo ─────────────────────────────────────────────────────────────────

router.get("/userinfo", requireAuth, async (c) => {
  const user = c.get("user");
  return c.json({
    sub: user.id,
    email: user.email,
    email_verified: user.emailVerified,
    name: user.displayName,
    given_name: user.firstName,
    family_name: user.lastName,
  });
});

// ─── Revoke ───────────────────────────────────────────────────────────────────

const revokeSchema = z.object({ token: z.string() });

router.post("/revoke", zValidator("json", revokeSchema), async (c) => {
  const { token } = c.req.valid("json");
  const tokenHash = hashToken(token);

  const record = await db.refreshToken.findUnique({ where: { tokenHash } });
  if (record) {
    await db.refreshToken.update({ where: { id: record.id }, data: { revokedAt: new Date() } });
    await audit({ eventType: "oauth.token.revoked", actorUserId: record.userId });
  }

  return c.json({ success: true });
});

export { router as oauthRouter };
