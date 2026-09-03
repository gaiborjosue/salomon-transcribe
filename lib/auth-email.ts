import { sendTransactionalEmail } from "@/lib/resend"

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
}

function renderEmail({
  body,
  ctaLabel,
  ctaUrl,
  title,
}: {
  body: string
  ctaLabel: string
  ctaUrl: string
  title: string
}) {
  return `
    <div style="background:#111111;padding:32px 16px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#f5f5f5;">
      <div style="max-width:560px;margin:0 auto;border:1px solid rgba(255,255,255,0.08);border-radius:24px;background:#171717;padding:32px;">
        <div style="display:inline-block;border:1px solid rgba(255,255,255,0.08);border-radius:999px;padding:6px 12px;font-size:11px;letter-spacing:0.18em;text-transform:uppercase;color:rgba(255,255,255,0.45);">
          Salomon
        </div>
        <h1 style="margin:20px 0 12px;font-size:28px;line-height:1.2;color:#f5f5f5;">${title}</h1>
        <p style="margin:0 0 24px;font-size:15px;line-height:1.7;color:rgba(255,255,255,0.68);">${body}</p>
        <a href="${ctaUrl}" style="display:inline-block;border-radius:999px;background:#ffffff;color:#111111;padding:12px 20px;font-size:14px;font-weight:600;text-decoration:none;">
          ${ctaLabel}
        </a>
        <p style="margin:24px 0 0;font-size:13px;line-height:1.6;color:rgba(255,255,255,0.42);word-break:break-all;">
          If the button does not work, open this link:<br />${ctaUrl}
        </p>
      </div>
    </div>
  `
}

export async function sendVerificationEmail({
  email,
  name,
  token,
  url,
}: {
  email: string
  name?: string | null
  token: string
  url: string
}) {
  const safeName = name?.trim() ? escapeHtml(name.trim()) : "there"
  const safeUrl = escapeHtml(url)
  const body = `Hi ${safeName}, confirm your email to unlock live church translation, shared sessions, and account recovery.`

  await sendTransactionalEmail({
    to: email,
    subject: "Verify your Salomon email",
    text: `Verify your email by opening this link: ${url}`,
    html: renderEmail({
      title: "Verify your email",
      body,
      ctaLabel: "Verify email",
      ctaUrl: safeUrl,
    }),
    idempotencyKey: `auth-verify/${token}`,
  })
}

export async function sendPasswordResetEmail({
  email,
  name,
  token,
  url,
}: {
  email: string
  name?: string | null
  token: string
  url: string
}) {
  const safeName = name?.trim() ? escapeHtml(name.trim()) : "there"
  const safeUrl = escapeHtml(url)
  const body = `Hi ${safeName}, use the link below to choose a new password for your Salomon account. This link expires automatically.`

  await sendTransactionalEmail({
    to: email,
    subject: "Reset your Salomon password",
    text: `Reset your password by opening this link: ${url}`,
    html: renderEmail({
      title: "Reset your password",
      body,
      ctaLabel: "Reset password",
      ctaUrl: safeUrl,
    }),
    idempotencyKey: `auth-reset/${token}`,
  })
}
