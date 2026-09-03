#!/usr/bin/env python3
import base64
import csv
import json
import sys
from pathlib import Path

import numpy as np
import tensorflow as tf
import tensorflow_hub as hub

MODEL_URL = "https://tfhub.dev/google/yamnet/1"

SPEECH_KEYWORDS = (
    "speech",
    "conversation",
    "narration",
    "monologue",
    "whisper",
    "hubbub",
    "babble",
)

MUSIC_KEYWORDS = (
    "music",
    "instrument",
    "singing",
    "choir",
    "chant",
    "humming",
    "guitar",
    "piano",
    "organ",
    "drum",
    "gospel",
)


def load_model():
    model = hub.load(MODEL_URL)
    class_map_path = Path(model.class_map_path().numpy().decode())
    labels = []
    with class_map_path.open(newline="") as csv_file:
        reader = csv.DictReader(csv_file)
        for row in reader:
            labels.append(row["display_name"])
    return model, labels


MODEL, LABELS = load_model()
SPEECH_INDICES = [
    index
    for index, label in enumerate(LABELS)
    if any(keyword in label.lower() for keyword in SPEECH_KEYWORDS)
]
MUSIC_INDICES = [
    index
    for index, label in enumerate(LABELS)
    if any(keyword in label.lower() for keyword in MUSIC_KEYWORDS)
]


def classify_pcm16(payload):
    raw_audio = base64.b64decode(payload["audio"])
    sample_rate = int(payload.get("sampleRate") or 16000)

    waveform = np.frombuffer(raw_audio, dtype=np.int16).astype(np.float32)
    if waveform.size == 0:
        return {
            "decision": "speech",
            "musicScore": 0.0,
            "speechScore": 0.0,
            "topLabel": "",
            "topScore": 0.0,
        }

    waveform = waveform / 32768.0

    if sample_rate != 16000:
        raise ValueError("YAMNet worker expects 16k mono PCM input.")

    scores, _, _ = MODEL(waveform)
    mean_scores = tf.reduce_mean(scores, axis=0).numpy()

    speech_score = float(np.sum(mean_scores[SPEECH_INDICES])) if SPEECH_INDICES else 0.0
    music_score = float(np.sum(mean_scores[MUSIC_INDICES])) if MUSIC_INDICES else 0.0
    top_index = int(np.argmax(mean_scores))
    top_label = LABELS[top_index]
    top_score = float(mean_scores[top_index])

    decision = "mixed"
    if music_score >= 0.32 and speech_score <= 0.12 and music_score > speech_score * 1.8:
      decision = "music"
    elif speech_score >= 0.18 or speech_score >= music_score:
      decision = "speech"

    return {
        "decision": decision,
        "musicScore": music_score,
        "speechScore": speech_score,
        "topLabel": top_label,
        "topScore": top_score,
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

            result = classify_pcm16(payload)
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
