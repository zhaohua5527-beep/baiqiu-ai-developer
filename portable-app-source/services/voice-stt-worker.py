#!/usr/bin/env python3
import json
import sys
import tempfile
import wave
from pathlib import Path

from tools.transcription_tools import transcribe_audio


def emit(payload):
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def prewarm_local_model():
    try:
        from tools.transcription_tools import _load_stt_config

        config = _load_stt_config()
        if not config.get("enabled", True) or config.get("provider", "local") != "local":
            return "skipped"
        with tempfile.TemporaryDirectory(prefix="baiqiu-stt-warm-") as temp_dir:
            audio_path = Path(temp_dir) / "silence.wav"
            with wave.open(str(audio_path), "wb") as audio:
                audio.setnchannels(1)
                audio.setsampwidth(2)
                audio.setframerate(16000)
                audio.writeframes(b"\x00\x00" * 3200)
            result = transcribe_audio(str(audio_path))
            return "ready" if result.get("success") else str(result.get("error") or "prewarm failed")
    except Exception as error:
        return str(error)


emit({"type": "ready", "prewarm": prewarm_local_model()})

for raw_line in sys.stdin:
    request_id = ""
    try:
        request = json.loads(raw_line)
        request_id = str(request.get("id") or "")
        if request.get("action") != "transcribe":
            raise ValueError("unsupported voice worker action")
        audio_path = str(request.get("audioPath") or "").strip()
        if not audio_path:
            raise ValueError("audioPath is required")
        result = transcribe_audio(audio_path)
    except Exception as error:
        result = {"success": False, "transcript": "", "error": str(error)}
    emit({"type": "result", "id": request_id, "result": result})
