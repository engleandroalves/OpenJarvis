"""Local speech synthesis using Windows' installed SAPI voices."""

from __future__ import annotations

import base64
import io
import json
import subprocess
import sys
import wave

from openjarvis.core.registry import TTSRegistry
from openjarvis.speech.tts import TTSBackend, TTSResult

_SCRIPT = r"""
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$request = [Console]::In.ReadToEnd() | ConvertFrom-Json
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
    if ($request.action -eq 'voices') {
        $voices = @($synth.GetInstalledVoices() | Where-Object { $_.Enabled } | ForEach-Object { $_.VoiceInfo.Name })
        [Console]::Out.Write((ConvertTo-Json -InputObject $voices -Compress))
    } else {
        if ($request.voice) { $synth.SelectVoice([string]$request.voice) }
        $synth.Rate = [Math]::Max(-10, [Math]::Min(10, [int][Math]::Round(([double]$request.speed - 1) * 10)))
        $stream = New-Object System.IO.MemoryStream
        try {
            $synth.SetOutputToWaveStream($stream)
            $synth.Speak([string]$request.text)
            $synth.SetOutputToNull()
            [Console]::Out.Write([Convert]::ToBase64String($stream.ToArray()))
        } finally { $stream.Dispose() }
    }
} finally { $synth.Dispose() }
"""


def _run(request: dict) -> str:
    if sys.platform != "win32":
        raise RuntimeError("Windows speech synthesis is only available on Windows")
    result = subprocess.run(
        ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", _SCRIPT],
        input=json.dumps(request, ensure_ascii=True),
        text=True,
        capture_output=True,
        check=True,
        timeout=120,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    return result.stdout


@TTSRegistry.register("windows")
class WindowsTTSBackend(TTSBackend):
    """Use voices already installed in Windows, without network access."""

    backend_id = "windows"

    def available_voices(self) -> list[str]:
        return json.loads(_run({"action": "voices"}))

    def health(self) -> bool:
        try:
            return bool(self.available_voices())
        except (OSError, ValueError, subprocess.SubprocessError, RuntimeError):
            return False

    def synthesize(
        self, text: str, *, voice_id: str = "", speed: float = 1.0,
        output_format: str = "wav",
    ) -> TTSResult:
        if output_format != "wav":
            raise ValueError("Windows speech synthesis supports WAV output only")
        audio = base64.b64decode(_run({
            "action": "synthesize", "text": text, "voice": voice_id, "speed": speed,
        }), validate=True)
        with wave.open(io.BytesIO(audio), "rb") as wav:
            sample_rate = wav.getframerate()
            duration = wav.getnframes() / sample_rate
        return TTSResult(audio=audio, format="wav", voice_id=voice_id,
                         sample_rate=sample_rate, duration_seconds=duration,
                         metadata={"backend": self.backend_id})
