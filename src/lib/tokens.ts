import { readFileSync } from "fs";
import {
  SignJWT,
  jwtVerify,
  importPKCS8,
  importSPKI,
  type KeyLike,
} from "jose";
import { env } from "./env.js";

let privateKey: KeyLike | null = null;
let publicKey: KeyLike | null = null;
let prevPublicKey: KeyLike | null = null;

async function getPrivateKey(): Promise<KeyLike> {
  if (!privateKey) {
    const pem = process.env.JWT_PRIVATE_KEY
      ? process.env.JWT_PRIVATE_KEY.replace(/\\n/g, "\n")
      : readFileSync(env.JWT_PRIVATE_KEY_PATH, "utf-8");
    privateKey = await importPKCS8(pem, "RS256");
  }
  return privateKey;
}

async function getPublicKey(): Promise<KeyLike> {
  if (!publicKey) {
    const pem = process.env.JWT_PUBLIC_KEY
      ? process.env.JWT_PUBLIC_KEY.replace(/\\n/g, "\n")
      : readFileSync(env.JWT_PUBLIC_KEY_PATH, "utf-8");
    publicKey = await importSPKI(pem, "RS256");
  }
  return publicKey;
}

async function getPrevPublicKey(): Promise<KeyLike | null> {
  if (prevPublicKey) return prevPublicKey;
  const pem = process.env.JWT_PUBLIC_KEY_PREV
    ? process.env.JWT_PUBLIC_KEY_PREV.replace(/\\n/g, "\n")
    : env.JWT_PUBLIC_KEY_PATH_PREV
      ? readFileSync(env.JWT_PUBLIC_KEY_PATH_PREV, "utf-8")
      : null;
  if (!pem) return null;
  prevPublicKey = await importSPKI(pem, "RS256");
  return prevPublicKey;
}

export async function signAccessToken(payload: {
  sub: string;
  aud: string;
  scopes: string[];
  organizationId?: string;
}): Promise<string> {
  const key = await getPrivateKey();
  return new SignJWT({
    scopes: payload.scopes,
    ...(payload.organizationId ? { org: payload.organizationId } : {}),
  })
    .setProtectedHeader({ alg: "RS256", kid: env.JWT_KEY_ID })
    .setSubject(payload.sub)
    .setIssuer(env.APP_URL)
    .setAudience(payload.aud)
    .setIssuedAt()
    .setExpirationTime(`${env.ACCESS_TOKEN_TTL}s`)
    .sign(key);
}

export async function signIdToken(payload: {
  sub: string;
  aud: string;
  email: string;
  name?: string;
  authTime?: number;
  acr?: string;
  nonce?: string;
}): Promise<string> {
  const key = await getPrivateKey();
  const authTime = payload.authTime ?? Math.floor(Date.now() / 1000);
  return new SignJWT({
    email: payload.email,
    ...(payload.name ? { name: payload.name } : {}),
    auth_time: authTime,
    acr: payload.acr ?? "urn:mace:incommon:iap:bronze",
    ...(payload.nonce ? { nonce: payload.nonce } : {}),
  })
    .setProtectedHeader({ alg: "RS256", kid: env.JWT_KEY_ID })
    .setSubject(payload.sub)
    .setIssuer(env.APP_URL)
    .setAudience(payload.aud)
    .setIssuedAt()
    .setExpirationTime(`${env.ACCESS_TOKEN_TTL}s`)
    .sign(key);
}

export async function verifyToken(token: string) {
  const key = await getPublicKey();
  try {
    const { payload } = await jwtVerify(token, key, { issuer: env.APP_URL });
    return payload;
  } catch (err: unknown) {
    // Try previous key during key rotation window (7-day overlap)
    const prev = await getPrevPublicKey();
    if (prev) {
      const { payload } = await jwtVerify(token, prev, { issuer: env.APP_URL });
      return payload;
    }
    throw err;
  }
}

export async function getJwks() {
  const { exportJWK } = await import("jose");
  const current = await getPublicKey();
  const jwk = await exportJWK(current);
  const keys: object[] = [{ ...jwk, use: "sig", alg: "RS256", kid: env.JWT_KEY_ID }];

  const prev = await getPrevPublicKey();
  if (prev) {
    const prevJwk = await exportJWK(prev);
    keys.push({ ...prevJwk, use: "sig", alg: "RS256", kid: `${env.JWT_KEY_ID}-prev` });
  }

  return { keys };
}
