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
}): Promise<string> {
  const key = await getPrivateKey();
  return new SignJWT({
    email: payload.email,
    ...(payload.name ? { name: payload.name } : {}),
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
  const { payload } = await jwtVerify(token, key, {
    issuer: env.APP_URL,
  });
  return payload;
}

export async function getJwks() {
  const { exportJWK } = await import("jose");
  const key = await getPublicKey();
  const jwk = await exportJWK(key);
  return {
    keys: [{ ...jwk, use: "sig", alg: "RS256", kid: env.JWT_KEY_ID }],
  };
}
