import { Hono } from "hono";
import type { User } from "@prisma/client";
import type { JWTPayload } from "jose";

export type HireflowVariables = {
  user: User;
  tokenPayload: JWTPayload;
  orgId: string;
  orgRole: string;
};

export type HireflowEnv = { Variables: HireflowVariables };

export function createHfRouter() {
  return new Hono<HireflowEnv>();
}
