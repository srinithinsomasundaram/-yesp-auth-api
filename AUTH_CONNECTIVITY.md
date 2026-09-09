# Yesp Auth — App Connectivity Reference

> Use this document to integrate any Yesp app with the central auth service at **`auth.yesp.space`** (prod) / `localhost:3100` (local).

---

## Base URL

| Environment | Base URL |
|-------------|----------|
| Production  | `https://auth.yesp.space/api/v1` |
| Local dev   | `http://localhost:3100/api/v1` |

All endpoints are prefixed with `/api/v1` unless noted otherwise.

---

## Token Architecture

Yesp Auth issues **RS256-signed JWTs**. Your app never needs a shared secret — it verifies tokens using the public key from the JWKS endpoint.

| Token | Lifetime | Purpose |
|-------|----------|---------|
| Access token | 15 min (900 s) | Bearer token for API calls |
| ID token | 15 min | User identity claims (OIDC) |
| Refresh token | 30 days (2 592 000 s) | Obtain new access tokens |
| Auth code (OAuth) | 5 min (300 s) | One-time code exchange |

### Access token claims

```jsonc
{
  "sub": "<userId>",          // user UUID
  "aud": "<app-slug>",        // audience — your app's slug
  "iss": "https://auth.yesp.space",
  "scopes": ["openid", "profile", "email"],
  "org": "<orgId>",           // present when org-scoped
  "iat": 1700000000,
  "exp": 1700000900,
  "kid": "yesp-auth-v1"
}
```

---

## Verifying Tokens in Your App

### 1. Fetch the public key (JWKS)

```
GET /api/v1/jwks.json
```

Cache this response. Re-fetch only when you see an unknown `kid`.

### 2. Verify the JWT

Use any standard JWT library (e.g. `jose`, `jsonwebtoken`, `python-jose`):

```ts
import { jwtVerify, createRemoteJWKSet } from "jose";

const JWKS = createRemoteJWKSet(new URL("https://auth.yesp.space/api/v1/jwks.json"));

const { payload } = await jwtVerify(token, JWKS, {
  issuer: "https://auth.yesp.space",
  audience: "your-app-slug",   // must match what was used when issuing
});
// payload.sub  → userId
// payload.scopes → string[]
```

### 3. OpenID Discovery

```
GET /api/v1/.well-known/openid-configuration
```

Standard OIDC discovery document — most libraries consume this automatically.

---

## Authentication Flows

### Flow A — Direct Password Login (first-party apps)

Use this for Yesp-owned apps that own the login UI.

```
POST /api/v1/auth/password/login
Content-Type: application/json

{ "email": "user@example.com", "password": "..." }
```

**Response**

```jsonc
{
  "accessToken": "eyJ...",
  "idToken":     "eyJ...",
  "refreshToken": "raw-opaque-token",
  "tokenType": "Bearer",
  "expiresIn": 900
}
```

Store `refreshToken` in httpOnly cookie or secure storage. Use `accessToken` in `Authorization: Bearer <token>` for every API call.

---

### Flow B — OAuth 2.0 / OIDC Authorization Code + PKCE (third-party or multi-app)

Use this when your app is registered as an OAuth client.

#### Step 1 — generate PKCE pair

```ts
const verifier  = crypto.randomUUID() + crypto.randomUUID(); // 64+ chars
const challenge = base64url(sha256(verifier));               // S256
```

#### Step 2 — redirect user to authorize

```
POST /api/v1/authorize          (requires user to already hold a valid session / Bearer token)
Authorization: Bearer <user-access-token>
Content-Type: application/json

{
  "client_id": "your-client-id",
  "redirect_uri": "https://yourapp.yesp.space/callback",
  "response_type": "code",
  "scope": "openid profile email",
  "state": "random-csrf-state",
  "code_challenge": "<S256-challenge>",
  "code_challenge_method": "S256"
}
```

**Response** — `{ "redirectUrl": "https://yourapp.yesp.space/callback?code=...&state=..." }`

#### Step 3 — exchange code for tokens

```
POST /api/v1/token
Content-Type: application/json

{
  "grant_type": "authorization_code",
  "code": "<code from redirect>",
  "redirect_uri": "https://yourapp.yesp.space/callback",
  "client_id": "your-client-id",
  "code_verifier": "<original verifier>"
}
```

**Response**

```jsonc
{
  "access_token":  "eyJ...",
  "id_token":      "eyJ...",
  "refresh_token": "...",
  "token_type": "Bearer",
  "expires_in": 900,
  "scope": "openid profile email"
}
```

---

## Token Refresh

### Direct-login apps

```
POST /api/v1/auth/token/refresh
Content-Type: application/json

{ "refreshToken": "..." }
```

**Response** — new `accessToken` + rotated `refreshToken`.

### OAuth apps

```
POST /api/v1/token
Content-Type: application/json

{
  "grant_type": "refresh_token",
  "refresh_token": "...",
  "client_id": "your-client-id"
}
```

> Refresh tokens are **rotated on every use**. The old token is immediately invalidated. If a reuse is detected, the entire session family is revoked.

---

## User Info

```
GET /api/v1/me
Authorization: Bearer <access-token>
```

```jsonc
{
  "id": "uuid",
  "email": "user@example.com",
  "emailVerified": true,
  "firstName": "Jane",
  "lastName": "Doe",
  "displayName": "Jane Doe",
  "avatarUrl": "/api/v1/users/<id>/avatar",
  "status": "active",
  "createdAt": "2025-01-01T00:00:00Z"
}
```

**OIDC userinfo** (standard endpoint):

```
GET /api/v1/userinfo
Authorization: Bearer <access-token>
```

Returns `sub`, `email`, `email_verified`, `name`, `given_name`, `family_name`.

---

## Registration & Email Verification

```
POST /api/v1/auth/register
{ "email": "...", "password": "...", "firstName": "...", "lastName": "..." }
```

- Password minimum: 12 characters + strength check (entropy).
- Response is always `201` with a generic message (no email enumeration).
- A verification email is sent automatically.

```
POST /api/v1/auth/email/verify
{ "token": "<from email link>" }
```

---

## Password Reset

```
POST /api/v1/auth/password/reset/request
{ "email": "user@example.com" }
```

```
POST /api/v1/auth/password/reset/confirm
{ "token": "<from email link>", "password": "<new-password>" }
```

Password reset revokes **all active sessions** for the user.

---

## MFA (TOTP)

### Setup (authenticated)

```
POST /api/v1/mfa/totp/setup
→ { "methodId": "...", "secret": "...", "otpauthUrl": "otpauth://totp/..." }
```

Render `otpauthUrl` as a QR code. Then verify:

```
POST /api/v1/mfa/totp/verify
{ "methodId": "...", "code": "123456" }
→ { "success": true, "recoveryCodes": ["...", ...] }   // 10 one-time codes
```

### Challenge (during login, no session needed)

```
POST /api/v1/mfa/totp/challenge
{ "userId": "...", "code": "123456" }
```

Call this after a successful password check when you want to gate token issuance behind MFA.

### Recovery

```
POST /api/v1/mfa/recovery
{ "userId": "...", "code": "<recovery-code>" }
```

### Disable (authenticated)

```
POST /api/v1/mfa/disable
Authorization: Bearer <token>
```

---

## Passkeys (WebAuthn)

All passkey endpoints require `Authorization: Bearer <token>` except the authentication flow.

| Method | Path | Description |
|--------|------|-------------|
| `GET`  | `/api/v1/passkeys` | List user's registered passkeys |
| `POST` | `/api/v1/passkeys/register/options` | Get registration options (challenge) |
| `POST` | `/api/v1/passkeys/register/verify` | Complete passkey registration |
| `POST` | `/api/v1/passkeys/authenticate/options` | Get authentication options |
| `POST` | `/api/v1/passkeys/authenticate/verify` | Verify passkey & get tokens |
| `DELETE` | `/api/v1/passkeys/:id` | Remove a passkey |

RP ID: `yesp.space` (prod) / `localhost` (local). Challenges are stored in Redis with a 5-minute TTL.

---

## Smart Login (QR-code device auth)

Lets an unauthenticated device (e.g. new browser) log in by scanning a QR code on an already-authenticated device.

| Step | Method | Path | Auth required |
|------|--------|------|---------------|
| 1. Waiting device creates session | `POST` | `/api/v1/auth/smart-login/init` | No |
| 2. Waiting device polls | `GET` | `/api/v1/auth/smart-login/status?token=...` | No |
| 3. Approving device scans QR | `POST` | `/api/v1/auth/smart-login/scan` | No |
| 4. Approving device approves/declines | `POST` | `/api/v1/auth/smart-login/approve` | **Yes** |

**Init response**: `{ "token": "...", "qrUrl": "...", "expiresIn": 300 }`

Render `qrUrl` as a QR code. Poll `/status` every 2–3 s. On `status: "approved"` the response includes a full token set (one-time, deleted immediately after read).

---

## Session Management

| Method | Path | Description |
|--------|------|-------------|
| `GET`  | `/api/v1/sessions` | List active sessions |
| `DELETE` | `/api/v1/sessions/:id` | Revoke a specific session |
| `POST` | `/api/v1/sessions/revoke-all` | Revoke all sessions |
| `POST` | `/api/v1/auth/logout` | Audit-logged logout |
| `POST` | `/api/v1/auth/logout-all` | Revoke all sessions + audit log |

---

## Token Revocation

```
POST /api/v1/revoke
{ "token": "<refresh-token>" }
```

Always returns `{ "success": true }` regardless of whether the token existed (no information leak).

---

## Social Auth (Google / Microsoft)

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/v1/auth/social/google` | Redirect to Google OAuth |
| `GET` | `/api/v1/auth/social/google/callback` | Google OAuth callback → tokens |
| `GET` | `/api/v1/auth/social/microsoft` | Redirect to Microsoft OAuth |
| `GET` | `/api/v1/auth/social/microsoft/callback` | Microsoft OAuth callback → tokens |

On success the callback redirects to `FRONTEND_URL` with `?access_token=...&refresh_token=...` in the query string (or sets cookies depending on your config).

---

## Rate Limits

All limits are per-IP using a sliding window backed by Redis.

| Endpoint | Limit |
|----------|-------|
| `POST /auth/password/login` | 10 / 15 min |
| `POST /auth/register` | 5 / 15 min |
| `POST /auth/email/verify` | 10 / 15 min |
| `POST /auth/password/reset/request` | 5 / 1 hour |
| `POST /auth/password/reset/confirm` | 10 / 15 min |
| `POST /auth/token/refresh` | 60 / 15 min |
| `POST /mfa/totp/challenge` | 10 / 15 min |
| `POST /mfa/recovery` | 5 / 1 hour |
| `POST /passkeys/authenticate/*` | 20 / 15 min |
| All `/api/*` (global circuit breaker) | 200 / 1 min |

Rate-limit headers are returned on every response: `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`.
On breach: `429 Too Many Requests` + `Retry-After: <seconds>`.

---

## Error Codes

| Code | HTTP | Meaning |
|------|------|---------|
| `invalid_credentials` | 401 | Wrong email or password |
| `unauthorized` | 401 | Missing, expired, or invalid Bearer token |
| `invalid_refresh_token` | 401 | Refresh token invalid, expired, or reused |
| `invalid_or_expired_token` | 400 | Email verification / password reset token used or expired |
| `invalid_grant` | 400 | OAuth code invalid, expired, or PKCE mismatch |
| `invalid_client` | 400 | Unknown or revoked OAuth client |
| `invalid_redirect_uri` | 400 | Redirect URI not registered for this client |
| `invalid_scope` | 400 | Scope not allowed for this client |
| `invalid_code` | 400 | Wrong TOTP code |
| `mfa_not_configured` | 400 | MFA challenge called but no active TOTP method |
| `invalid_recovery_code` | 401 | Recovery code wrong or already used |
| `password_too_weak` | 422 | Password fails strength check |
| `too_many_requests` | 429 | Rate limit exceeded |
| `not_found` | 404 | Resource does not exist |
| `internal_server_error` | 500 | Unexpected server error |

---

## Health Check

```
GET /health
→ { "status": "ok", "service": "yesp-auth", "timestamp": "..." }
→ 503 { "status": "degraded" }   // if DB is down
```

---

## Environment Variables (consuming app)

Add these to your app's env to connect to Yesp Auth:

```env
# The auth service base URL
YESP_AUTH_URL=https://auth.yesp.space

# Your app's OAuth client credentials (if using OAuth flow)
YESP_AUTH_CLIENT_ID=your-client-id
YESP_AUTH_CLIENT_SECRET=your-client-secret    # omit for PKCE-only public clients

# JWKS caching (recommended)
YESP_AUTH_JWKS_URI=https://auth.yesp.space/api/v1/jwks.json
YESP_AUTH_ISSUER=https://auth.yesp.space

# Your app's slug (must match the audience in issued tokens)
YESP_AUTH_AUDIENCE=your-app-slug
```

---

## Quick Integration Checklist

- [ ] Fetch JWKS once at startup and cache (refresh on unknown `kid`)
- [ ] Validate `iss` = `https://auth.yesp.space` and `aud` = your app slug on every request
- [ ] Store refresh token in httpOnly cookie or secure storage — never in localStorage
- [ ] Implement silent token refresh before expiry (access token = 15 min)
- [ ] On `401` from your own API, attempt one token refresh then redirect to login
- [ ] Never send refresh tokens to the auth server over plain HTTP
- [ ] Handle `429` with exponential back-off using the `Retry-After` header
