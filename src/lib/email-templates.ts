function base(title: string, body: string): string {
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>${title}</title></head>
<body style="font-family:system-ui,sans-serif;background:#f5f5f5;padding:40px 0;margin:0">
  <div style="max-width:480px;margin:0 auto;background:#fff;border-radius:8px;padding:40px;border:1px solid #e5e7eb">
    <div style="margin-bottom:32px">
      <span style="font-size:18px;font-weight:700;color:#111">Yesp Auth</span>
    </div>
    ${body}
    <div style="margin-top:40px;padding-top:24px;border-top:1px solid #e5e7eb;color:#6b7280;font-size:13px">
      You received this email from Yesp Auth. If you did not request this, you can safely ignore it.
    </div>
  </div>
</body>
</html>`;
}

export function verificationEmail(link: string): { subject: string; html: string } {
  return {
    subject: "Verify your Yesp Auth email",
    html: base(
      "Verify your email",
      `<h1 style="font-size:22px;font-weight:600;color:#111;margin:0 0 8px">Verify your email</h1>
      <p style="color:#374151;margin:0 0 24px">Click the button below to verify your email address. This link expires in 24 hours.</p>
      <a href="${link}" style="display:inline-block;background:#111;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:500">Verify email</a>
      <p style="color:#6b7280;font-size:13px;margin:20px 0 0">Or copy this link: ${link}</p>`
    ),
  };
}

export function passwordResetEmail(link: string): { subject: string; html: string } {
  return {
    subject: "Reset your Yesp Auth password",
    html: base(
      "Reset your password",
      `<h1 style="font-size:22px;font-weight:600;color:#111;margin:0 0 8px">Reset your password</h1>
      <p style="color:#374151;margin:0 0 24px">Click the button below to set a new password. This link expires in 1 hour.</p>
      <a href="${link}" style="display:inline-block;background:#111;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:500">Reset password</a>
      <p style="color:#6b7280;font-size:13px;margin:20px 0 0">Or copy this link: ${link}</p>`
    ),
  };
}

export function invitationEmail(
  orgName: string,
  link: string
): { subject: string; html: string } {
  return {
    subject: `You've been invited to ${orgName} on Yesp Auth`,
    html: base(
      `Invitation to ${orgName}`,
      `<h1 style="font-size:22px;font-weight:600;color:#111;margin:0 0 8px">You've been invited</h1>
      <p style="color:#374151;margin:0 0 24px">You have been invited to join <strong>${orgName}</strong>. Click the button below to accept. This invitation expires in 7 days.</p>
      <a href="${link}" style="display:inline-block;background:#111;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:500">Accept invitation</a>`
    ),
  };
}

export function newDeviceEmail(
  deviceInfo: string,
  ipAddress: string,
  time: string
): { subject: string; html: string } {
  return {
    subject: "New sign-in to your Yesp Auth account",
    html: base(
      "New device sign-in",
      `<h1 style="font-size:22px;font-weight:600;color:#111;margin:0 0 8px">New sign-in detected</h1>
      <p style="color:#374151;margin:0 0 16px">A sign-in to your account was detected from a new device.</p>
      <table style="width:100%;border-collapse:collapse;margin-bottom:24px">
        <tr><td style="padding:8px 0;color:#6b7280;font-size:14px">Device</td><td style="padding:8px 0;font-size:14px">${deviceInfo}</td></tr>
        <tr><td style="padding:8px 0;color:#6b7280;font-size:14px">IP address</td><td style="padding:8px 0;font-size:14px">${ipAddress}</td></tr>
        <tr><td style="padding:8px 0;color:#6b7280;font-size:14px">Time</td><td style="padding:8px 0;font-size:14px">${time}</td></tr>
      </table>
      <p style="color:#374151;margin:0">If this was you, no action is needed. If you did not sign in, please change your password immediately and revoke all sessions.</p>`
    ),
  };
}

export function suspiciousActivityEmail(
  reason: string,
  ipAddress: string,
  time: string
): { subject: string; html: string } {
  return {
    subject: "Suspicious activity on your Yesp Auth account",
    html: base(
      "Suspicious activity",
      `<h1 style="font-size:22px;font-weight:600;color:#dc2626;margin:0 0 8px">Suspicious activity detected</h1>
      <p style="color:#374151;margin:0 0 16px">${reason}</p>
      <table style="width:100%;border-collapse:collapse;margin-bottom:24px">
        <tr><td style="padding:8px 0;color:#6b7280;font-size:14px">IP address</td><td style="padding:8px 0;font-size:14px">${ipAddress}</td></tr>
        <tr><td style="padding:8px 0;color:#6b7280;font-size:14px">Time</td><td style="padding:8px 0;font-size:14px">${time}</td></tr>
      </table>
      <p style="color:#374151;margin:0">If you did not initiate this, we recommend you change your password and revoke all active sessions immediately.</p>`
    ),
  };
}
