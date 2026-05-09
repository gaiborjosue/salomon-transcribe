import { useCallback, useEffect, useRef } from "react"

const AUDIO_CUES = {
  end: "https://ui.elevenlabs.io/sounds/transcriber-end.mp3",
  error: "https://ui.elevenlabs.io/sounds/transcriber-error.mp3",
  start: "https://ui.elevenlabs.io/sounds/transcriber-start.mp3",
}

export function useAudioCues() {
  const audioRefs = useRef<Record<keyof typeof AUDIO_CUES, HTMLAudioElement | null>>({
    end: null,
    error: null,
    start: null,
  })

  useEffect(() => {
    for (const [key, url] of Object.entries(AUDIO_CUES)) {
      const audio = new Audio(url)
      audio.volume = 0.6
      audio.preload = "auto"
      audio.load()
      audioRefs.current[key as keyof typeof AUDIO_CUES] = audio
    }
  }, [])

  const play = useCallback((cue: keyof typeof AUDIO_CUES) => {
    audioRefs.current[cue]?.play().catch(() => {})
  }, [])

  const playEnd = useCallback(() => play("end"), [play])
  const playError = useCallback(() => play("error"), [play])
  const playStart = useCallback(() => play("start"), [play])

  return {
    playEnd,
    playError,
    playStart,
  }
}
