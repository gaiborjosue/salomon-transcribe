export const INGEST_CONTROL_HEADER = "x-salomon-ingest-secret"

export function getIngestControlHeaders() {
  const secret = process.env.INGEST_CONTROL_SECRET?.trim()
  if (!secret && process.env.NODE_ENV === "production") {
    throw new Error("INGEST_CONTROL_SECRET is not configured.")
  }

  return {
    "Content-Type": "application/json",
    ...(secret ? { [INGEST_CONTROL_HEADER]: secret } : {}),
  }
}
