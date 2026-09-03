import { auth } from "@/lib/auth"

export async function getApiSession(request: Request) {
  return auth.api.getSession({
    headers: request.headers,
  })
}
