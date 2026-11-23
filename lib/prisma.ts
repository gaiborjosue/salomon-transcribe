import { PrismaPg } from "@prisma/adapter-pg"
import { PrismaClient } from "@/generated/prisma/client"

const connectionString = process.env.DATABASE_URL

if (!connectionString) {
  throw new Error("DATABASE_URL is not configured.")
}

const globalForPrisma = globalThis as typeof globalThis & {
  prisma?: PrismaClient
  prismaConnectionString?: string
}

// Hot reload can preserve the old instance after the generated client changes.
const prisma =
  process.env.NODE_ENV !== "production" &&
  globalForPrisma.prisma?.constructor === PrismaClient &&
  globalForPrisma.prismaConnectionString === connectionString
    ? globalForPrisma.prisma
    : new PrismaClient({ adapter: new PrismaPg({ connectionString }) })

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma
  globalForPrisma.prismaConnectionString = connectionString
}

export default prisma
