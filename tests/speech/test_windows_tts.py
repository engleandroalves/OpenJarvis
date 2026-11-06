"""Tests for the Windows built-in speech backend."""

import io
import sys
import wave
from unittest.mock import patch

import pytest

from openjarvis.speech.windows_tts import WindowsTTSBackend


def test_synthesis_passes_text_as_data_and_returns_wav():
    import base64

    output = io.BytesIO()
    with wave.open(output, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(16000)
        wav.writeframes(b"\0\0" * 16000)
    with patch("openjarvis.speech.windows_tts._run", return_value=base64.b64encode(output.getvalue()).decode()) as run:
        result = WindowsTTSBackend().synthesize('Olá; $(unexpected)', voice_id="Maria")
    assert run.call_args.args[0]["text"] == 'Olá; $(unexpected)'
    assert result.audio == output.getvalue()
    assert result.sample_rate == 16000
    assert result.duration_seconds == 1


def test_unavailable_outside_windows():
    if sys.platform == "win32":
        pytest.skip("Windows has its own speech service")
    assert not WindowsTTSBackend().health()


@pytest.mark.skipif(sys.platform != "win32", reason="requires Windows voices")
def test_installed_windows_voice_generates_audio():
    backend = WindowsTTSBackend()
    if not backend.health():
        pytest.skip("no Windows voice installed")
    assert backend.synthesize("Hello.").audio.startswith(b"RIFF")
