"""Application-wide default constants for session settings, timeouts, etc."""

# Code execution defaults
DEFAULT_EXECUTION_TIMEOUT_SEC = 60
DEFAULT_AGENT_TIMEOUT_SEC = 600
DEFAULT_REQUEST_TIMEOUT_SEC = 300
DEFAULT_MAX_FIX_ATTEMPTS = 3
DEFAULT_MAX_ITERATIONS = 5

# LLM defaults
# КАО#VR-29 — Coder max_tokens raised 64000 → 128000 because real-world HTML
# generations for browser-language sessions (Conway's Life, fractals,
# visualisations) regularly land at 60–62k chars (~75–80k tokens) and have
# been observed to truncate mid-`<script>` at 64000, silently breaking the
# rendered page (browser ignores unclosed inline script). 128k is supported
# by Opus 4.6+, Sonnet 4.5+, Gemini 2.5/3, GPT-5; providers below that cap
# are auto-clamped by their own SDK without breaking the request.
DEFAULT_CODER_MAX_TOKENS = 128000
DEFAULT_TESTER_MAX_TOKENS = 32768
DEFAULT_SUMMARIZER_MAX_TOKENS = 32768
DEFAULT_FINALIZER_MAX_TOKENS = 32768
DEFAULT_CODER_TEMPERATURE = 0.7
DEFAULT_TESTER_TEMPERATURE = 0.3
DEFAULT_SUMMARIZER_TEMPERATURE = 0.3
DEFAULT_FINALIZER_TEMPERATURE = 0.4

# WebSocket
WS_MAX_MESSAGE_SIZE_BYTES = 64 * 1024  # 64 KB
WS_RECEIVE_TIMEOUT_SEC = 300

# Adaptive iteration parameters (from Agent Team review)
ADAPTIVE_TEMP_BY_ITERATION = {1: None, 2: 0.5, 3: 0.3}  # None = use configured
ADAPTIVE_MAX_TOKENS_LATER_ITERATIONS = 32768
