"""Hybrid routing must never silently send data to an unconfigured provider."""

import pytest

from openjarvis.core.config import HybridRoutingConfig, JarvisConfig
from openjarvis.learning.routing.hybrid import select_hybrid_route


def test_default_is_local():
    cfg = JarvisConfig()
    assert cfg.speech.voice_mode == "local"
    decision = select_hybrid_route("hello", cfg.hybrid_routing, default_local_model="qwen3:8b")
    assert (decision.provider, decision.model) == ("local", "qwen3:8b")


def test_configuration_loads_from_toml(tmp_path, monkeypatch):
    from openjarvis.core.config import load_config

    monkeypatch.setenv("OPENJARVIS_HOME", str(tmp_path))
    path = tmp_path / "config.toml"
    path.write_text(
        '[speech]\nvoice_mode = "gpt_live"\n'
        '[hybrid_routing]\nmode = "automatic"\nlocal_model = "qwen"\n'
        'openai_model = "gpt-example"\ncomplexity_threshold = 0.7\n',
        encoding="utf-8",
    )
    load_config.cache_clear()
    try:
        config = load_config(path)
        assert config.speech.voice_mode == "gpt_live"
        assert config.hybrid_routing.mode == "automatic"
        assert config.hybrid_routing.complexity_threshold == 0.7
    finally:
        load_config.cache_clear()


def test_openai_requires_explicit_model():
    with pytest.raises(ValueError, match="OpenAI model"):
        select_hybrid_route("hello", HybridRoutingConfig(mode="openai"))


def test_automatic_requires_both_models():
    with pytest.raises(ValueError, match="requires local and OpenAI"):
        select_hybrid_route("hello", HybridRoutingConfig(mode="automatic"), default_local_model="qwen")


def test_fixed_openai_route():
    decision = select_hybrid_route("hello", HybridRoutingConfig(mode="openai", openai_model="gpt-example"))
    assert (decision.provider, decision.model) == ("openai", "gpt-example")


def test_automatic_obeys_complexity_threshold(monkeypatch):
    from types import SimpleNamespace
    from openjarvis.learning.routing import hybrid

    cfg = HybridRoutingConfig(mode="automatic", local_model="qwen", openai_model="gpt-example")
    monkeypatch.setattr(hybrid, "build_routing_context", lambda _: SimpleNamespace(complexity_score=0.1))
    assert select_hybrid_route("simple", cfg).provider == "local"
    monkeypatch.setattr(hybrid, "build_routing_context", lambda _: SimpleNamespace(complexity_score=0.8))
    assert select_hybrid_route("complex", cfg).provider == "openai"


@pytest.mark.parametrize("threshold", [-0.1, 1.1])
def test_invalid_threshold_rejected(threshold):
    with pytest.raises(ValueError, match="threshold"):
        select_hybrid_route("hello", HybridRoutingConfig(complexity_threshold=threshold))
