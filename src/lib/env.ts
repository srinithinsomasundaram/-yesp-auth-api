import { z } from "zod";

const envSchema = z.object({
  PORT: z.coerce.number().default(3100),
  API_PORT: z.coerce.number().default(3100),
  NODE_ENV: z.enum(["development", "staging", "production"]).default("development"),
  DATABASE_URL: z.string(),
  REDIS_URL: z.string().default("redis://localhost:6379"),
  JWT_PRIVATE_KEY_PATH: z.string().default("./keys/private.pem"),
  JWT_PUBLIC_KEY_PATH: z.string().default("./keys/public.pem"),
  JWT_KEY_ID: z.string().default("yesp-auth-v1"),
  ACCESS_TOKEN_TTL: z.coerce.number().default(900),
  REFRESH_TOKEN_TTL: z.coerce.number().default(2592000),
  AUTH_CODE_TTL: z.coerce.number().default(300),
  ARGON2_MEMORY_COST: z.coerce.number().default(65536),
  ARGON2_TIME_COST: z.coerce.number().default(3),
  ARGON2_PARALLELISM: z.coerce.number().default(4),
  ALLOWED_ORIGINS: z.string().default("http://localhost:3000,http://localhost:3002"),
  RESEND_API_KEY: z.string().optional(),
  EMAIL_FROM: z.string().default("Yesp Auth <noreply@yesp.space>"),
  APP_URL: z.string().default("http://localhost:3100"),
  // WebAuthn
  WEBAUTHN_RP_ID: z.string().default("localhost"),
  WEBAUTHN_RP_NAME: z.string().default("Yesp Accounts"),
  WEBAUTHN_ORIGIN: z.string().default("http://localhost:3002"),
  // Social OAuth
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  MICROSOFT_CLIENT_ID: z.string().optional(),
  MICROSOFT_CLIENT_SECRET: z.string().optional(),
  MICROSOFT_TENANT_ID: z.string().default("common"),
  // URLs
  BACKEND_URL: z.string().default("http://localhost:3100"),
  FRONTEND_URL: z.string().default("http://localhost:3002"),
});

export type Env = z.infer<typeof envSchema>;

function loadEnv(): Env {
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    console.error("Invalid environment variables:", result.error.flatten().fieldErrors);
    process.exit(1);
  }
  return result.data;
}

export const env = loadEnv();
