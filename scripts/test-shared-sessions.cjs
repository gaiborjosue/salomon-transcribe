// Run with: node --import tsx scripts/test-shared-sessions.cjs
// Uses an in-memory Prisma double; never connects to or writes a real database.
const assert = require("node:assert/strict")

const sessions = new Map()
const entries = new Map()
let revision = Date.now()
let entryNumber = 0
let sessionReads = 0
let entryReads = 0
let failNextRead = false

const copy = (value) => structuredClone(value)
const prisma = {
  sharedSession: {
    async findUnique({ where, select }) {
      sessionReads += 1
      if (failNextRead) {
        failNextRead = false
        throw new Error("Simulated temporary database failure")
      }
      const session = where.id
        ? sessions.get(where.id)
        : [...sessions.values()].find((session) => session.code === where.code)
      if (!session) return null
      return select ? { id: session.id } : copy(session)
    },
    async create({ data }) {
      const session = {
        ...data,
        entries: undefined,
        sourceTitle: data.sourceTitle ?? null,
        updatedAt: new Date(++revision),
      }
      sessions.set(session.id, session)
      for (const entry of data.entries?.create ?? []) {
        await prisma.sharedSessionEntry.create({ data: { ...entry, sessionId: session.id } })
      }
      return {
        ...copy(session),
        entries: [...entries.values()].filter((entry) => entry.sessionId === session.id).map(copy),
      }
    },
    async update({ where, data }) {
      const session = sessions.get(where.id)
      assert.ok(session)
      const changes = Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined))
      const next = {
        ...session,
        ...changes,
        updatedAt: Object.keys(changes).length ? new Date(++revision) : session.updatedAt,
      }
      sessions.set(where.id, next)
      return copy(next)
    },
  },
  sharedSessionEntry: {
    async findMany({ where, take }) {
      entryReads += 1
      return [...entries.values()]
        .filter((entry) => entry.sessionId === where.sessionId)
        .sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id))
        .slice(0, take)
        .map(copy)
    },
    async create({ data }) {
      const entry = {
        ...data,
        id: `persisted-${String(++entryNumber).padStart(6, "0")}`,
        createdAt: new Date(revision + entryNumber),
        lowConfidence: data.lowConfidence ?? null,
        speakerId: data.speakerId ?? null,
      }
      entries.set(entry.id, entry)
      return copy(entry)
    },
    async createMany({ data }) {
      for (const entry of data) await this.create({ data: entry })
      return { count: data.length }
    },
    async deleteMany({ where }) {
      for (const [id, entry] of entries) {
        if (entry.sessionId === where.sessionId) entries.delete(id)
      }
    },
  },
  async $transaction(callback) {
    return callback(prisma)
  },
}

const prismaPath = require.resolve("../lib/prisma.ts")
require.cache[prismaPath] = {
  id: prismaPath,
  filename: prismaPath,
  loaded: true,
  exports: { __esModule: true, default: prisma },
}

function loadManager() {
  const managerPath = require.resolve(process.env.SHARED_SESSION_MANAGER_PATH ?? "../lib/shared-session-manager.ts")
  delete require.cache[managerPath]
  delete globalThis.__sharedSessionManager__
  delete globalThis.__sharedSessionManagerVersion__
  return require(managerPath).sharedSessionManager
}

const scheduled = new Map()
const keepAlives = new Map()
const originalSetTimeout = globalThis.setTimeout
const originalClearTimeout = globalThis.clearTimeout
const originalSetInterval = globalThis.setInterval
const originalClearInterval = globalThis.clearInterval
globalThis.setTimeout = (callback) => {
  const timer = {}
  scheduled.set(timer, callback)
  return timer
}
globalThis.clearTimeout = (timer) => scheduled.delete(timer)
globalThis.setInterval = (callback) => {
  const timer = {}
  keepAlives.set(timer, callback)
  return timer
}
globalThis.clearInterval = (timer) => keepAlives.delete(timer)

async function refresh() {
  for (const [timer, callback] of [...scheduled]) {
    scheduled.delete(timer)
    await callback()
  }
}

const entry = (id, text, timestampMs = 0) => ({ id, text, timestampMs })
const latestSnapshot = (events) => events.filter((event) => event.type === "snapshot").at(-1)?.snapshot

async function main() {
  // Distinct manager instances model different Next.js workers/serverless instances.
  const host = loadManager()
  const viewer = loadManager()
  const created = await host.createSession({
    sourceType: "livestream",
    sourceTitle: "YouTube livestream",
    initialEntries: [entry("host-1", "Before joining")],
  })
  const credentials = { sessionId: created.snapshot.id, hostToken: created.hostToken }
  const joined = await viewer.ensureSnapshotByCode(created.snapshot.code)
  assert.deepEqual(joined.entries.map((entry) => entry.text), ["Before joining"])

  const viewerEvents = []
  const stopViewer = viewer.subscribe(joined.id, (event) => viewerEvents.push(event))
  const hostMonitorEvents = []
  const stopMonitor = viewer.subscribe(joined.id, (event) => hostMonitorEvents.push(event), { countAsViewer: false })
  assert.equal(latestSnapshot(viewerEvents).viewerCount, 1)

  await host.syncSession({
    ...credentials,
    sourceTitle: "YouTube livestream",
    entries: [entry("host-1", "Before joining"), entry("host-2", "Live update after joining", 1000)],
  })
  await refresh()
  assert.deepEqual(latestSnapshot(viewerEvents).entries.map((entry) => entry.text), [
    "Before joining", "Live update after joining",
  ], "A viewer on a different server must receive new transcript text without reconnecting")
  assert.equal(scheduled.size, 1, "Refreshes must be shared across subscribers")

  // Sermon mode extends the last paragraph instead of always adding an entry.
  await host.syncSession({
    ...credentials,
    sourceTitle: "YouTube livestream",
    entries: [entry("host-1", "Before joining"), entry("host-2", "Live update after joining, extended paragraph", 1000)],
  })
  await refresh()
  assert.equal(latestSnapshot(viewerEvents).entries.at(-1).text, "Live update after joining, extended paragraph")

  const beforeEntries = entryReads
  const beforeEvents = viewerEvents.length
  await refresh()
  assert.equal(entryReads, beforeEntries, "Unchanged sessions should not reload the transcript")
  assert.equal(viewerEvents.length, beforeEvents, "Unchanged sessions should not emit duplicate snapshots")

  // Cached join/GET responses must also see writes from another server.
  await host.appendEntry({ ...credentials, entry: entry("host-3", "Another live entry", 2000) })
  const rejoined = await viewer.ensureSnapshotByCode(created.snapshot.code)
  assert.equal(rejoined.entries.at(-1).text, "Another live entry")
  assert.deepEqual(rejoined.entries, (await host.ensureSnapshotById(joined.id)).entries,
    "Local events and database snapshots must use the same persisted entry IDs")

  const originalError = console.error
  const errors = []
  console.error = (...args) => errors.push(args)
  try {
    failNextRead = true
    await refresh()
  } finally {
    console.error = originalError
  }
  assert.equal(errors.length, 1)
  assert.equal(scheduled.size, 1, "A temporary database error must not stop live refreshes")
  await host.updateMetadata({ ...credentials, sourceTitle: "Updated livestream title" })
  await refresh()
  assert.equal(latestSnapshot(viewerEvents).sourceTitle, "Updated livestream title")

  stopViewer()
  stopViewer()
  assert.equal(latestSnapshot(hostMonitorEvents).viewerCount, 0, "Unsubscribe must be idempotent")
  assert.equal(scheduled.size, 1, "The remaining subscriber still needs live refreshes")
  stopMonitor()
  assert.equal(scheduled.size, 0, "The last disconnect must clean up the refresh timer")

  const endedEvents = []
  const stopEndedViewer = viewer.subscribe(joined.id, (event) => endedEvents.push(event))
  await host.endSession(credentials)
  await refresh()
  assert.equal(latestSnapshot(endedEvents).status, "ended", "Session end must propagate across servers")
  assert.equal(scheduled.size, 0, "Ended sessions should stop polling")
  stopEndedViewer()

  // A read started before a local write must not roll the live cache backwards.
  const race = await host.createSession({ sourceType: "microphone" })
  const raceCredentials = { sessionId: race.snapshot.id, hostToken: race.hostToken }
  const staleRow = copy(sessions.get(race.snapshot.id))
  const findUnique = prisma.sharedSession.findUnique
  let releaseRead
  prisma.sharedSession.findUnique = ({ where }) => where.id === race.snapshot.id && !releaseRead
    ? new Promise((resolve) => { releaseRead = () => resolve(staleRow) })
    : findUnique.call(prisma.sharedSession, { where })
  const pendingRead = host.ensureSnapshotById(race.snapshot.id)
  await host.appendEntry({ ...raceCredentials, entry: entry("race", "Newer local transcript") })
  releaseRead()
  assert.equal((await pendingRead).entries.at(-1).text, "Newer local transcript")
  prisma.sharedSession.findUnique = findUnique

  // Full host snapshots are serialized and intermediate pending updates coalesced.
  const { createSharedSessionSync } = require("../lib/shared-session-sync.ts")
  const sent = []
  const completions = []
  const sync = createSharedSessionSync((request) => {
    sent.push(request)
    return new Promise((resolve) => completions.push(resolve))
  })
  const request = (text) => ({ ...credentials, entries: [entry("sync", text)] })
  const first = sync(request("First"))
  await Promise.resolve()
  const second = sync(request("Intermediate"))
  const last = sync(request("Newest"))
  assert.equal(sent.length, 1, "Only one full-snapshot request may be in flight")
  completions.shift()()
  await Promise.resolve()
  assert.deepEqual(sent.map((request) => request.entries[0].text), ["First", "Newest"])
  completions.shift()()
  await Promise.all([first, second, last])

  let failSync = true
  const retrySync = createSharedSessionSync(async () => {
    if (failSync) throw new Error("Simulated sync failure")
  })
  await assert.rejects(retrySync(request("Failed")), /Simulated sync failure/)
  failSync = false
  await retrySync(request("Recovered"))

  // Exercise the actual SSE route, not just manager listeners.
  const muxPath = require.resolve("../lib/mux-session-manager.ts")
  require.cache[muxPath] = {
    id: muxPath,
    filename: muxPath,
    loaded: true,
    exports: { muxSessionManager: { ensureSharedSessionById: async () => null } },
  }
  const { GET } = require("../app/api/shared-sessions/[sessionId]/events/route.ts")
  const routeSession = await host.createSession({
    sourceType: "livestream",
    initialEntries: [entry("route-1", "SSE join snapshot")],
  })
  const routeCredentials = { sessionId: routeSession.snapshot.id, hostToken: routeSession.hostToken }
  const params = { params: Promise.resolve({ sessionId: routeSession.snapshot.id }) }
  const abort = new AbortController()
  const response = await GET(new Request("http://localhost/api/shared-sessions/test/events", { signal: abort.signal }), params)
  assert.equal(response.status, 200)
  assert.equal(response.headers.get("Content-Type"), "text/event-stream")
  assert.equal(response.headers.get("X-Accel-Buffering"), "no")
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const initialEvent = decoder.decode((await reader.read()).value)
  assert.match(initialEvent, /event: snapshot/)
  assert.match(initialEvent, /SSE join snapshot/)

  await host.syncSession({
    ...routeCredentials,
    entries: [entry("route-1", "SSE join snapshot"), entry("route-2", "SSE live update after joining", 1000)],
  })
  const nextEvent = reader.read()
  await refresh()
  assert.match(decoder.decode((await nextEvent).value), /SSE live update after joining/)
  abort.abort()
  assert.equal((await reader.read()).done, true)
  assert.equal(scheduled.size, 0, "Aborting the SSE request must stop database refreshes")
  assert.equal(keepAlives.size, 0, "Aborting the SSE request must stop keepalives")

  const alreadyAborted = new AbortController()
  alreadyAborted.abort()
  const abortedResponse = await GET(new Request("http://localhost/api/shared-sessions/test/events", { signal: alreadyAborted.signal }), params)
  await abortedResponse.body.cancel()
  assert.equal(scheduled.size, 0, "An already-aborted request must not leak a subscription")
  assert.equal(keepAlives.size, 0)
  const missing = await GET(new Request("http://localhost/api/shared-sessions/missing/events"), {
    params: Promise.resolve({ sessionId: "missing" }),
  })
  assert.equal(missing.status, 404)

  console.log(`Shared-session regression checks passed (${sessionReads} metadata reads, ${entryReads} transcript reads).`)
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
}).finally(() => {
  globalThis.setTimeout = originalSetTimeout
  globalThis.clearTimeout = originalClearTimeout
  globalThis.setInterval = originalSetInterval
  globalThis.clearInterval = originalClearInterval
})
