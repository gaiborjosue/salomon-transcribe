export const SHARE_CODE_PREFIX = "SAL"

const CODE_LENGTH = 6

export function formatShareCode(input: string) {
  const compact = input.toUpperCase().replace(/[^A-Z0-9]/g, "")
  let body = compact

  if (body.startsWith(SHARE_CODE_PREFIX)) {
    body = body.slice(SHARE_CODE_PREFIX.length)
  }

  body = body.slice(0, CODE_LENGTH)
  return body ? `${SHARE_CODE_PREFIX}-${body}` : `${SHARE_CODE_PREFIX}-`
}

export function normalizeShareCode(input: string) {
  const compact = input.toUpperCase().replace(/[^A-Z0-9]/g, "")
  const body = compact.startsWith(SHARE_CODE_PREFIX)
    ? compact.slice(SHARE_CODE_PREFIX.length)
    : compact

  if (body.length !== CODE_LENGTH) {
    return null
  }

  return `${SHARE_CODE_PREFIX}-${body}`
}
