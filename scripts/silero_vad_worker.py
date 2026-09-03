#!/usr/bin/env python3
import base64
import json
import sys

import numpy as np
from silero_vad import VADIterator, load_silero_vad

FRAME_SAMPLES = 512
SAMPLE_RATE = 16000


class SessionState:
    def __init__(self, config):
        self.config = config
        self.model = load_silero_vad()
        self.iterator = VADIterator(
            self.model,
            threshold=config["threshold"],
            sampling_rate=SAMPLE_RATE,
            min_silence_duration_ms=config["minSilenceDurationMs"],
            speech_pad_ms=config["speechPadMs"],
        )
        self.pending = np.array([], dtype=np.int16)


def normalize_config(raw_config):
    return {
        "minSilenceDurationMs": int(raw_config.get("minSilenceDurationMs", 650)),
        "speechPadMs": int(raw_config.get("speechPadMs", 500)),
        "threshold": float(raw_config.get("threshold", 0.5)),
    }


SESSIONS = {}


def get_session(session_id, raw_config):
    config = normalize_config(raw_config or {})
    existing = SESSIONS.get(session_id)
    if existing and existing.config == config:
        return existing

    session = SessionState(config)
    SESSIONS[session_id] = session
    return session


def reset_session(session_id):
    SESSIONS.pop(session_id, None)


def analyze_pcm16(payload):
    session_id = payload["sessionId"]
    session = get_session(session_id, payload.get("config") or {})

    raw_audio = base64.b64decode(payload["audio"])
    samples = np.frombuffer(raw_audio, dtype=np.int16)

    if samples.size == 0:
        return {
            "currentSample": int(session.iterator.current_sample),
            "events": [],
            "triggered": bool(session.iterator.triggered),
        }

    combined = (
        np.concatenate((session.pending, samples))
        if session.pending.size
        else samples
    )

    frame_count = combined.size // FRAME_SAMPLES
    usable = combined[: frame_count * FRAME_SAMPLES]
    session.pending = combined[frame_count * FRAME_SAMPLES :]

    events = []

    for frame_index in range(frame_count):
        frame = usable[
            frame_index * FRAME_SAMPLES : (frame_index + 1) * FRAME_SAMPLES
        ].astype(np.float32)
        frame = frame / 32768.0
        event = session.iterator(frame)
        if not event:
            continue

        if "start" in event:
            events.append({"sample": int(event["start"]), "type": "start"})
        elif "end" in event:
            events.append({"sample": int(event["end"]), "type": "end"})

    return {
        "currentSample": int(session.iterator.current_sample),
        "events": events,
        "triggered": bool(session.iterator.triggered),
    }


def write_message(message):
    sys.stdout.write(json.dumps(message) + "\n")
    sys.stdout.flush()


def main():
    write_message({"type": "ready"})

    for raw_line in sys.stdin:
      line = raw_line.strip()
      if not line:
          continue

      try:
          payload = json.loads(line)
          message_id = payload.get("id")
          if message_id is None:
              continue

          operation = payload.get("op", "analyze")
          session_id = payload.get("sessionId")
          if not isinstance(session_id, str) or not session_id:
              raise ValueError("Missing sessionId.")

          if operation == "reset":
              reset_session(session_id)
              write_message({"id": message_id, "ok": True, "result": {"reset": True}})
              continue

          result = analyze_pcm16(payload)
          write_message({"id": message_id, "ok": True, "result": result})
      except Exception as error:  # noqa: BLE001
          message_id = None
          try:
              message_id = json.loads(line).get("id")
          except Exception:  # noqa: BLE001
              pass
          write_message(
              {
                  "error": str(error),
                  "id": message_id,
                  "ok": False,
              }
          )


if __name__ == "__main__":
    main()
