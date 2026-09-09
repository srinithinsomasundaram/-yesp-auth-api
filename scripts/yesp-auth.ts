/**
 * yesp-auth.ts — drop this file into any Yesp Next.js app.
 *
 * Setup (3 steps):
 *   1. Copy this file to src/lib/yesp-auth.ts in your app
 *   2. Add these to your .env:
 *        NEXT_PUBLIC_AUTH_URL=https://auth.yesp.space
 *        NEXT_PUBLIC_ACCOUNTS_URL=https://accounts.yesp.space
 *        NEXT_PUBLIC_API_URL=https://api.yesp.cloud/api/v1
 *        NEXT_PUBLIC_APP_SLUG=your-app-slug
 *   3. Add the bridge page (see bottom of this file)
 *
 * Then anywhere in your app:
 *   const user = await getUser();          // null if not logged in
 *   requireAuth();                         // redirect to login if not logged in
 *   await apiFetch("/some/endpoint");      // authenticated API call (auto-refreshes)
 */

const AUTH_URL      = process.env.NEXT_PUBLIC_AUTH_URL      ?? "https://auth.yesp.space";
const ACCOUNTS_URL  = process.env.NEXT_PUBLIC_ACCOUNTS_URL  ?? "https://accounts.yesp.space";
const API_URL       = process.env.NEXT_PUBLIC_API_URL        ?? "https://api.yesp.cloud/api/v1";

const KEY_AT = "yesp_at";
const KEY_RT = "yesp_rt";

// ─── Token storage ─────────────────────────────────────────────────────────────

export function getTokens(): { at: string; rt: string } | null {
  if (typeof window === "undefined") return null;
  const at = localStorage.getItem(KEY_AT);
  const rt = localStorage.getItem(KEY_RT);
  return at && rt ? { at, rt } : null;
}

export function setTokens(at: string, rt: string) {
  localStorage.setItem(KEY_AT, at);
  localStorage.setItem(KEY_RT, rt);
}

export function clearTokens() {
  localStorage.removeItem(KEY_AT);
  localStorage.removeItem(KEY_RT);
}

// ─── Login redirect ────────────────────────────────────────────────────────────

/**
 * Redirects the user to Yesp Auth login.
 * After login they land on accounts.yesp.space/bridge which relays
 * their tokens to YOUR app's /bridge page, then sends them to `next`.
 */
export function redirectToLogin(next = "/") {
  if (typeof window === "undefined") return;
  const appBridge = `${window.location.origin}/bridge?next=${encodeURIComponent(next)}`;
  const relay = encodeURIComponent(appBridge);
  window.location.href = `${AUTH_URL}/auth/login?next=${encodeURIComponent(`/bridge?relay=${relay}`)}`;
}

// ─── Authenticated fetch ───────────────────────────────────────────────────────

export async function apiFetch<T = unknown>(
  path: string,
  init: RequestInit = {}
): Promise<T> {
  const tokens = getTokens();
  if (!tokens) { redirectToLogin(); throw new Error("not_authenticated"); }

  const doFetch = (at: string) =>
    fetch(`${API_URL}${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${at}`, ...init.headers },
    });

  let res = await doFetch(tokens.at);

  // Try refresh once on 401
  if (res.status === 401) {
    const refreshRes = await fetch(`${API_URL}/auth/token/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: tokens.rt }),
    });

    if (!refreshRes.ok) { clearTokens(); redirectToLogin(); throw new Error("session_expired"); }

    const { access_token, refresh_token } = await refreshRes.json();
    setTokens(access_token, refresh_token);
    res = await doFetch(access_token);
  }

  if (!res.ok) throw new Error(await res.text());
  return res.json() as Promise<T>;
}

// ─── Get current user ──────────────────────────────────────────────────────────

export interface YespUser {
  id: string;
  email: string;
  emailVerified: boolean;
  firstName: string | null;
  lastName: string | null;
  displayName: string | null;
  avatarUrl: string | null;
}

export async function getUser(): Promise<YespUser | null> {
  if (!getTokens()) return null;
  try {
    return await apiFetch<YespUser>("/identity/me");
  } catch {
    return null;
  }
}

// ─── Logout ────────────────────────────────────────────────────────────────────

export async function logout() {
  try { await apiFetch("/auth/logout", { method: "POST" }); } catch {}
  clearTokens();
  window.location.href = `${AUTH_URL}/auth/login`;
}

// ─── requireAuth (use in useEffect on protected pages) ────────────────────────

export function requireAuth(next = "/") {
  if (typeof window === "undefined") return;
  if (!getTokens()) redirectToLogin(next);
}

/* ═══════════════════════════════════════════════════════════════════════════════
   BRIDGE PAGE — create this file in your app at:  src/app/bridge/page.tsx
   ═══════════════════════════════════════════════════════════════════════════════

"use client";
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { setTokens, redirectToLogin } from "@/lib/yesp-auth";

export default function BridgePage() {
  const router = useRouter();
  useEffect(() => {
    const params = new URLSearchParams(window.location.hash.slice(1));
    const at = params.get("at");
    const rt = params.get("rt");
    const next = new URLSearchParams(window.location.search).get("next") ?? "/";
    if (at && rt) {
      setTokens(at, rt);
      history.replaceState(null, "", "/bridge");
      router.replace(next);
    } else {
      redirectToLogin(next);
    }
  }, [router]);
  return (
    <div className="min-h-screen flex items-center justify-center">
      <div className="w-6 h-6 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
    </div>
  );
}

   ═══════════════════════════════════════════════════════════════════════════════
   EXAMPLE USAGE in a protected page:
   ═══════════════════════════════════════════════════════════════════════════════

"use client";
import { useEffect, useState } from "react";
import { getUser, requireAuth, logout, type YespUser } from "@/lib/yesp-auth";

export default function Dashboard() {
  const [user, setUser] = useState<YespUser | null>(null);

  useEffect(() => {
    requireAuth("/dashboard");
    getUser().then(setUser);
  }, []);

  if (!user) return <p>Loading...</p>;

  return (
    <div>
      <p>Hello, {user.displayName ?? user.email}</p>
      <button onClick={logout}>Sign out</button>
    </div>
  );
}

   ═══════════════════════════════════════════════════════════════════════════════
   HOW TO REGISTER A NEW APP (one-time, run from your terminal):
   ═══════════════════════════════════════════════════════════════════════════════

   1. Sign in to accounts.yesp.space (as your admin account)
   2. Grab your access token from localStorage: localStorage.getItem("yesp_at")
   3. Run:

   curl -X POST https://api.yesp.cloud/api/v1/admin/apps \
     -H "Authorization: Bearer <your_access_token>" \
     -H "Content-Type: application/json" \
     -d '{
       "name": "Yesp One",
       "slug": "yesp-one",
       "redirectUris": ["https://one.yesp.space/bridge"]
     }'

   Response: { "app": {...}, "clientId": "yesp_yesp_one_abc12345" }
   (You only need the clientId if using OAuth PKCE — not needed for the bridge flow)

   ═══════════════════════════════════════════════════════════════════════════════ */
