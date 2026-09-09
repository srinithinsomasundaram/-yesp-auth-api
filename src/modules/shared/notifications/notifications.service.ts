import { Resend } from "resend";
import { env } from "../../../lib/env.js";
import {
  verificationEmail,
  passwordResetEmail,
  invitationEmail,
  newDeviceEmail,
  suspiciousActivityEmail,
} from "../../../lib/email-templates.js";

const resend = env.RESEND_API_KEY ? new Resend(env.RESEND_API_KEY) : null;

async function send(to: string, subject: string, html: string): Promise<void> {
  if (!resend) {
    console.log(`[Email dev] To: ${to} | Subject: ${subject}`);
    return;
  }
  const { error } = await resend.emails.send({ from: env.EMAIL_FROM, to, subject, html });
  if (error) console.error("[Email error]", error);
}

export async function sendVerificationEmail(to: string, token: string): Promise<void> {
  const link = `${env.APP_URL}/api/v1/auth/email/verify?token=${token}`;
  const { subject, html } = verificationEmail(link);
  await send(to, subject, html);
}

export async function sendPasswordResetEmail(to: string, token: string): Promise<void> {
  const link = `${env.FRONTEND_URL}/auth/reset-password?token=${token}`;
  const { subject, html } = passwordResetEmail(link);
  await send(to, subject, html);
}

export async function sendInvitationEmail(
  to: string,
  orgName: string,
  token: string
): Promise<void> {
  const link = `${env.APP_URL}/invite/accept?token=${token}`;
  const { subject, html } = invitationEmail(orgName, link);
  await send(to, subject, html);
}

export async function sendNewDeviceEmail(
  to: string,
  userAgent: string,
  ipAddress: string
): Promise<void> {
  const { subject, html } = newDeviceEmail(
    userAgent || "Unknown device",
    ipAddress,
    new Date().toUTCString()
  );
  await send(to, subject, html);
}

export async function sendSuspiciousActivityEmail(
  to: string,
  reason: string,
  ipAddress: string
): Promise<void> {
  const { subject, html } = suspiciousActivityEmail(reason, ipAddress, new Date().toUTCString());
  await send(to, subject, html);
}
