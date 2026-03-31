const SESSION_SLUG_DELIMITER = "--"

function slugify(input: string) {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
}

export function parseTranscriptSessionRef(sessionRef: string) {
  const separatorIndex = sessionRef.indexOf(SESSION_SLUG_DELIMITER)

  if (separatorIndex === -1) {
    return sessionRef
  }

  return sessionRef.slice(0, separatorIndex) || sessionRef
}

export function getTranscriptSessionPath(session: { id: string; title: string }) {
  const slug = slugify(session.title)
  return slug
    ? `/sessions/${session.id}${SESSION_SLUG_DELIMITER}${slug}`
    : `/sessions/${session.id}`
}
