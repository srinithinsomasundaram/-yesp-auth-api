/**
 * @yesp/auth-sdk — Drop into any Yesp Next.js app.
 *
 * Setup:
 *   1. Copy to src/lib/yesp-auth.ts
 *   2. Register your app: POST api.yesp.cloud/api/v1/admin/apps (admin only)
 *   3. Set env vars:
 *        NEXT_PUBLIC_YESP_AUTH_URL=https://auth.yesp.space
 *        NEXT_PUBLIC_YESP_API_URL=https://api.yesp.cloud/api/v1
 *        NEXT_PUBLIC_YESP_CLIENT_ID=yesp_your_app_abc12345
 *        NEXT_PUBLIC_YESP_REDIRECT_URI=https://yourapp.yesp.space/auth/callback
 */

const AUTH_URL = process.env.NEXT_PUBLIC_YESP_AUTH_URL ?? "https://auth.yesp.space";
const API_URL  = process.env.NEXT_PUBLIC_YESP_API_URL  ?? "https://api.yesp.cloud/api/v1";
const CLIENT_ID    = process.env.NEXT_PUBLIC_YESP_CLIENT_ID    ?? "";
const REDIRECT_URI = process.env.NEXT_PUBLIC_YESP_REDIRECT_URI ?? "";

// ─── Token storage ─────────────────────────────────────────────────────────────

export function getTokens(): { at: string; rt: string } | null {
  if (typeof window === "undefined") return null;
  const at = localStorage.getItem("yesp_at");
  const rt = localStorage.getItem("yesp_rt");
  return at && rt ? { at, rt } : null;
}

export function setTokens(at: string, rt: string): void {
  localStorage.setItem("yesp_at", at);
  localStorage.setItem("yesp_rt", rt);
}

export function clearTokens(): void {
  localStorage.removeItem("yesp_at");
  localStorage.removeItem("yesp_rt");
  sessionStorage.removeItem("yesp_pkce_verifier");
  sessionStorage.removeItem("yesp_oauth_state");
}

// ─── PKCE helpers ───────────────────────────────────────────────────────────────

function generateRandom(length = 32): string {
  const array = new Uint8Array(length);
  crypto.getRandomValues(array);
  return Array.from(array, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function sha256Base64Url(plain: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(plain);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return btoa(String.fromCharCode(...new Uint8Array(hash)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

// ─── Authorization Code + PKCE flow ────────────────────────────────────────────

export async function login(next = "/"): Promise<void> {
  if (typeof window === "undefined") return;

  const verifier = generateRandom(32);
  const challenge = await sha256Base64Url(verifier);
  const state = generateRandom(16);

  sessionStorage.setItem("yesp_pkce_verifier", verifier);
  sessionStorage.setItem("yesp_oauth_state", state);
  sessionStorage.setItem("yesp_after_login", next);

  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    scope: "openid profile email",
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
  });

  window.location.href = `${AUTH_URL}/auth/authorize?${params}`;
}

interface TokenResponse {
  access_token: string;
  refresh_token: string;
}

export async function handleCallback(): Promise<boolean> {
  if (typeof window === "undefined") return false;

  const params = new URLSearchParams(window.location.search);
  const code  = params.get("code");
  const state = params.get("state");
  const verifier = sessionStorage.getItem("yesp_pkce_verifier");
  const savedState = sessionStorage.getItem("yesp_oauth_state");

  if (!code || !verifier || state !== savedState) return false;

  const res = await fetch(`${API_URL}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
      client_id: CLIENT_ID,
      code_verifier: verifier,
    }),
  });

  if (!res.ok) return false;

  const data = (await res.json()) as TokenResponse;
  setTokens(data.access_token, data.refresh_token);

  sessionStorage.removeItem("yesp_pkce_verifier");
  sessionStorage.removeItem("yesp_oauth_state");

  return true;
}

export function getAfterLoginPath(): string {
  return sessionStorage.getItem("yesp_after_login") ?? "/";
}

// ─── API fetch with auto-refresh ────────────────────────────────────────────────

interface RefreshResponse {
  accessToken: string;
  refreshToken: string;
}

export async function apiFetch<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
  const tokens = getTokens();
  if (!tokens) { await login(); throw new Error("not_authenticated"); }

  const doFetch = (at: string) =>
    fetch(`${API_URL}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${at}`,
        ...init.headers,
      },
    });

  let res = await doFetch(tokens.at);

  if (res.status === 401) {
    const refreshRes = await fetch(`${API_URL}/auth/token/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken: tokens.rt }),
    });

    if (!refreshRes.ok) { clearTokens(); await login(); throw new Error("session_expired"); }

    const { accessToken, refreshToken } = (await refreshRes.json()) as RefreshResponse;
    setTokens(accessToken, refreshToken);
    res = await doFetch(accessToken);
  }

  if (!res.ok) throw new Error(await res.text());
  return res.json() as Promise<T>;
}

// ─── User info ──────────────────────────────────────────────────────────────────

export interface YespUser {
  id: string;
  email: string;
  email_verified: boolean;
  name?: string;
  given_name?: string;
  family_name?: string;
}

export async function getUser(): Promise<YespUser | null> {
  if (!getTokens()) return null;
  try {
    return await apiFetch<YespUser>("/userinfo");
  } catch {
    return null;
  }
}

// ─── Logout ─────────────────────────────────────────────────────────────────────

export async function logout(returnTo = "/"): Promise<void> {
  try { await apiFetch("/auth/logout", { method: "POST" }); } catch { /* no-op */ }
  clearTokens();
  window.location.href = `${AUTH_URL}/auth/login?logged_out=1&next=${encodeURIComponent(returnTo)}`;
}

// ─── requireAuth ────────────────────────────────────────────────────────────────

export function requireAuth(next = "/"): void {
  if (typeof window === "undefined") return;
  if (!getTokens()) void login(next);
}

/* ═══════════════════════════════════════════════════════════════════════════════
   CALLBACK PAGE — create at src/app/auth/callback/page.tsx in your app:
   ═══════════════════════════════════════════════════════════════════════════════

"use client";
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { handleCallback, getAfterLoginPath } from "@/lib/yesp-auth";

export default function CallbackPage() {
  const router = useRouter();
  useEffect(() => {
    handleCallback().then((ok) => {
      router.replace(ok ? getAfterLoginPath() : "/auth/error");
    });
  }, [router]);
  return (
    <div className="min-h-screen flex items-center justify-center">
      <div className="w-6 h-6 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
    </div>
  );
}

   ═══════════════════════════════════════════════════════════════════════════════
   REGISTRATION (one-time, run from admin account):
   ═══════════════════════════════════════════════════════════════════════════════

curl -X POST https://api.yesp.cloud/api/v1/admin/apps \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Yesp SheetPro",
    "slug": "yesp-sheetpro",
    "type": "web",
    "description": "Collaborative spreadsheets for teams",
    "homepageUrl": "https://sheetpro.yesp.space",
    "redirectUris": ["https://sheetpro.yesp.space/auth/callback"]
  }'

   Response: { "app": {...}, "clientId": "yesp_yesp_sheetpro_abc12345" }

   ═══════════════════════════════════════════════════════════════════════════════ */
