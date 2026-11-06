"""Pure routing decisions for the experimental hybrid voice workflow.

This policy does not perform inference, access tools, or send data. Callers
must enforce outbound-data and tool-approval policies before dispatch.
"""

from __future__ import annotations

from dataclasses import dataclass

from openjarvis.core.config import HybridRoutingConfig
from openjarvis.learning.routing.router import build_routing_context


@dataclass(frozen=True, slots=True)
class HybridDecision:
    provider: str
    model: str
    reason: str


def select_hybrid_route(
    text: str, config: HybridRoutingConfig, *, default_local_model: str = ""
) -> HybridDecision:
    """Choose a configured destination without dispatching the request."""
    if config.mode not in {"local", "openai", "automatic"}:
        raise ValueError("hybrid_routing.mode must be local, openai, or automatic")
    if not 0 <= config.complexity_threshold <= 1:
        raise ValueError("hybrid_routing.complexity_threshold must be between 0 and 1")
    local_model = config.local_model.strip() or default_local_model.strip()
    if config.mode == "local":
        if not local_model:
            raise ValueError("A local model must be configured")
        return HybridDecision("local", local_model, "configured local mode")
    if config.mode == "openai":
        if not config.openai_model.strip():
            raise ValueError("An OpenAI model must be configured")
        return HybridDecision("openai", config.openai_model.strip(), "configured OpenAI mode")
    if not local_model or not config.openai_model.strip():
        raise ValueError("Automatic routing requires local and OpenAI models")
    context = build_routing_context(text)
    if context.complexity_score >= config.complexity_threshold:
        return HybridDecision("openai", config.openai_model.strip(), "complexity threshold")
    return HybridDecision("local", local_model, "below complexity threshold")
