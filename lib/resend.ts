import { Resend } from "resend"

const defaultFrom = process.env.RESEND_FROM

let resendClient: Resend | null = null

function getResendClient() {
  const apiKey = process.env.RESEND_API_KEY

  if (!apiKey) {
    throw new Error("RESEND_API_KEY is not configured.")
  }

  resendClient ??= new Resend(apiKey)
  return resendClient
}

export async function sendTransactionalEmail({
  html,
  idempotencyKey,
  subject,
  text,
  to,
}: {
  html: string
  idempotencyKey: string
  subject: string
  text: string
  to: string
}) {
  const resend = getResendClient()
  const { data, error } = await resend.emails.send(
    {
      from: defaultFrom,
      to: [to],
      subject,
      html,
      text,
    },
    {
      idempotencyKey,
    }
  )

  if (error) {
    throw new Error(`Failed to send email: ${error.message}`)
  }

  return data
}
