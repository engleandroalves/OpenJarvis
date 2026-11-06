"""Responses API transport for an explicitly authorized ChatGPT plan.

This module deliberately accepts an OAuth access token supplied by a future
validated sign-in flow. It never falls back to the paid API-key router.
"""

from __future__ import annotations

import json
from collections.abc import AsyncIterator, Sequence
from typing import Any

import httpx

from openjarvis.core.types import Message


class ChatGPTPlanError(RuntimeError):
    """The plan request failed or did not complete."""


async def stream_chatgpt_plan(
    model: str,
    messages: Sequence[Message],
    *,
    access_token: str,
    client: httpx.AsyncClient,
) -> AsyncIterator[str]:
    """Stream text using the documented ChatGPT-plan Responses contract."""
    if not access_token or not model:
        raise ChatGPTPlanError("ChatGPT sign-in and model selection are required")
    items: list[dict[str, Any]] = []
    instructions: list[str] = []
    for message in messages:
        role = getattr(message.role, "value", message.role)
        if role == "system":
            if message.content:
                instructions.append(message.content)
        elif role in {"user", "assistant"}:
            items.append({"role": role, "content": message.content or ""})
        else:
            raise ChatGPTPlanError("Unsupported message role for ChatGPT plan")
    if not items:
        raise ChatGPTPlanError("ChatGPT plan requires conversation input")
    payload: dict[str, Any] = {
        "model": model, "input": items, "store": False, "stream": True,
    }
    if instructions:
        payload["instructions"] = "\n\n".join(instructions)
    completed = False
    async with client.stream(
        "POST", "https://api.openai.com/v1/responses",
        headers={"Authorization": f"Bearer {access_token}"}, json=payload,
    ) as response:
        if response.status_code >= 400:
            raise ChatGPTPlanError(f"ChatGPT plan request failed (HTTP {response.status_code})")
        async for line in response.aiter_lines():
            if not line.startswith("data:"):
                continue
            data = line[5:].strip()
            if not data or data == "[DONE]":
                continue
            try:
                event = json.loads(data)
            except json.JSONDecodeError as exc:
                raise ChatGPTPlanError("Invalid ChatGPT plan event") from exc
            event_type = event.get("type")
            if event_type == "response.output_text.delta":
                delta = event.get("delta")
                if isinstance(delta, str):
                    yield delta
            elif event_type == "response.completed":
                completed = True
                break
            elif event_type in {"response.failed", "response.incomplete", "error"}:
                raise ChatGPTPlanError("ChatGPT plan response failed or was incomplete")
    if not completed:
        raise ChatGPTPlanError("ChatGPT plan stream ended before completion")
