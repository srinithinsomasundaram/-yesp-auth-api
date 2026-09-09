import { createHash, randomBytes, timingSafeEqual as cryptoTimingSafeEqual } from "crypto";

export function generateToken(byteLength = 32): string {
  return randomBytes(byteLength).toString("hex");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function generatePkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

export function timingSafeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return cryptoTimingSafeEqual(bufA, bufB);
}
