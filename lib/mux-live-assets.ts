import { mux } from "@/lib/mux"

interface MuxLiveStreamAssetShape {
  active_asset_id?: string | null
  recent_asset_ids?: string[] | null
}

function isMuxNotFoundError(error: unknown) {
  if (!error || typeof error !== "object") {
    return false
  }

  const status =
    "status" in error && typeof error.status === "number"
      ? error.status
      : "statusCode" in error && typeof error.statusCode === "number"
        ? error.statusCode
        : null

  if (status === 404) {
    return true
  }

  const message =
    "message" in error && typeof error.message === "string"
      ? error.message.toLowerCase()
      : ""

  return message.includes("not found") || message.includes("404")
}

function getCandidateAssetIds(liveStream: MuxLiveStreamAssetShape) {
  const ids = new Set<string>()

  if (Array.isArray(liveStream.recent_asset_ids)) {
    for (const assetId of liveStream.recent_asset_ids) {
      if (typeof assetId === "string" && assetId.trim()) {
        ids.add(assetId)
      }
    }
  }

  if (typeof liveStream.active_asset_id === "string" && liveStream.active_asset_id.trim()) {
    ids.add(liveStream.active_asset_id)
  }

  return [...ids]
}

export async function bestEffortDeleteMuxAssetsForLiveStream(
  liveStream: MuxLiveStreamAssetShape
) {
  const assetIds = getCandidateAssetIds(liveStream)
  if (assetIds.length === 0) {
    return
  }

  await Promise.allSettled(
    assetIds.map(async (assetId) => {
      try {
        await mux.video.assets.delete(assetId)
      } catch (error) {
        if (isMuxNotFoundError(error)) {
          return
        }

        console.warn(`[mux-assets] unable to delete asset ${assetId}`, error)
      }
    })
  )
}
