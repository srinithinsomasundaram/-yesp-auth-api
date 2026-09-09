import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { Issuer, generators } from "openid-client";
import { SAML } from "@node-saml/node-saml";
import { createRouter } from "../../src/lib/hono.js";
import { requireAuth } from "../../src/middleware/auth.js";
import { db } from "../../src/db/client.js";
import { redis } from "../../src/lib/redis.js";
import { audit } from "../../src/lib/audit.js";
import { env } from "../../src/lib/env.js";
import { signAccessToken, signIdToken } from "../../src/lib/tokens.js";
import { generateToken, hashToken } from "../../src/lib/crypto.js";

const router = createRouter();

const STATE_TTL = 600; // 10 minutes

// ─── Domain check (pre-login) ─────────────────────────────────────────────────

router.get("/sso/check", async (c) => {
  const domain = new URL(c.req.url).searchParams.get("domain");
  if (!domain) return c.json({ ssoRequired: false });

  const connection = await db.enterpriseSsoConnection.findFirst({
    where: { domains: { has: domain }, status: "active" },
    select: { id: true, protocol: true, organizationId: true },
  });

  return c.json({
    ssoRequired: !!connection,
    connectionId: connection?.id ?? null,
    protocol: connection?.protocol ?? null,
  });
});

// ─── Manage SSO connections (org admin only) ──────────────────────────────────

router.get("/organizations/:id/sso/connections", requireAuth, async (c) => {
  const user = c.get("user");
  const { id } = c.req.param();

  const membership = await db.organizationMembership.findUnique({
    where: { organizationId_userId: { organizationId: id, userId: user.id } },
  });
  if (!membership || !["organization_owner", "identity_admin", "security_admin"].includes(membership.role)) {
    return c.json({ error: "forbidden" }, 403);
  }

  const connections = await db.enterpriseSsoConnection.findMany({
    where: { organizationId: id },
    select: { id: true, protocol: true, issuer: true, domains: true, status: true, createdAt: true },
  });

  return c.json(connections);
});

const oidcConnectionSchema = z.object({
  protocol: z.literal("oidc"),
  issuer: z.string().url(),
  domains: z.array(z.string()).min(1),
  clientId: z.string(),
  clientSecret: z.string(),
  scopes: z.array(z.string()).default(["openid", "profile", "email"]),
});

const samlConnectionSchema = z.object({
  protocol: z.literal("saml"),
  issuer: z.string(),
  domains: z.array(z.string()).min(1),
  entryPoint: z.string().url(),
  cert: z.string(),
});

const createConnectionSchema = z.discriminatedUnion("protocol", [
  oidcConnectionSchema,
  samlConnectionSchema,
]);

router.post(
  "/organizations/:id/sso/connections",
  requireAuth,
  zValidator("json", createConnectionSchema),
  async (c) => {
    const user = c.get("user");
    const { id } = c.req.param();
    const body = c.req.valid("json");

    const membership = await db.organizationMembership.findUnique({
      where: { organizationId_userId: { organizationId: id, userId: user.id } },
    });
    if (!membership || !["organization_owner", "identity_admin", "security_admin"].includes(membership.role)) {
      return c.json({ error: "forbidden" }, 403);
    }

    let metadata: Record<string, unknown>;

    if (body.protocol === "oidc") {
      // Validate that the issuer is discoverable
      try {
        await Issuer.discover(body.issuer);
      } catch {
        return c.json({ error: "oidc_discovery_failed", message: "Could not discover the OIDC issuer." }, 400);
      }
      metadata = { clientId: body.clientId, clientSecret: body.clientSecret, scopes: body.scopes };
    } else {
      metadata = { entryPoint: body.entryPoint, cert: body.cert };
    }

    const connection = await db.enterpriseSsoConnection.create({
      data: {
        organizationId: id,
        protocol: body.protocol,
        issuer: body.issuer,
        domains: body.domains,
        metadata: metadata as Record<string, string | string[]>,
        status: "inactive", // require explicit activation
      },
    });

    await audit({
      eventType: "sso.configuration.changed",
      actorUserId: user.id,
      organizationId: id,
      targetType: "sso_connection",
      targetId: connection.id,
      metadata: { action: "created", protocol: body.protocol },
    });

    return c.json(connection, 201);
  }
);

const updateConnectionSchema = z.object({
  domains: z.array(z.string()).optional(),
  status: z.enum(["active", "inactive"]).optional(),
});

router.patch(
  "/organizations/:id/sso/connections/:connectionId",
  requireAuth,
  zValidator("json", updateConnectionSchema),
  async (c) => {
    const user = c.get("user");
    const { id, connectionId } = c.req.param();
    const body = c.req.valid("json");

    const membership = await db.organizationMembership.findUnique({
      where: { organizationId_userId: { organizationId: id, userId: user.id } },
    });
    if (!membership || !["organization_owner", "identity_admin", "security_admin"].includes(membership.role)) {
      return c.json({ error: "forbidden" }, 403);
    }

    const updated = await db.enterpriseSsoConnection.update({
      where: { id: connectionId, organizationId: id },
      data: body,
    });

    await audit({
      eventType: "sso.configuration.changed",
      actorUserId: user.id,
      organizationId: id,
      targetType: "sso_connection",
      targetId: connectionId,
      metadata: { action: "updated" },
    });

    return c.json(updated);
  }
);

router.delete("/organizations/:id/sso/connections/:connectionId", requireAuth, async (c) => {
  const user = c.get("user");
  const { id, connectionId } = c.req.param();

  const membership = await db.organizationMembership.findUnique({
    where: { organizationId_userId: { organizationId: id, userId: user.id } },
  });
  if (!membership || !["organization_owner", "identity_admin", "security_admin"].includes(membership.role)) {
    return c.json({ error: "forbidden" }, 403);
  }

  await db.enterpriseSsoConnection.delete({ where: { id: connectionId, organizationId: id } });

  await audit({
    eventType: "sso.configuration.changed",
    actorUserId: user.id,
    organizationId: id,
    targetType: "sso_connection",
    targetId: connectionId,
    metadata: { action: "deleted" },
  });

  return c.json({ success: true });
});

// ─── OIDC: Initiate ───────────────────────────────────────────────────────────

router.get("/sso/oidc/authorize", async (c) => {
  const connectionId = new URL(c.req.url).searchParams.get("connection_id");
  const redirectAfter = new URL(c.req.url).searchParams.get("redirect_after") ?? "/";

  if (!connectionId) return c.json({ error: "missing_connection_id" }, 400);

  const connection = await db.enterpriseSsoConnection.findUnique({
    where: { id: connectionId, status: "active", protocol: "oidc" },
  });
  if (!connection) return c.json({ error: "connection_not_found" }, 404);

  const meta = connection.metadata as { clientId: string; clientSecret: string; scopes: string[] };

  const issuer = await Issuer.discover(connection.issuer);
  const client = new issuer.Client({
    client_id: meta.clientId,
    client_secret: meta.clientSecret,
    redirect_uris: [`${env.APP_URL}/api/v1/sso/oidc/callback`],
    response_types: ["code"],
  });

  const state = generators.state();
  const nonce = generators.nonce();
  const codeVerifier = generators.codeVerifier();
  const codeChallenge = generators.codeChallenge(codeVerifier);

  await redis.setex(
    `sso:oidc:${state}`,
    STATE_TTL,
    JSON.stringify({ connectionId, nonce, codeVerifier, redirectAfter })
  );

  const authUrl = client.authorizationUrl({
    scope: meta.scopes.join(" "),
    state,
    nonce,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  });

  return c.redirect(authUrl);
});

// ─── OIDC: Callback ───────────────────────────────────────────────────────────

router.get("/sso/oidc/callback", async (c) => {
  const url = new URL(c.req.url);
  const state = url.searchParams.get("state");
  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");

  if (error) return c.json({ error: "sso_error", detail: error }, 400);
  if (!state || !code) return c.json({ error: "invalid_callback" }, 400);

  const raw = await redis.get(`sso:oidc:${state}`);
  if (!raw) return c.json({ error: "state_expired" }, 400);

  const { connectionId, nonce, codeVerifier, redirectAfter } = JSON.parse(raw) as {
    connectionId: string;
    nonce: string;
    codeVerifier: string;
    redirectAfter: string;
  };

  await redis.del(`sso:oidc:${state}`);

  const connection = await db.enterpriseSsoConnection.findUnique({ where: { id: connectionId } });
  if (!connection) return c.json({ error: "connection_not_found" }, 404);

  const meta = connection.metadata as { clientId: string; clientSecret: string; scopes: string[] };

  const issuer = await Issuer.discover(connection.issuer);
  const client = new issuer.Client({
    client_id: meta.clientId,
    client_secret: meta.clientSecret,
    redirect_uris: [`${env.APP_URL}/api/v1/sso/oidc/callback`],
    response_types: ["code"],
  });

  const tokenSet = await client.callback(
    `${env.APP_URL}/api/v1/sso/oidc/callback`,
    { code, state },
    { code_verifier: codeVerifier, nonce, state }
  );

  const claims = tokenSet.claims();
  const email = (claims.email as string | undefined)?.toLowerCase();
  if (!email) return c.json({ error: "no_email_in_token" }, 400);

  // Find or create user
  let user = await db.user.findUnique({ where: { email } });

  if (!user) {
    user = await db.user.create({
      data: {
        email,
        emailVerified: true,
        firstName: (claims.given_name as string | undefined) ?? null,
        lastName: (claims.family_name as string | undefined) ?? null,
        displayName: (claims.name as string | undefined) ?? null,
        credentials: {
          create: { credentialType: "enterprise_sso" },
        },
      },
    });
  } else {
    // Ensure enterprise_sso credential exists for this user
    await db.credential.upsert({
      where: { userId_credentialType: { userId: user.id, credentialType: "enterprise_sso" } },
      create: { userId: user.id, credentialType: "enterprise_sso" },
      update: { lastUsedAt: new Date() },
    });
  }

  // Ensure org membership
  const org = await db.organization.findUnique({ where: { id: connection.organizationId } });
  if (org) {
    await db.organizationMembership.upsert({
      where: { organizationId_userId: { organizationId: org.id, userId: user.id } },
      create: { organizationId: org.id, userId: user.id, status: "active", joinedAt: new Date() },
      update: { status: "active" },
    });
  }

  // Issue session + tokens
  const sessionExpiry = new Date(Date.now() + env.REFRESH_TOKEN_TTL * 1000);
  const session = await db.session.create({ data: { userId: user.id, expiresAt: sessionExpiry } });
  const refreshTokenRaw = generateToken();
  await db.refreshToken.create({
    data: {
      sessionId: session.id,
      userId: user.id,
      tokenHash: hashToken(refreshTokenRaw),
      expiresAt: sessionExpiry,
    },
  });

  const [accessToken, idToken] = await Promise.all([
    signAccessToken({ sub: user.id, aud: "yesp-auth", scopes: ["openid", "profile", "email"] }),
    signIdToken({ sub: user.id, aud: "yesp-auth", email: user.email, name: user.displayName ?? undefined }),
  ]);

  await audit({
    eventType: "user.login.success",
    actorUserId: user.id,
    organizationId: connection.organizationId,
    metadata: { method: "enterprise_sso_oidc", connectionId },
  });

  // Redirect back to app with tokens in query (in production use cookie or code exchange)
  const redirect = new URL(redirectAfter, env.APP_URL);
  redirect.searchParams.set("access_token", accessToken);
  redirect.searchParams.set("refresh_token", refreshTokenRaw);

  return c.redirect(redirect.toString());
});

// ─── SAML: Initiate ───────────────────────────────────────────────────────────

router.get("/sso/saml/:connectionId/authorize", async (c) => {
  const { connectionId } = c.req.param();
  const redirectAfter = new URL(c.req.url).searchParams.get("redirect_after") ?? "/";

  const connection = await db.enterpriseSsoConnection.findUnique({
    where: { id: connectionId, status: "active", protocol: "saml" },
  });
  if (!connection) return c.json({ error: "connection_not_found" }, 404);

  const meta = connection.metadata as { entryPoint: string; cert: string };

  const saml = new SAML({
    callbackUrl: `${env.APP_URL}/api/v1/sso/saml/${connectionId}/acs`,
    entryPoint: meta.entryPoint,
    issuer: env.APP_URL,
    idpCert: meta.cert,
    signatureAlgorithm: "sha256",
  });

  const relayState = JSON.stringify({ connectionId, redirectAfter });
  const authUrl = await saml.getAuthorizeUrlAsync(relayState, undefined, {});

  return c.redirect(authUrl);
});

// ─── SAML: ACS (Assertion Consumer Service) ───────────────────────────────────

router.post("/sso/saml/:connectionId/acs", async (c) => {
  const { connectionId } = c.req.param();

  const connection = await db.enterpriseSsoConnection.findUnique({
    where: { id: connectionId, status: "active", protocol: "saml" },
  });
  if (!connection) return c.json({ error: "connection_not_found" }, 404);

  const meta = connection.metadata as { entryPoint: string; cert: string };
  const body = await c.req.parseBody();

  const saml = new SAML({
    callbackUrl: `${env.APP_URL}/api/v1/sso/saml/${connectionId}/acs`,
    entryPoint: meta.entryPoint,
    issuer: env.APP_URL,
    idpCert: meta.cert,
    signatureAlgorithm: "sha256",
  });

  const { profile } = await saml.validatePostResponseAsync(body as Record<string, string>);

  const email = profile?.nameID?.toLowerCase() ?? (profile?.email as string | undefined)?.toLowerCase();
  if (!email) return c.json({ error: "no_email_in_assertion" }, 400);

  let user = await db.user.findUnique({ where: { email } });

  if (!user) {
    user = await db.user.create({
      data: {
        email,
        emailVerified: true,
        firstName: (profile?.["http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname"] as string | undefined) ?? null,
        lastName: (profile?.["http://schemas.xmlsoap.org/ws/2005/05/identity/claims/surname"] as string | undefined) ?? null,
        credentials: { create: { credentialType: "enterprise_sso" } },
      },
    });
  } else {
    await db.credential.upsert({
      where: { userId_credentialType: { userId: user.id, credentialType: "enterprise_sso" } },
      create: { userId: user.id, credentialType: "enterprise_sso" },
      update: { lastUsedAt: new Date() },
    });
  }

  await db.organizationMembership.upsert({
    where: { organizationId_userId: { organizationId: connection.organizationId, userId: user.id } },
    create: { organizationId: connection.organizationId, userId: user.id, status: "active", joinedAt: new Date() },
    update: { status: "active" },
  });

  const sessionExpiry = new Date(Date.now() + env.REFRESH_TOKEN_TTL * 1000);
  const session = await db.session.create({ data: { userId: user.id, expiresAt: sessionExpiry } });
  const refreshTokenRaw = generateToken();
  await db.refreshToken.create({
    data: {
      sessionId: session.id,
      userId: user.id,
      tokenHash: hashToken(refreshTokenRaw),
      expiresAt: sessionExpiry,
    },
  });

  const [accessToken] = await Promise.all([
    signAccessToken({ sub: user.id, aud: "yesp-auth", scopes: ["openid", "profile", "email"] }),
  ]);

  await audit({
    eventType: "user.login.success",
    actorUserId: user.id,
    organizationId: connection.organizationId,
    metadata: { method: "enterprise_sso_saml", connectionId },
  });

  let redirectAfter = "/";
  try {
    const relayState = JSON.parse(body["RelayState"] as string ?? "{}");
    redirectAfter = relayState.redirectAfter ?? "/";
  } catch {}

  const redirect = new URL(redirectAfter, env.APP_URL);
  redirect.searchParams.set("access_token", accessToken);
  redirect.searchParams.set("refresh_token", refreshTokenRaw);

  return c.redirect(redirect.toString());
});

export { router as enterpriseSsoRouter };
