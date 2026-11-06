"""Tests for speech API endpoints."""

import asyncio
import time
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

fastapi = pytest.importorskip("fastapi")

from fastapi.testclient import TestClient  # noqa: E402
from httpx import ASGITransport, AsyncClient  # noqa: E402

from openjarvis.speech._stubs import TranscriptionResult  # noqa: E402


@pytest.fixture
def mock_speech_backend():
    backend = MagicMock()
    backend.backend_id = "mock"
    backend.health.return_value = True
    backend.transcribe.return_value = TranscriptionResult(
        text="Hello world",
        language="en",
        confidence=0.95,
        duration_seconds=1.5,
        segments=[],
    )
    return backend


@pytest.fixture
def app_with_speech(mock_speech_backend):
    from fastapi import FastAPI

    from openjarvis.server.api_routes import speech_router

    app = FastAPI()
    app.state.speech_backend = mock_speech_backend
    app.include_router(speech_router)
    return app


@pytest.fixture
def client(app_with_speech):
    return TestClient(app_with_speech)


def test_transcribe_endpoint(client, mock_speech_backend):
    response = client.post(
        "/v1/speech/transcribe",
        files={"file": ("test.wav", b"fake audio data", "audio/wav")},
    )
    assert response.status_code == 200
    data = response.json()
    assert data["text"] == "Hello world"
    assert data["language"] == "en"
    assert data["confidence"] == 0.95
    assert data["duration_seconds"] == 1.5


def test_transcribe_uses_configured_language(app_with_speech, mock_speech_backend):
    app_with_speech.state.config = SimpleNamespace(speech=SimpleNamespace(language="en"))
    with TestClient(app_with_speech) as client:
        response = client.post(
            "/v1/speech/transcribe",
            files={"file": ("test.wav", b"audio", "audio/wav")},
        )
    assert response.status_code == 200
    assert mock_speech_backend.transcribe.call_args.kwargs["language"] == "en"


def test_transcribe_explicit_language_overrides_config(app_with_speech, mock_speech_backend):
    app_with_speech.state.config = SimpleNamespace(speech=SimpleNamespace(language="en"))
    with TestClient(app_with_speech) as client:
        response = client.post(
            "/v1/speech/transcribe",
            files={"file": ("test.wav", b"audio", "audio/wav")},
            data={"language": "pt"},
        )
    assert response.status_code == 200
    assert mock_speech_backend.transcribe.call_args.kwargs["language"] == "pt"


def test_transcribe_endpoint_offloads_backend_work(client, mock_speech_backend):
    expected = TranscriptionResult(
        text="Offloaded",
        language="en",
        confidence=0.9,
        duration_seconds=1.0,
        segments=[],
    )

    with patch(
        "openjarvis.server.api_routes.asyncio.to_thread",
        new_callable=AsyncMock,
    ) as mock_to_thread:
        mock_to_thread.return_value = expected
        response = client.post(
            "/v1/speech/transcribe",
            files={"file": ("test.wav", b"fake audio data", "audio/wav")},
        )

    assert response.status_code == 200
    mock_to_thread.assert_awaited_once()
    args, kwargs = mock_to_thread.await_args
    assert args == (mock_speech_backend.transcribe, b"fake audio data")
    assert kwargs == {"format": "wav", "language": None}
    assert response.json()["text"] == "Offloaded"


def test_transcribe_endpoint_surfaces_backend_error(client, mock_speech_backend):
    mock_speech_backend.transcribe.side_effect = RuntimeError("missing cublas64_12.dll")

    response = client.post(
        "/v1/speech/transcribe",
        files={"file": ("test.wav", b"fake audio data", "audio/wav")},
    )

    assert response.status_code == 500
    assert "missing cublas64_12.dll" in response.json()["detail"]


def test_transcribe_no_file(client):
    response = client.post("/v1/speech/transcribe")
    assert response.status_code == 400 or response.status_code == 422


def test_health_endpoint(client):
    response = client.get("/v1/speech/health")
    assert response.status_code == 200
    data = response.json()
    assert data["available"] is True
    assert data["backend"] == "mock"


def test_health_endpoint_includes_unavailable_reason(client, mock_speech_backend):
    mock_speech_backend.health.return_value = False
    mock_speech_backend.last_error.return_value = (
        "Install with: uv sync --extra desktop"
    )

    response = client.get("/v1/speech/health")

    assert response.status_code == 200
    data = response.json()
    assert data["available"] is False
    assert data["reason"] == "Install with: uv sync --extra desktop"


def test_health_no_backend():
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from openjarvis.server.api_routes import speech_router

    app = FastAPI()
    app.state.speech_backend = None
    app.include_router(speech_router)
    client = TestClient(app)

    response = client.get("/v1/speech/health")
    assert response.status_code == 200
    data = response.json()
    assert data["available"] is False


def test_live_session_disabled_by_default(client, monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    response = client.post("/v1/speech/live/session", json={"sdp": "offer"})
    assert response.status_code == 403


def test_live_session_uses_server_key_and_client_delegation(app_with_speech, monkeypatch):
    import httpx

    app_with_speech.state.config = SimpleNamespace(
        speech=SimpleNamespace(voice_mode="gpt_live", live_model="gpt-live-1")
    )
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    response = httpx.Response(
        201, json={"session": {"id": "live_123"}, "transport": {"sdp": "answer"}},
        request=httpx.Request("POST", "https://api.openai.com/v1/live/sessions"),
    )
    post = AsyncMock(return_value=response)
    with patch("httpx.AsyncClient.post", post), TestClient(app_with_speech) as client:
        result = client.post("/v1/speech/live/session", json={"sdp": "offer"})
    assert result.json() == {"session_id": "live_123", "sdp": "answer"}
    assert post.await_args.kwargs["headers"]["Authorization"] == "Bearer test-key"
    assert post.await_args.kwargs["json"]["session"]["delegation"] == {"type": "client"}
    assert "test-key" not in result.text


def test_live_session_requires_key(app_with_speech, monkeypatch):
    app_with_speech.state.config = SimpleNamespace(speech=SimpleNamespace(voice_mode="gpt_live"))
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    with TestClient(app_with_speech) as client:
        response = client.post("/v1/speech/live/session", json={"sdp": "offer"})
    assert response.status_code == 503


def test_hybrid_settings_persist_without_losing_other_config(app_with_speech, tmp_path):
    from openjarvis.core.config import JarvisConfig

    config = JarvisConfig()
    config._config_path = tmp_path / "config.toml"
    config._config_path.write_text('[engine]\ndefault = "ollama"\n', encoding="utf-8")
    app_with_speech.state.config = config
    with TestClient(app_with_speech) as client:
        response = client.put("/v1/speech/hybrid/settings", json={
            "voice_mode": "gpt_live", "mode": "automatic",
            "local_model": "qwen3:8b", "openai_model": "gpt-test",
        })
        assert response.status_code == 200
        assert client.get("/v1/speech/hybrid/settings").json()["voice_mode"] == "gpt_live"
    from openjarvis.core.config import tomllib

    with config._config_path.open("rb") as file:
        saved = tomllib.load(file)
    assert saved["engine"]["default"] == "ollama"
    assert saved["hybrid_routing"]["mode"] == "automatic"


def test_hybrid_settings_reject_cloud_model_disguised_as_local(app_with_speech, tmp_path):
    from openjarvis.core.config import JarvisConfig

    config = JarvisConfig()
    config._config_path = tmp_path / "config.toml"
    app_with_speech.state.config = config
    with TestClient(app_with_speech) as client:
        response = client.put("/v1/speech/hybrid/settings", json={
            "voice_mode": "gpt_live", "mode": "local", "local_model": "gpt-test",
        })
    assert response.status_code == 400
    assert not config._config_path.exists()


def test_live_delegation_uses_local_and_checks_return_boundary(app_with_speech, monkeypatch):
    from openjarvis.core.config import JarvisConfig

    config = JarvisConfig()
    config.speech.voice_mode = "gpt_live"
    config.hybrid_routing.local_model = "qwen3:8b"
    app_with_speech.state.config = config
    guard = MagicMock()
    guard.scan_outbound.return_value = "safe reply"
    app_with_speech.state.boundary_guard = guard

    async def local_stream(model, messages):
        assert model == "qwen3:8b"
        assert messages[0].content == "hello"
        yield "private reply"

    monkeypatch.setattr("openjarvis.server.cloud_router.stream_local", local_stream)
    with TestClient(app_with_speech) as client:
        response = client.post("/v1/speech/live/delegate", json={"text": "hello"})
    assert response.status_code == 200
    assert response.json()["text"] == "safe reply"
    guard.scan_outbound.assert_called_once_with("private reply", "openai:live")


def test_live_delegation_fails_closed_without_guard(app_with_speech):
    from openjarvis.core.config import JarvisConfig

    config = JarvisConfig()
    config.speech.voice_mode = "gpt_live"
    config.hybrid_routing.local_model = "qwen3:8b"
    app_with_speech.state.config = config
    with TestClient(app_with_speech) as client:
        response = client.post("/v1/speech/live/delegate", json={"text": "hello"})
    assert response.status_code == 503


# ---------------------------------------------------------------------------
# Text-to-speech
# ---------------------------------------------------------------------------


@pytest.fixture
def mock_tts_backend():
    from openjarvis.speech.tts import TTSResult

    backend = MagicMock()
    backend.backend_id = "mock_tts"
    backend.health.return_value = True
    backend.synthesize.return_value = TTSResult(
        audio=b"RIFFfake-wav-bytes",
        format="wav",
        duration_seconds=1.25,
        voice_id="mock-voice",
        sample_rate=22050,
    )
    return backend


def _tts_app(backend, *, config=None):
    from fastapi import FastAPI

    from openjarvis.server.api_routes import speech_router

    app = FastAPI()
    app.include_router(speech_router)
    # Pre-resolve so the route does not go through backend discovery.
    app.state.tts_backend = backend
    app.state.tts_resolved = True
    app.state.config = config
    return TestClient(app)


def _unresolved_tts_app():
    from fastapi import FastAPI

    from openjarvis.server.api_routes import speech_router

    app = FastAPI()
    app.include_router(speech_router)
    app.state.config = SimpleNamespace(
        speech=SimpleNamespace(
            tts_backend="kokoro", voice_id="bm_george", voice_speed=1.0
        )
    )
    return app


def test_synthesize_returns_wav(mock_tts_backend):
    client = _tts_app(mock_tts_backend)

    response = client.post("/v1/speech/synthesize", json={"text": "Hallo Welt"})

    assert response.status_code == 200
    assert response.headers["content-type"] == "audio/wav"
    assert response.headers["x-sample-rate"] == "22050"
    assert response.headers["x-voice-id"] == "mock-voice"
    assert response.content == b"RIFFfake-wav-bytes"
    assert mock_tts_backend.synthesize.call_args.kwargs["output_format"] == "wav"


def test_synthesize_honours_request_overrides(mock_tts_backend):
    client = _tts_app(mock_tts_backend)

    client.post(
        "/v1/speech/synthesize",
        json={"text": "Hallo", "voice_id": "de_DE-thorsten-medium", "speed": 1.5},
    )

    kwargs = mock_tts_backend.synthesize.call_args.kwargs
    assert kwargs["voice_id"] == "de_DE-thorsten-medium"
    assert kwargs["speed"] == 1.5


def test_synthesize_rejects_empty_text(mock_tts_backend):
    client = _tts_app(mock_tts_backend)

    response = client.post("/v1/speech/synthesize", json={"text": "   "})

    assert response.status_code == 400
    mock_tts_backend.synthesize.assert_not_called()


def test_synthesize_rejects_oversized_text(mock_tts_backend):
    from openjarvis.server.api_routes import _MAX_TTS_CHARS

    client = _tts_app(mock_tts_backend)

    response = client.post(
        "/v1/speech/synthesize", json={"text": "a" * (_MAX_TTS_CHARS + 1)}
    )

    assert response.status_code == 413
    mock_tts_backend.synthesize.assert_not_called()


def test_synthesize_without_backend_returns_501():
    client = _tts_app(None)

    response = client.post("/v1/speech/synthesize", json={"text": "Hallo"})

    assert response.status_code == 501


def test_synthesize_surfaces_backend_failure(mock_tts_backend):
    mock_tts_backend.synthesize.side_effect = RuntimeError("voice model missing")
    client = _tts_app(mock_tts_backend)

    response = client.post("/v1/speech/synthesize", json={"text": "Hallo"})

    assert response.status_code == 500
    assert response.json()["detail"] == "Speech synthesis failed"


def test_synthesize_offloads_backend_work(mock_tts_backend):
    from openjarvis.speech.tts import TTSResult

    client = _tts_app(mock_tts_backend)
    expected = TTSResult(audio=b"RIFFoffloaded", format="wav", sample_rate=22050)

    with patch(
        "openjarvis.server.api_routes.asyncio.to_thread",
        new_callable=AsyncMock,
        return_value=expected,
    ) as to_thread:
        response = client.post("/v1/speech/synthesize", json={"text": "Hallo"})

    assert response.content == b"RIFFoffloaded"
    to_thread.assert_awaited_once()


def test_tts_health_reports_backend(mock_tts_backend):
    client = _tts_app(mock_tts_backend)

    data = client.get("/v1/speech/tts/health").json()

    assert data["available"] is True
    assert data["backend"] == "mock_tts"


def test_tts_health_without_backend():
    client = _tts_app(None)

    data = client.get("/v1/speech/tts/health").json()

    assert data["available"] is False
    assert "reason" in data


def test_tts_health_retries_after_unavailable(mock_tts_backend):
    app = _unresolved_tts_app()
    client = TestClient(app)

    with patch(
        "openjarvis.speech._tts_discovery.get_tts_backend",
        side_effect=[None, mock_tts_backend],
    ) as discover:
        assert client.get("/v1/speech/tts/health").json()["available"] is False
        assert client.get("/v1/speech/tts/health").json()["available"] is True
        assert client.get("/v1/speech/tts/health").json()["available"] is True

    assert discover.call_count == 2


@pytest.mark.asyncio
async def test_concurrent_tts_health_requests_share_resolution(mock_tts_backend):
    app = _unresolved_tts_app()

    def discover(_preferred):
        time.sleep(0.05)
        return mock_tts_backend

    with patch(
        "openjarvis.speech._tts_discovery.get_tts_backend", side_effect=discover
    ) as mock_discover:
        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://testserver"
        ) as client:
            responses = await asyncio.gather(
                *(client.get("/v1/speech/tts/health") for _ in range(3))
            )

    assert all(response.json()["available"] is True for response in responses)
    mock_discover.assert_called_once_with("kokoro")


@pytest.mark.asyncio
async def test_concurrent_unavailable_probes_share_attempt_then_retry(mock_tts_backend):
    app = _unresolved_tts_app()
    attempts = 0

    def discover(_preferred):
        nonlocal attempts
        attempts += 1
        time.sleep(0.05)
        return None if attempts == 1 else mock_tts_backend

    with patch(
        "openjarvis.speech._tts_discovery.get_tts_backend", side_effect=discover
    ):
        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://testserver"
        ) as client:
            responses = await asyncio.gather(
                *(client.get("/v1/speech/tts/health") for _ in range(3))
            )
            assert all(response.json()["available"] is False for response in responses)
            assert attempts == 1
            assert (await client.get("/v1/speech/tts/health")).json()["available"]

    assert attempts == 2


def test_invalid_synthesis_does_not_load_tts_backend():
    client = TestClient(_unresolved_tts_app())

    with patch("openjarvis.speech._tts_discovery.get_tts_backend") as discover:
        response = client.post("/v1/speech/synthesize", json={"text": "  "})

    assert response.status_code == 400
    discover.assert_not_called()


def test_voice_id_not_reused_across_backends(mock_tts_backend):
    """A configured voice belongs to its backend; a fallback uses its own."""
    from types import SimpleNamespace

    config = SimpleNamespace(
        speech=SimpleNamespace(
            tts_backend="kokoro", voice_id="bm_george", voice_speed=1.0
        )
    )
    client = _tts_app(mock_tts_backend, config=config)

    client.post("/v1/speech/synthesize", json={"text": "Hallo"})

    # Backend is mock_tts, not the configured kokoro, so bm_george must not leak.
    assert mock_tts_backend.synthesize.call_args.kwargs["voice_id"] != "bm_george"
