"""Create 6 demo sessions on PROD for user levrlg@gmail.com.

Run inside the prod backend container:
  docker compose exec -T backend python /tmp/create_demo_sessions_prod.py

Strategy: insert a one-time OTP code directly in the DB (same pattern as
tests/reports/r12_http_smoke_prod.py), verify it via HTTP to mint a JWT, then
POST each session payload. Leaves sessions in status='created'.
"""
import asyncio
import json
import sys
from datetime import datetime, timedelta, timezone

import httpx

from app.api.routes.auth import _hash_code
from app.config import get_settings
from app.db import AsyncSessionLocal
from app.db.models import OTPCode
from sqlalchemy import delete


TARGET_EMAIL = "levrlg@gmail.com"
OTP_CODE = "428913"  # arbitrary 6-digit


# --------------------------------------------------------------------------
# Standard "complex" agent config (sessions 1-5)
# --------------------------------------------------------------------------
STANDARD_AGENTS = [
    {"agent_type": "coder", "agent_index": 0, "llm_provider": "anthropic", "llm_model": "claude-opus-4-7"},
    {"agent_type": "coder", "agent_index": 1, "llm_provider": "anthropic", "llm_model": "claude-sonnet-4-6"},
    {"agent_type": "tester", "agent_index": 0, "llm_provider": "google", "llm_model": "gemini-3-flash"},
    {"agent_type": "tester", "agent_index": 1, "llm_provider": "openai", "llm_model": "gpt-5.4"},
    {"agent_type": "summarizer", "agent_index": 0, "llm_provider": "anthropic", "llm_model": "claude-opus-4-7"},
    {"agent_type": "finalizer", "agent_index": 0, "llm_provider": "google", "llm_model": "gemini-3-pro"},
    {"agent_type": "enhancer_design",   "agent_index": 0, "llm_provider": "anthropic", "llm_model": "claude-opus-4-7"},
    {"agent_type": "enhancer_func",     "agent_index": 0, "llm_provider": "anthropic", "llm_model": "claude-opus-4-7"},
    {"agent_type": "enhancer_security", "agent_index": 0, "llm_provider": "anthropic", "llm_model": "claude-opus-4-7"},
    {"agent_type": "enhancer_summary",  "agent_index": 0, "llm_provider": "anthropic", "llm_model": "claude-opus-4-7"},
]

STANDARD_BASE = {
    "language": "javascript_browser",
    "max_iterations": 5,
    "auto_continue": True,
    "enable_code_execution": True,
    "execution_timeout": 60,
    "max_fix_attempts": 5,
    "auto_install_deps": True,
    "agent_timeout": 1800,
    "request_timeout": 600,
    "cost_limit_usd": 6.0,
    "session_timeout_sec": 14400,
    "settings": {"streaming": True},
}


# --------------------------------------------------------------------------
# Lighter agent config (session 6 — Game of Life)
# --------------------------------------------------------------------------
LIGHT_AGENTS = [
    {"agent_type": "coder",      "agent_index": 0, "llm_provider": "anthropic", "llm_model": "claude-sonnet-4-6"},
    {"agent_type": "tester",     "agent_index": 0, "llm_provider": "google",    "llm_model": "gemini-3-flash"},
    {"agent_type": "summarizer", "agent_index": 0, "llm_provider": "anthropic", "llm_model": "claude-sonnet-4-6"},
    {"agent_type": "finalizer",  "agent_index": 0, "llm_provider": "google",    "llm_model": "gemini-3-flash"},
    {"agent_type": "enhancer_design",   "agent_index": 0, "llm_provider": "anthropic", "llm_model": "claude-opus-4-7"},
    {"agent_type": "enhancer_func",     "agent_index": 0, "llm_provider": "anthropic", "llm_model": "claude-opus-4-7"},
    {"agent_type": "enhancer_security", "agent_index": 0, "llm_provider": "anthropic", "llm_model": "claude-opus-4-7"},
    {"agent_type": "enhancer_summary",  "agent_index": 0, "llm_provider": "anthropic", "llm_model": "claude-opus-4-7"},
]

LIGHT_BASE = {
    "language": "javascript_browser",
    "max_iterations": 3,
    "auto_continue": True,
    "enable_code_execution": True,
    "execution_timeout": 60,
    "max_fix_attempts": 5,
    "auto_install_deps": True,
    "agent_timeout": 1800,
    "request_timeout": 600,
    "cost_limit_usd": 2.0,
    "session_timeout_sec": 5400,
    "settings": {"streaming": True},
}


# --------------------------------------------------------------------------
# Session specifications (detailed, self-contained)
# --------------------------------------------------------------------------

SPEC_FLUIDS = """Build a real-time 2D Stable Fluids simulation in a single self-contained HTML file using pure JavaScript and the 2D Canvas API (NO WebGL). This is a faithful implementation of Jos Stam's "Stable Fluids" technique (1999) so the user can watch the math working in plain JS, not hidden inside a shader.

Grid: 128 x 128 MAC-style cells. Use Float32Array everywhere — separate arrays for velocity u, v (and previous u0, v0), density/dye d (and d0), and a pressure/divergence scratch.

Solver pipeline per frame:
1. addSource: inject velocity from mouse drag (delta x/y between consecutive mouse positions, scaled), and inject ink density at the click point.
2. diffuse(velocity, viscosity) — Gauss-Seidel 20 iterations.
3. project — compute divergence, solve Poisson with Gauss-Seidel 40 iterations, subtract gradient. This enforces incompressibility.
4. advect(velocity) — semi-Lagrangian backtrace with bilinear sampling.
5. project again.
6. diffuse(density, diffusion), advect(density).
7. setBoundary helper — toggle between "wall" (reflective: u=-u on vertical walls, v=-v on horizontal) and "wrap" (toroidal indexing).

Mouse interaction: drag injects velocity vectors. Left-click also injects coloured ink. The ink colour cycles through an HSL palette (hue advances 60° every 6s, full saturation, 60% lightness). Draw the dye field as a smooth bilinear-interpolated canvas at 1024x1024 — fill an ImageData buffer by sampling the 128² dye grid with bilinear interpolation, then putImageData.

UI controls (HTML inputs overlaid in a translucent panel top-right):
- Viscosity slider (range 0 to 0.0005, step 0.00001, default 0.0002).
- Diffusion slider (range 0 to 0.0005, step 0.00001, default 0.0001).
- "Clear" button — zero all fields.
- "Boundaries" toggle button: "Wall" / "Wrap".
- FPS counter top-left.

Performance target: stable 60 fps on a 2020-era laptop. Use a single offscreen ImageData buffer, reuse all Float32Arrays, no allocations inside the per-frame loop. Time step dt = 1/60.

Single file. No external libraries. The math is the point — keep variable names readable (u, v, p, div, dens) and add brief comments on each step explaining what it does. Default viscosity 0.0002 should look like watercolour."""


SPEC_GRAY_SCOTT = """Build a WebGL2 fragment-shader implementation of the Gray-Scott reaction-diffusion equations on a 512x512 ping-pong texture in a single self-contained HTML file. If WebGL2 is unavailable, fall back to WebGL1 with the EXT_color_buffer_float extension (and OES_texture_float for float textures).

The equations are:
  dU/dt = Du * Laplacian(U) - U*V*V + F*(1-U)
  dV/dt = Dv * Laplacian(V) + U*V*V - (F+K)*V

Implementation:
- Two RGBA float (or RGBA half-float) textures storing (U, V, _, _) in the R and G channels. Ping-pong between them every step. Do ~10 simulation steps per displayed frame (target 60fps overall, so ~600 sim steps/sec).
- Laplacian uses a 9-point stencil (orthogonal weight 0.2, diagonal 0.05, centre -1.0) sampled from the input texture.
- Initial state: U=1.0, V=0.0 everywhere except a 20x20 central seed where V=0.5 perturbed with Math.random()*0.1.
- Render pass: sample bilinear-filtered V, map to a gradient palette in the fragment shader. 4 palettes selectable: Cyan/Magenta, Sunset (orange→yellow→white), Forest (green→brown→amber), Monochrome (black→grey→white).

UI panel (HTML overlay, translucent dark background):
- F slider 0.02-0.07, step 0.001, default 0.054.
- K slider 0.04-0.07, step 0.001, default 0.062.
- Diffusion-ratio slider 0.5-2.0 (Du / Dv), default 1.0 (use Du=1.0, Dv=0.5 baseline so the ratio multiplies Dv).
- Preset dropdown with 8 named patterns — each sets F+K:
    Spots (F=0.035, K=0.065), Coral (F=0.062, K=0.062), Maze (F=0.029, K=0.057),
    Worms (F=0.054, K=0.063), Stripes (F=0.022, K=0.051), Holes (F=0.039, K=0.058),
    Spirals (F=0.018, K=0.050), Bubbles (F=0.098, K=0.057).
- Palette dropdown.
- "Reset" button — re-seeds the central square.
- "Screenshot" button — exports the current canvas as PNG via canvas.toDataURL.

Interaction: clicking on the canvas adds a new circular V=0.7 seed at the click location (radius ~10 px) by rendering a tiny circle into the current state texture (use a separate "splat" shader or by writing a small subregion).

Use vanilla WebGL2 — no shader libraries, no Three.js. Inline the vertex and fragment shaders as JS string constants. Single HTML file, < 600 lines."""


SPEC_GALAXY = """Build a real-time gravitational N-body simulation of two colliding spiral galaxies (2000 stars each, 4000 total) in a single self-contained HTML file using 2D canvas and pure JavaScript. Use a Barnes-Hut quadtree with opening criterion θ=0.7 so the per-step complexity is O(n log n) and the sim runs at ≥45 fps.

Initial conditions:
- Galaxy A: centre at (-300, 0). Massive point-mass core at the centre (mass = 5000). 2000 stars distributed as an exponential disk: radius r = -80 * ln(1 - Math.random()*0.95) (scale length 80px), angle uniform. Each star gets a circular orbital velocity v = sqrt(G * M_core / r) tangent to the radius vector, PROGRADE (counter-clockwise). Tag the galaxy id (0).
- Galaxy B: centre at (+300, 0). Same disk distribution. Orbit is RETROGRADE (clockwise). Tag id (1).
- Both galaxy cores get an additional bulk velocity perpendicular to the line connecting them: A gets (0, +0.6), B gets (0, -0.6) — so they approach with relative velocity 1.2 and pass close to each other.

Use G = 1.0 and a softening epsilon^2 = 4.0 to avoid singular forces. Stars have mass 1; the two cores have mass 5000.

Per frame:
1. Build a quadtree over all bodies (recursive subdivision until each leaf has ≤1 body or depth limit 20). Each internal node stores total mass and centre-of-mass.
2. For each body, walk the tree: if s/d < θ where s = node size and d = distance to centre-of-mass, treat node as one mass; else recurse. Accumulate Newtonian acceleration a = G*m * (dx,dy) / (d^2 + eps^2)^(3/2).
3. Symplectic leapfrog integrate: v += a*dt; x += v*dt. dt = 0.5.

Rendering:
- Canvas 1280x720, dark background #0a0a14.
- Clear by drawing a translucent black rect (alpha 0.08) — this creates the cinematic streak trails (each frame fades the previous frame by ~8%).
- Each star drawn as a 1x1 px filled rect with globalCompositeOperation='lighter' for additive blending.
- Star colour: HSL by galaxy id. Galaxy A: warm hues (h = 20 + random*20, s=70%, l=60%). Galaxy B: cool hues (h = 210 + random*30, s=70%, l=60%).
- Galaxy cores drawn as 3x3 px bright cores.

UI overlay:
- Pause/Play toggle button.
- "Reset" button — re-randomizes seed.
- Speed slider (0.25x - 4x) that scales dt.
- "Show quadtree" checkbox — when on, draw quadtree node boundaries with 1px translucent white strokes (cap at depth 6 to keep readable).
- FPS counter.

No external libraries. Single HTML file. Heavy use of typed arrays (Float64Array for positions/velocities, Int32Array for ids) for cache-friendly inner loop. Stars are panned/zoomed automatically: compute the bounding box of all bodies, set camera so the whole system fits with 10% margin."""


SPEC_FALLING_SAND = """Build a powder-toy-style falling-sand sandbox in a single self-contained HTML file using 2D canvas and pure JavaScript. Grid 200 wide x 120 tall = 24000 cells. Render via a single ImageData buffer + putImageData each frame at native resolution then CSS-upscale the canvas to 800x480 with image-rendering: pixelated. Target frame rate: 120 fps.

Six materials with these properties:
  EMPTY = 0
  SAND = 1   — falls straight down; if blocked, falls diagonally L/R (45° pile angle).
  WATER = 2  — falls down; if blocked, spreads horizontally up to 5 cells (random direction).
  OIL = 3    — falls down. Floats on water: when below a water cell, swap with the water cell above (oil is less dense). Ignites if adjacent to fire (becomes fire with prob 0.4).
  STONE = 4  — immovable.
  PLANT = 5  — grows: every frame, with prob 0.005, if adjacent to both water and empty, convert one adjacent empty cell to plant. Burns: ignites adjacent to fire.
  FIRE = 6   — rises (move up, with random L/R diagonal). Lifetime 60 frames; after that, becomes empty. Ignites adjacent oil/plant. When fire meets water: fire becomes empty, water becomes steam (drawn as light grey, rises, vanishes after 30 frames). Steam is a 7th internal-only material; not exposed in UI.

Update rules:
- Use a deterministic top-to-bottom row sweep, but alternate left-to-right vs right-to-left scan direction every frame to avoid bias.
- Within a row, sand/water/oil sweep top-down; fire sweeps bottom-up.
- Use a "moved this frame" bit-flag array to prevent double-updates of a cell already processed.

UI panel (HTML overlay below the canvas):
- 6 material buttons in a row (Sand, Water, Oil, Stone, Plant, Fire). Selected button is highlighted.
- Brush-size slider 1 to 8 (radius in cells), default 3.
- "Clear" button — zero entire grid.
- "Pour speed" slider 1-10 — how many cells per frame are added while the mouse is held.

Interaction:
- Left-button drag: paint with selected material in a brush of the current radius (circular brush, anti-symmetric mask).
- Right-button drag: erase to EMPTY.
- Brush draws every frame while the button is held — independent of mouse-move event rate.

Colours (RGBA uint32 packed into the ImageData):
  Sand #E6CFA0 alpha 255
  Water rgba(79, 168, 224, 217) — 0.85 alpha
  Oil #6B5436 alpha 255
  Stone #555555 alpha 255
  Plant #4CA84C alpha 255
  Fire — base #FF6A2C with per-cell flicker: hue noise +/- 8°, brightness noise +/- 15%
  Steam rgba(220, 220, 230, 120)
  Empty — black

No external libraries. Single HTML file. Performance: use Uint8Array for the grid (one byte per cell) and a single Uint32Array view over the ImageData's underlying buffer for fast RGBA writes. FPS counter top-left."""


SPEC_GAME_OF_LIFE = """Build Conway's Game of Life with a Pattern Gallery in a single self-contained HTML file using 2D canvas and pure JavaScript. Grid 160 wide x 100 tall = 16000 cells, TOROIDAL topology (edges wrap). Target 150 generations/second at max speed.

Core simulation:
- Two Uint8Array grids (current, next) — double-buffered, swap pointers each step.
- Neighbour count: 8-cell von-Neumann-extended (Moore) with toroidal wraparound (modulo W, H).
- B3/S23: a dead cell with exactly 3 live neighbours becomes alive; a live cell with 2 or 3 live neighbours stays alive; everything else dies.

Rendering:
- Canvas displayed at 960x600 (cell size 6x6 px).
- Black background (#000).
- Live cells: neon cyan #00E5FF with subtle glow via ctx.shadowBlur=4, ctx.shadowColor=#00E5FF. Cells drawn as 5x5 fillRects (1px gap to suggest a grid).
- Generation counter and live-cell count text shown top-left in monospace neon white.

UI panel (HTML overlay top-right, translucent dark):
- "Clear" button (zero grid).
- "Random" button — fill at 15% density.
- "Run / Pause" toggle.
- "Step" button (single generation while paused).
- Speed slider 1x-60x generations per second.
- Pattern Gallery DROPDOWN with 12 named patterns; selecting one arms the cursor with that pattern stamp:
    Glider, LWSS (Lightweight Spaceship), Glider Gun (Gosper's), R-Pentomino,
    Diehard, Acorn, Pulsar, Pentadecathlon, Beacon, Toad, Galaxy (Kok's), Penta-decathlon.
  Each pattern is a hardcoded 2D bool array (literal nested arrays in JS).
- A small THUMBNAIL preview canvas (60x40) next to the dropdown that renders the currently-selected pattern at small scale.

Interaction:
- When a pattern is armed: cursor shows a ghost overlay of the pattern at the hovered cell. Left-click stamps it (OR into the grid). Right-click cancels arming.
- When no pattern is armed: click toggles a single cell. Click-and-drag draws live cells (paints, not toggle).

Run loop: use requestAnimationFrame; accumulate elapsed time and execute step() the right number of times to match the speed slider, so visual playback rate is independent of monitor refresh rate.

No external libraries. Single HTML file. All 12 patterns must work correctly (Glider should glide diagonally; Glider Gun should emit a stream of gliders every 30 generations; Pulsar should oscillate with period 3, etc)."""


SPEC_MANDELBULB = """Build a real-time WebGL2 ray-marched 3D Mandelbulb fractal viewer with progressive power evolution in a single self-contained HTML file. Use a single fullscreen quad and a fragment shader that does distance-estimator ray-marching against the Mandelbulb DE.

Mandelbulb DE (in shader):
  vec3 z = pos; float dr = 1.0; float r = 0.0;
  for (int i=0; i<MAX_ITER; i++) {
    r = length(z);
    if (r > 2.0) break;
    float theta = acos(z.z/r); float phi = atan(z.y, z.x);
    dr = pow(r, n - 1.0) * n * dr + 1.0;
    float zr = pow(r, n);
    theta *= n; phi *= n;
    z = zr * vec3(sin(theta)*cos(phi), sin(phi)*sin(theta), cos(theta));
    z += pos;
  }
  return 0.5 * log(r) * r / dr;

Ray-march parameters: 80 max steps, hit threshold 0.001 * dist-to-camera, max ray distance 12.0. Use the calculated DE to safely step.

Lighting & shading:
- Soft shadows (raymarched, k=8 softness factor).
- Ambient occlusion: 4 samples along the surface normal at small offsets.
- Two configurable lights, each with: position (3 sliders x/y/z, range -3..3), intensity slider (0..3), Kelvin colour temperature slider (2000-10000K — convert to RGB in shader or JS), shadow-softness slider (1-32).
- Specular highlight (Blinn-Phong, hardness slider).
- Orbit-trap glow: track min(length(z)) during the iteration loop, modulate emissive colour.
- Surface colour from a palette gradient sampled by (orbit-trap-min, iterations-survived, angle).

Six palettes selectable via dropdown: Aurora, Magma, Ocean, Emerald, Solar, Violet. Each is a 4-stop HSL gradient hardcoded in the shader (use a small switch/if chain).

Animation (handled in JS, drives uniforms each frame):
- t = elapsed seconds since start.
- Phase 1 (0..20s): n stays at user-set n0 (default 4). MAX_ITER ramps 1 → 8 via smoothstep(0, 20, t)*7+1. "Fractal forms".
- Phase 2 (t > 20s): n morphs in integer steps from n0 → n1 (default 4 → 20, upper bound configurable up to 50). Use smoothstep between consecutive integer powers, taking 2s per step. At t = 20 + step*2, n equals n0 + step.

UI panel (HTML overlay, translucent, scrollable, right side):
- n0 number input (2-50, default 4).
- n1 number input (2-50, default 20).
- Live "morph to n" input + "Morph" button: pressing it interpolates n smoothly to the entered value over 3 seconds via smoothstep, regardless of which phase we're in. (User uses this AFTER reaching n1 in phase 2.)
- Palette dropdown.
- Soft-shadow softness, specular hardness sliders.
- For each of 2 lights: position (3 sliders), intensity, Kelvin (with a tiny coloured swatch showing the resulting RGB), shadow softness.
- "Restart" button — resets t=0.

Camera:
- Mouse drag = orbit yaw/pitch (clamp pitch ±89°).
- Wheel = zoom (clamp 1.5..6.0 distance from origin).

Off-canvas orbit visualization:
- A secondary 2D canvas overlay (200x200, top-left) showing the orbit (escape trajectory) of a probe point: starting at z=pos, plot the 2D projection of z each iteration as a coloured polyline. Updates each frame. This is the "see the math" indicator.

Quality scaling: track FPS; if avg FPS over the last 60 frames drops below 30, halve the render resolution (use a smaller offscreen framebuffer then upscale); if FPS > 55 for 60 frames, raise resolution back. Cap at devicePixelRatio.

Single HTML file. No external libraries (no Three.js). WebGL2 required — if context creation fails, show a friendly fallback message."""


SESSIONS = [
    {
        "name": "Stable Fluids — Mouse Painter",
        "spec": SPEC_FLUIDS,
        "config": "standard",
    },
    {
        "name": "Gray-Scott Reaction-Diffusion (WebGL2)",
        "spec": SPEC_GRAY_SCOTT,
        "config": "standard",
    },
    {
        "name": "Galaxy Collision (Barnes-Hut N-Body)",
        "spec": SPEC_GALAXY,
        "config": "standard",
    },
    {
        "name": "Falling Sand Sandbox",
        "spec": SPEC_FALLING_SAND,
        "config": "standard",
    },
    {
        "name": "Mandelbulb 3D Attractor (WebGL2)",
        "spec": SPEC_MANDELBULB,
        "config": "standard",
    },
    {
        "name": "Game of Life — Pattern Gallery",
        "spec": SPEC_GAME_OF_LIFE,
        "config": "light",
    },
]


def build_payload(s: dict) -> dict:
    if s["config"] == "standard":
        base = STANDARD_BASE
        agents = STANDARD_AGENTS
    else:
        base = LIGHT_BASE
        agents = LIGHT_AGENTS
    return {
        "name": s["name"],
        "specification": s["spec"],
        "agent_configs": agents,
        **base,
    }


async def main():
    base_url = "http://localhost:8000"
    email = TARGET_EMAIL.lower().strip()
    settings = get_settings()

    # 1. Insert a fresh OTP for this email
    async with AsyncSessionLocal() as db:
        db.add(
            OTPCode(
                email=email,
                code_hash=_hash_code(OTP_CODE),
                expires_at=datetime.now(timezone.utc) + timedelta(minutes=settings.otp_expiry_minutes),
            )
        )
        await db.commit()

    created = []
    failed = []
    token = None
    try:
        async with httpx.AsyncClient(base_url=base_url, timeout=60.0) as client:
            # 2. Verify OTP -> JWT
            r = await client.post("/api/auth/verify-otp", json={"email": email, "code": OTP_CODE})
            if r.status_code != 200:
                print(json.dumps({"step": "verify-otp", "status": r.status_code, "body": r.text[:500]}, indent=2))
                return
            token = r.json()["access_token"]
            client.headers["Authorization"] = f"Bearer {token}"

            # 3. Create each session
            for s in SESSIONS:
                payload = build_payload(s)
                r = await client.post("/api/sessions/", json=payload)
                if r.status_code == 201:
                    sid = r.json()["id"]
                    n_agents = len(payload["agent_configs"])
                    created.append({"name": s["name"], "id": sid, "agents": n_agents, "config": s["config"]})
                    print(f"OK  {s['name']!r} -> {sid}  ({n_agents} agents, {s['config']} config)")
                else:
                    failed.append({"name": s["name"], "status": r.status_code, "body": r.text[:1000]})
                    print(f"ERR {s['name']!r} -> HTTP {r.status_code}: {r.text[:300]}")
    finally:
        # Clean up the OTP rows we inserted (also clear any other unused OTPs for this email)
        try:
            async with AsyncSessionLocal() as db:
                await db.execute(delete(OTPCode).where(OTPCode.email == email))
                await db.commit()
        except Exception as e:
            print(f"warn: OTP cleanup failed: {e}")

    print("\n=== SUMMARY ===")
    print(json.dumps({
        "created_count": len(created),
        "failed_count": len(failed),
        "created": created,
        "failed": failed,
    }, indent=2))


asyncio.run(main())
