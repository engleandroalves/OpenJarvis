# Hybrid voice lab

The hybrid voice integration is experimental. The Settings page persists the
voice and routing choices; a session starts only after the user clicks Voice
session. The server includes a WebRTC offer exchange at
`POST /v1/speech/live/session`, disabled unless `voice_mode` is `gpt_live`.
It requires an OpenAI API key in the server environment; the key stays on the
server. Creating a session sends data to OpenAI and may incur charges.
The existing local voice pipeline remains unchanged.

The configuration is stored in the normal local OpenJarvis TOML file:

```toml
[speech]
voice_mode = "local" # planned: local or gpt_live
live_model = "gpt-live-1"

[hybrid_routing]
mode = "local" # local, openai, or automatic
local_model = "" # empty uses intelligence.default_model
openai_model = "" # explicitly select before enabling cloud routing
complexity_threshold = 0.55
```

Delegated requests use the configured local Ollama model or OpenAI model.
Automatic routing requires explicit local and cloud models. The complexity
score is heuristic, so it is not a guarantee of task difficulty or safety.
This first version handles text delegation only; it does not yet run MCP tools
or agents, and the live session transcripts are not saved in chat history.

The browser connects to GPT-Live via WebRTC and sends delegated conversation
context to the local server. Local results are checked by the server's outbound
boundary guard before being returned to GPT-Live. In
GPT-Live mode the conversation audio is sent to OpenAI even when a delegated
task is handled by a local model. Local mode must continue to work offline.

An experimental `chatgpt_plan` Responses transport is also present but is not
connected to the UI, model router, or an OAuth login. It cannot use a ChatGPT
Plus subscription until the official Sign in with ChatGPT flow is implemented
and authorized. It does not fall back to a paid API key.

Reference: https://developers.openai.com/api/docs/guides/live
