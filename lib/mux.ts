import Mux from "@mux/mux-node"

const tokenId = process.env.MUX_TOKEN_ID
const tokenSecret = process.env.MUX_TOKEN_SECRET
const webhookSecret = process.env.MUX_WEBHOOK_SECRET

if (!tokenId || !tokenSecret) {
  throw new Error("MUX_TOKEN_ID and MUX_TOKEN_SECRET must be configured.")
}

export const mux = new Mux({
  tokenId,
  tokenSecret,
  webhookSecret,
})
