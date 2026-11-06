"""ChatGPT plan transport obeys its documented contract without paid fallback."""

import json

import httpx
import pytest

from openjarvis.core.types import Message, Role
from openjarvis.server.chatgpt_plan import ChatGPTPlanError, stream_chatgpt_plan


@pytest.mark.asyncio
async def test_streams_plan_responses_without_unsupported_fields():
    def handler(request):
        assert request.url == "https://api.openai.com/v1/responses"
        assert request.headers["authorization"] == "Bearer oauth-token"
        body = json.loads(request.content)
        assert body == {
            "model": "allowed-model", "input": [{"role": "user", "content": "Hello"}],
            "instructions": "Be helpful", "store": False, "stream": True,
        }
        return httpx.Response(200, text='data: {"type":"response.output_text.delta","delta":"Hi"}\n\ndata: {"type":"response.completed"}\n\n')

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        result = [part async for part in stream_chatgpt_plan(
            "allowed-model", [Message(role=Role.SYSTEM, content="Be helpful"), Message(role=Role.USER, content="Hello")],
            access_token="oauth-token", client=client,
        )]
    assert result == ["Hi"]


@pytest.mark.asyncio
async def test_incomplete_stream_is_an_error():
    transport = httpx.MockTransport(lambda _: httpx.Response(200, text='data: {"type":"response.output_text.delta","delta":"Hi"}\n\n'))
    async with httpx.AsyncClient(transport=transport) as client:
        with pytest.raises(ChatGPTPlanError, match="before completion"):
            _ = [part async for part in stream_chatgpt_plan("m", [Message(role=Role.USER, content="hello")], access_token="token", client=client)]


@pytest.mark.asyncio
async def test_denial_does_not_fallback_to_paid_api():
    requests = []
    def handler(request):
        requests.append(request)
        return httpx.Response(429)
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        with pytest.raises(ChatGPTPlanError, match="429"):
            _ = [part async for part in stream_chatgpt_plan("m", [Message(role=Role.USER, content="hello")], access_token="token", client=client)]
    assert len(requests) == 1
