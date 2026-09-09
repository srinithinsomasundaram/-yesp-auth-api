import { Hono } from "hono";
import type { User } from "@prisma/client";
import type { JWTPayload } from "jose";

export type AppVariables = {
  user: User;
  tokenPayload: JWTPayload;
};

export type AppEnv = { Variables: AppVariables };

export function createRouter() {
  return new Hono<AppEnv>();
}
