import argon2 from "argon2";
import { env } from "./env.js";

const argon2Options = {
  memoryCost: env.ARGON2_MEMORY_COST,
  timeCost: env.ARGON2_TIME_COST,
  parallelism: env.ARGON2_PARALLELISM,
  type: argon2.argon2id,
};

export async function hashPassword(plain: string): Promise<string> {
  return argon2.hash(plain, argon2Options);
}

export async function verifyPassword(hash: string, plain: string): Promise<boolean> {
  return argon2.verify(hash, plain);
}

export function isStrongPassword(password: string): boolean {
  return password.length >= 12;
}
