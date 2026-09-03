import { NextResponse } from "next/server"

import { getApiSession } from "@/lib/api-auth"
import prisma from "@/lib/prisma"

export async function DELETE(request: Request) {
  const session = await getApiSession(request)
  if (!session) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 })
  }

  await prisma.user.delete({
    where: {
      id: session.user.id,
    },
  })

  return NextResponse.json({ ok: true })
}

