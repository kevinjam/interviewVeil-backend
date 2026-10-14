import { config } from "./config.js";

async function send(to: string, subject: string, text: string): Promise<void> {
  if (!config.brevoKey) {
    // Development fallback: no email provider configured.
    console.log(`[dev email] to=${to} subject="${subject}"\n${text}`);
    return;
  }
  const from = /^(.*?)\s*<([^<>]+)>$/.exec(config.emailFrom);
  const sender = from
    ? { name: from[1], email: from[2] }
    : { email: config.emailFrom };
  const res = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: { "api-key": config.brevoKey, "content-type": "application/json" },
    body: JSON.stringify({
      sender,
      to: [{ email: to }],
      subject,
      textContent: text,
    }),
  });
  if (!res.ok) throw new Error(`email send failed (${res.status}): ${await res.text()}`);
}

export function sendPasswordReset(to: string, link: string): Promise<void> {
  return send(
    to,
    "Reset your InterviewVeil password",
    `Someone asked to reset the password for your InterviewVeil account.\n\nReset it here (valid for 1 hour):\n${link}\n\nIf this wasn't you, ignore this email — your password won't change.`,
  );
}

