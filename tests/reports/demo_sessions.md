# Demo Sessions on PROD — Creation Report

Date: 2026-05-12
Target host: <https://gotcode.ai>
Target user: `levrlg@gmail.com`

All sessions were created in `status='created'` (ready to Start manually) via the
prod backend at `http://localhost:8000` inside the `codeforge-backend` container,
using a freshly-issued JWT for the user (the same flow as
`tests/reports/r12_http_smoke_prod.py`: insert OTP row → `POST /api/auth/verify-otp`
→ obtain JWT → `POST /api/sessions/`). The OTP row was deleted after use.

DB verification confirmed `user_id = levrlg@gmail.com`, `status = created`,
`language = javascript_browser`, correct agent counts, and correct
`cost_limit_usd` / `session_timeout_sec` budgets for every session.

## Summary table

| # | Name | Session ID | URL | Agents | Models | Est. wall-time | Est. cost |
|---|------|-----------|-----|--------|--------|----------------|-----------|
| 1 | Stable Fluids — Mouse Painter            | `426ac155-3173-49a4-82d4-547304076909` | <https://gotcode.ai/sessions/426ac155-3173-49a4-82d4-547304076909> | 2 coders + 2 testers + summ + final + 4 enhancers (10) | Opus 4.7 / Sonnet 4.6 / Gemini-3-Flash / GPT-5.4 / Opus 4.7 / Gemini-3-Pro | 35–55 min | $1.8–3.5 |
| 2 | Gray-Scott Reaction-Diffusion (WebGL2)   | `29379f16-348f-47c1-a0f9-3f12d2901b62` | <https://gotcode.ai/sessions/29379f16-348f-47c1-a0f9-3f12d2901b62> | 10 | same as #1 | 30–50 min | $1.5–3.2 |
| 3 | Galaxy Collision (Barnes-Hut N-Body)     | `cd2851a7-9a97-48d9-a5dc-c450b3fae7a4` | <https://gotcode.ai/sessions/cd2851a7-9a97-48d9-a5dc-c450b3fae7a4> | 10 | same as #1 | 40–60 min | $2.0–3.8 |
| 4 | Falling Sand Sandbox                     | `06ef6ad4-4e4d-43ab-b0ac-0202e01c0217` | <https://gotcode.ai/sessions/06ef6ad4-4e4d-43ab-b0ac-0202e01c0217> | 10 | same as #1 | 30–50 min | $1.5–3.0 |
| 5 | Mandelbulb 3D Attractor (WebGL2)         | `d94d9f79-56d1-4910-9d56-9219efbb6abd` | <https://gotcode.ai/sessions/d94d9f79-56d1-4910-9d56-9219efbb6abd> | 10 | same as #1 | 40–60 min | $2.0–3.8 |
| 6 | Game of Life — Pattern Gallery           | `10df0e26-fb74-4407-86af-ee3658e04431` | <https://gotcode.ai/sessions/10df0e26-fb74-4407-86af-ee3658e04431> | 1 coder + 1 tester + summ + final + 4 enhancers (8) | Sonnet 4.6 / Gemini-3-Flash / Sonnet 4.6 / Gemini-3-Flash / Opus 4.7 | 15–25 min | $0.5–1.2 |

(Hard caps: sessions 1–5: `cost_limit_usd=6.0`, `session_timeout_sec=14400` (4 h);
session 6: `cost_limit_usd=2.0`, `session_timeout_sec=5400` (90 min).)

## Per-session detail

### 1. Stable Fluids — Mouse Painter
- Pure 2D-canvas Jos-Stam Navier-Stokes solver, 128×128 MAC grid, viscosity/diffusion sliders, wall/wrap boundaries, HSL ink palette cycling every 6 s, render at 1024×1024 via bilinear ImageData.
- Agents (10): coders Opus 4.7 + Sonnet 4.6; testers Gemini-3-Flash + GPT-5.4; summarizer Opus 4.7; finalizer Gemini-3-Pro; enhancer_design/func/security/summary all Opus 4.7.
- `max_iterations: 5`, `auto_continue: true`, code execution enabled.

### 2. Gray-Scott Reaction-Diffusion (WebGL2)
- WebGL2 ping-pong float texture, 512×512, 9-point Laplacian; 8 presets (Spots, Coral, Maze, Worms, Stripes, Holes, Spirals, Bubbles); 4 palettes; click-to-seed; PNG screenshot. WebGL1 fallback.
- Same agents as #1.

### 3. Galaxy Collision (Barnes-Hut N-Body)
- 4000 stars (2 spiral galaxies of 2000), Barnes-Hut θ=0.7 quadtree, symplectic leapfrog, additive trails with 0.92-alpha fade. Pause/play, speed slider, debug-quadtree overlay.
- Same agents as #1.

### 4. Falling Sand Sandbox
- 200×120 cellular-automaton powder toy. Six materials (Sand/Water/Oil/Stone/Plant/Fire) + internal Steam. Bidirectional row sweep, putImageData at native res, brush + erase, pour-speed slider.
- Same agents as #1.

### 5. Mandelbulb 3D Attractor (WebGL2)
- Distance-estimator ray-marched Mandelbulb; phase-1 iteration-count ramp (1→8 over 20 s at n=4), phase-2 integer n morph (4→20, configurable up to 50). 6 palettes, 2 configurable lights with Kelvin-temperature colour, soft shadows, AO, orbit-trap glow, off-canvas 2D orbit overlay, FPS-driven quality scaling.
- Same agents as #1.

### 6. Game of Life — Pattern Gallery (light config)
- 160×100 toroidal grid, 12 hardcoded famous patterns (Glider, LWSS, Gosper Gun, R-Pentomino, Diehard, Acorn, Pulsar, Pentadecathlon, Beacon, Toad, Kok's Galaxy, Penta-decathlon) with cursor-stamp + thumbnail preview, neon cyan with shadowBlur glow.
- Agents (8): coder Sonnet 4.6; tester Gemini-3-Flash; summarizer Sonnet 4.6; finalizer Gemini-3-Flash; enhancer_design/func/security/summary all Opus 4.7.
- `max_iterations: 3`, `cost_limit_usd: 2.0`, `session_timeout_sec: 5400`.

## Example payload (session 1, standard config)

```jsonc
{
  "name": "Stable Fluids — Mouse Painter",
  "specification": "Build a real-time 2D Stable Fluids simulation … (full ~2000-char spec)",
  "language": "javascript_browser",
  "max_iterations": 5,
  "auto_continue": true,
  "enable_code_execution": true,
  "execution_timeout": 60,
  "max_fix_attempts": 5,
  "auto_install_deps": true,
  "agent_timeout": 1800,
  "request_timeout": 600,
  "cost_limit_usd": 6.0,
  "session_timeout_sec": 14400,
  "settings": { "streaming": true },
  "agent_configs": [
    { "agent_type": "coder",             "agent_index": 0, "llm_provider": "anthropic", "llm_model": "claude-opus-4-7"  },
    { "agent_type": "coder",             "agent_index": 1, "llm_provider": "anthropic", "llm_model": "claude-sonnet-4-6" },
    { "agent_type": "tester",            "agent_index": 0, "llm_provider": "google",    "llm_model": "gemini-3-flash"   },
    { "agent_type": "tester",            "agent_index": 1, "llm_provider": "openai",    "llm_model": "gpt-5.4"          },
    { "agent_type": "summarizer",        "agent_index": 0, "llm_provider": "anthropic", "llm_model": "claude-opus-4-7"  },
    { "agent_type": "finalizer",         "agent_index": 0, "llm_provider": "google",    "llm_model": "gemini-3-pro"     },
    { "agent_type": "enhancer_design",   "agent_index": 0, "llm_provider": "anthropic", "llm_model": "claude-opus-4-7"  },
    { "agent_type": "enhancer_func",     "agent_index": 0, "llm_provider": "anthropic", "llm_model": "claude-opus-4-7"  },
    { "agent_type": "enhancer_security", "agent_index": 0, "llm_provider": "anthropic", "llm_model": "claude-opus-4-7"  },
    { "agent_type": "enhancer_summary",  "agent_index": 0, "llm_provider": "anthropic", "llm_model": "claude-opus-4-7"  }
  ]
}
```

## Model substitutions

**None.** All requested model IDs were accepted by the prod API:
- `claude-opus-4-7`, `claude-sonnet-4-6` — accepted via regex family-detection in
  `AnthropicProvider` (matches `claude-{opus|sonnet|haiku}-N-M`).
- `gemini-3-flash`, `gemini-3-pro` — listed in `GoogleProvider.PRICING` table.
- `gpt-5.4` — listed in `OpenAIProvider.PRICING` table.

`SessionCreate.validate_provider` only restricts `llm_provider` to
`{openai, anthropic, google, grok, ollama}` — model strings are resolved at
execution time, so creation succeeded for every config. Verified post-create
via `SELECT … FROM agent_configs` against the prod DB (all 10 rows for
session #1 show the exact model IDs we POSTed).

## How the sessions were created

Script: `tests/reports/create_demo_sessions_prod.py` (in this repo).
Executed once on the prod host:

```bash
scp tests/reports/create_demo_sessions_prod.py lev@miniblack:/tmp/
ssh lev@miniblack "cd /home/lev/codeforge && \
    docker compose cp /tmp/create_demo_sessions_prod.py backend:/tmp/ && \
    docker compose exec -T -e PYTHONPATH=/app backend \
        python /tmp/create_demo_sessions_prod.py"
```

Output: 6 created, 0 failed. OTP row cleaned up.

## Verification (post-create)

```text
              session_id              |                  name                  | status  | n_agents | cost_limit | timeout
--------------------------------------+----------------------------------------+---------+----------+------------+---------
 10df0e26-fb74-4407-86af-ee3658e04431 | Game of Life — Pattern Gallery         | created |        8 |   2.00 USD |  5400 s
 d94d9f79-56d1-4910-9d56-9219efbb6abd | Mandelbulb 3D Attractor (WebGL2)       | created |       10 |   6.00 USD | 14400 s
 06ef6ad4-4e4d-43ab-b0ac-0202e01c0217 | Falling Sand Sandbox                   | created |       10 |   6.00 USD | 14400 s
 cd2851a7-9a97-48d9-a5dc-c450b3fae7a4 | Galaxy Collision (Barnes-Hut N-Body)   | created |       10 |   6.00 USD | 14400 s
 29379f16-348f-47c1-a0f9-3f12d2901b62 | Gray-Scott Reaction-Diffusion (WebGL2) | created |       10 |   6.00 USD | 14400 s
 426ac155-3173-49a4-82d4-547304076909 | Stable Fluids — Mouse Painter          | created |       10 |   6.00 USD | 14400 s
```

All six sessions are owned by `levrlg@gmail.com`, all are in `created` state,
and none have been started. The user can manually Start each from
<https://gotcode.ai/sessions> whenever they choose.
