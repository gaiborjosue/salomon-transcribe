import { PrismaPg } from "@prisma/adapter-pg"
import { PrismaClient } from "@/generated/prisma/client"

const connectionString = process.env.DATABASE_URL

if (!connectionString) {
  throw new Error("DATABASE_URL is not configured.")
}

const adapter = new PrismaPg({ connectionString })

const globalForPrisma = globalThis as typeof globalThis & {
  prisma?: PrismaClient
  prismaVersion?: number
}

const PRISMA_CLIENT_VERSION = 6

const shouldCreatePrismaClient =
  !globalForPrisma.prisma ||
  globalForPrisma.prismaVersion !== PRISMA_CLIENT_VERSION ||
  typeof globalForPrisma.prisma.muxLiveSession?.findMany !== "function" ||
  typeof globalForPrisma.prisma.muxTranscriptEntry?.findMany !== "function" ||
  typeof globalForPrisma.prisma.rtmpSession?.findMany !== "function" ||
  typeof globalForPrisma.prisma.rtmpTranscriptEntry?.findMany !== "function" ||
  typeof globalForPrisma.prisma.sharedSession?.findMany !== "function" ||
  typeof globalForPrisma.prisma.sharedSessionEntry?.findMany !== "function" ||
  typeof globalForPrisma.prisma.transcriptSession?.findMany !== "function" ||
  typeof globalForPrisma.prisma.transcriptSessionEntry?.findMany !== "function"

const prisma: PrismaClient = shouldCreatePrismaClient
  ? new PrismaClient({
      adapter,
    })
  : globalForPrisma.prisma!

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma
  globalForPrisma.prismaVersion = PRISMA_CLIENT_VERSION
}

export default prisma
