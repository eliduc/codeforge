// Generates demo timeline JSON files for the Demo Templates feature.
// Run: node frontend/scripts/gen-demo-timelines.mjs
//
// Reads the hand-authored final_code HTML files from
// frontend/public/demo-templates/_*_final.html and writes
// {mandelbulb,snake,particles,crystal}.json into the same directory.
//
// Each timeline is hand-paced (90s) with 2 coders + 2 testers + 1 summarizer +
// 1 finalizer, 1 iteration. partial_content snippets are slices of the actual
// final_code, distributed across streaming events with light interleaving.

import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PUB = join(__dirname, '..', 'public', 'demo-templates')

// ── Manifest of templates ──────────────────────────────────────────────────
const TEMPLATES = [
  {
    id: 'mandelbulb',
    name: 'Mandelbulb 3D Attractor',
    description:
      'A WebGL2 ray-marched Mandelbulb strange-attractor that grows through ' +
      'phases as the fractal power n increases. The Anthropic team\'s favourite first run.',
    language: 'javascript_browser',
    file: '_mandelbulb_final.html',
    thumbnail: '🌐',
    coders: [{ model: 'claude-opus-4.5' }, { model: 'gpt-5.1-codex' }],
    testers: [{ model: 'claude-sonnet-4.5' }, { model: 'gemini-2.5-pro' }],
    summarizer: 'claude-opus-4.5',
    finalizer: 'claude-opus-4.5',
    spec: [
      'Build a WebGL2 visualisation of the Mandelbulb strange attractor: ',
      'r,θ,ϕ → r^n(θn,ϕn). Show the attractor growing dynamically from t=0 ',
      "through ~20s, sweeping the fractal power n from 4 → 20, with full ",
      'phase-formation visible. Use sphere-tracing with normal-based lighting ',
      "for high-relief shading. Provide up to 8 colour palettes and adjustable ",
      'light position / softness / temperature. Add a restart control that ',
      'lets the user pick start and end n.',
    ].join(''),
  },
  {
    id: 'snake',
    name: 'Neon Snake',
    description:
      'Classic Snake with glowing trails, particle bursts, and a smooth neon ' +
      'gradient body. Plays right in the preview frame.',
    language: 'javascript_browser',
    file: '_snake_final.html',
    thumbnail: '🐍',
    coders: [{ model: 'claude-sonnet-4.5' }, { model: 'gpt-5.1' }],
    testers: [{ model: 'gemini-2.5-flash' }, { model: 'grok-4-fast' }],
    summarizer: 'claude-sonnet-4.5',
    finalizer: 'claude-sonnet-4.5',
    spec: [
      'Build a polished Snake game in a single HTML file using <canvas>. ',
      'Requirements: 22×22 grid, smooth movement, food pellets with a glowing ',
      'pulse, particle burst when food is eaten, gradient-coloured snake body ',
      'with visible eyes that track the direction of motion, neon background, ',
      'score HUD, game-over overlay with restart, arrow keys + WASD support, ',
      'wrap-around walls. Self-contained, no external dependencies.',
    ].join(''),
  },
  {
    id: 'particles',
    name: 'Flow-Field Particles',
    description:
      'Generative-art particle system driven by a 2D curl-noise flow field. ' +
      '5 palettes, real-time controls, interactive pointer disturbance.',
    language: 'javascript_browser',
    file: '_particles_final.html',
    thumbnail: '✨',
    coders: [{ model: 'claude-opus-4.5' }, { model: 'gemini-2.5-pro' }],
    testers: [{ model: 'claude-sonnet-4.5' }, { model: 'gpt-5.1' }],
    summarizer: 'gpt-5.1',
    finalizer: 'claude-opus-4.5',
    spec: [
      'Build a generative particle flow-field in a single HTML page. Each ',
      'particle\'s velocity is sampled from a 2D noise field (curl-noise look). ',
      'Trails fade slowly so particles paint a flow image. Provide live ',
      'controls for particle count, speed, noise scale, fade rate, and a ',
      "palette picker (5 palettes: Aurora, Sunset, Magma, Ocean, Mono). ",
      'Pointer drag should disturb particles. No external libraries.',
    ].join(''),
  },
  {
    id: 'crystal',
    name: 'WebGL Glass Crystal',
    description:
      'Real-time ray-marched glass crystal with chromatic dispersion, ' +
      'procedural environment, Fresnel mixing, and live controls.',
    language: 'javascript_browser',
    file: '_crystal_final.html',
    thumbnail: '💎',
    coders: [{ model: 'claude-opus-4.5' }, { model: 'gpt-5.1-codex' }],
    testers: [{ model: 'claude-sonnet-4.5' }, { model: 'grok-4' }],
    summarizer: 'claude-opus-4.5',
    finalizer: 'claude-opus-4.5',
    spec: [
      'Build a real-time WebGL ray-marched glass crystal. SDF: smooth-min of ',
      'two octahedra plus a 3D sin-ridge displacement for facets. Shading: ',
      'Fresnel-weighted mix of refraction + reflection against a procedural ',
      'sky-and-ground environment, chromatic dispersion (offset IOR per ',
      'channel), tinted internal pass, specular highlight, rim glow, vignette. ',
      'Controls: refraction (IOR), ridge sharpness, spin speed, hue. ',
      'Mouse drag rotates the camera, wheel zooms. No external libraries.',
    ].join(''),
  },
]

// ── Timeline shape ─────────────────────────────────────────────────────────
// 90s budget. Events:
//
//   t=0      workflow_started, iteration_started
//   t=1      phase_started=coding, agent_started ×2 coders
//   t=2..40  ~30 agent_streaming events (15 per coder, interleaved)
//   t=42     agent_completed ×2 coders
//   t=43     phase_started=testing, agent_started ×4 testers (2 testers × 2 coders)
//   t=45..60 agent_streaming for testers (small)
//   t=62     agent_completed ×4 testers
//   t=63     phase_started=summarization, agent_started summarizer
//   t=64..72 streaming
//   t=74     agent_completed summarizer
//   t=75     phase_started=finalization, agent_started finalizer
//   t=76..86 streaming
//   t=88     agent_completed finalizer
//   t=89     iteration_completed
//   t=90     workflow_completed

function buildTimeline(tpl) {
  const finalCode = readFileSync(join(PUB, tpl.file), 'utf8')
  const events = []
  // helpers
  const tCoders = tpl.coders.length // 2
  const tTesters = tpl.testers.length // 2
  // Slice final_code into 30 pieces of roughly equal size, then distribute
  // alternately across the two coders. Each coder gets an *accumulating*
  // stream of about half the code; once concatenated it should look like a
  // realistic mid-generation buffer.
  const N_CHUNKS = 30
  const totalLen = finalCode.length
  const chunkSize = Math.max(1, Math.ceil(totalLen / N_CHUNKS))
  const chunks = []
  for (let i = 0; i < N_CHUNKS; i++) {
    chunks.push(finalCode.slice(i * chunkSize, (i + 1) * chunkSize))
  }
  // ── t = 0 ──
  events.push({ t: 0, type: 'workflow_started' })
  events.push({ t: 0.2, type: 'iteration_started', iteration: 1 })
  // ── coders ──
  events.push({ t: 1, type: 'phase_started', phase: 'coding', iteration: 1 })
  for (let i = 0; i < tCoders; i++) {
    events.push({ t: 1.2 + i * 0.15, type: 'agent_started', agent_type: 'coder', agent_index: i, iteration: 1 })
  }
  // Distribute 30 chunks across 2 coders — coder 0 gets evens, coder 1 odds.
  // Spread streaming from t=2.5 → t=40 with slight per-coder jitter so the
  // appearance is "interleaved, not robotic".
  const STREAM_START = 2.5
  const STREAM_END = 40
  const span = STREAM_END - STREAM_START
  const perCoderChunks = [
    chunks.filter((_, i) => i % 2 === 0),
    chunks.filter((_, i) => i % 2 === 1),
  ]
  const accumulated = ['', '']
  for (let c = 0; c < tCoders; c++) {
    const arr = perCoderChunks[c]
    for (let k = 0; k < arr.length; k++) {
      accumulated[c] += arr[k]
      // distribute roughly evenly with small jitter (deterministic based on k+c)
      const frac = (k + (c * 0.5)) / arr.length
      const jitter = (((k * 7 + c * 13) % 11) - 5) * 0.18 // ±~0.9s
      const t = STREAM_START + span * frac + jitter
      events.push({
        t: Math.round(t * 10) / 10,
        type: 'agent_streaming',
        agent_type: 'coder',
        agent_index: c,
        partial_content: accumulated[c],
      })
    }
  }
  // ── coders complete ──
  for (let i = 0; i < tCoders; i++) {
    events.push({
      t: 42 + i * 0.3,
      type: 'agent_completed',
      agent_type: 'coder',
      agent_index: i,
      tokens: 1800 + i * 250,
      cost: 0.024 + i * 0.006,
      iteration: 1,
    })
  }
  // ── testers ──
  // Each tester audits each coder's code → 2 × 2 = 4 tester audits.
  events.push({ t: 43, type: 'phase_started', phase: 'testing', iteration: 1 })
  let testerStartT = 43.5
  for (let ti = 0; ti < tTesters; ti++) {
    for (let ci = 0; ci < tCoders; ci++) {
      const audit_idx = ti * tCoders + ci
      events.push({
        t: testerStartT + audit_idx * 0.2,
        type: 'agent_started',
        agent_type: 'tester',
        agent_index: ti,
        iteration: 1,
      })
    }
  }
  // tester streaming (just a few short bursts each)
  const testerStream = [
    'Reviewing specification compliance...',
    'Code structure: clean. Single file, no external deps ✓',
    'Visual quality: matches spec — smooth animation, no artefacts ✓',
    'Potential issue: edge case when window is resized. Minor.',
    'Found 1 minor issue, 0 critical. Audit complete.',
  ]
  for (let ti = 0; ti < tTesters; ti++) {
    let acc = ''
    for (let k = 0; k < testerStream.length; k++) {
      acc += (acc ? '\n' : '') + testerStream[k]
      const t = 45 + (ti * 0.5) + k * 3 + ((ti * 7 + k * 3) % 5) * 0.18
      events.push({
        t: Math.round(t * 10) / 10,
        type: 'agent_streaming',
        agent_type: 'tester',
        agent_index: ti,
        partial_content: acc,
      })
    }
  }
  // tester complete
  for (let ti = 0; ti < tTesters; ti++) {
    events.push({
      t: 62 + ti * 0.3,
      type: 'agent_completed',
      agent_type: 'tester',
      agent_index: ti,
      tokens: 900 + ti * 120,
      cost: 0.011 + ti * 0.003,
      issuesFound: 1,
      iteration: 1,
    })
  }
  // ── summarizer ──
  events.push({ t: 63, type: 'phase_started', phase: 'summarization', iteration: 1 })
  events.push({ t: 63.5, type: 'agent_started', agent_type: 'summarizer', agent_index: 0, iteration: 1 })
  const sumStream = [
    'Aggregating tester audits...',
    'Both coder outputs satisfy the spec. Coder 0\'s output has slightly cleaner structure.',
    'No critical issues. 2 minor issues across the 4 audits (cosmetic, edge-case).',
    'Recommendation: promote Coder 0\'s output as the canonical artefact.',
    'Summary complete — passing to Finalizer.',
  ]
  {
    let acc = ''
    for (let k = 0; k < sumStream.length; k++) {
      acc += (acc ? '\n' : '') + sumStream[k]
      events.push({
        t: 64.5 + k * 1.8,
        type: 'agent_streaming',
        agent_type: 'summarizer',
        agent_index: 0,
        partial_content: acc,
      })
    }
  }
  events.push({
    t: 74,
    type: 'agent_completed',
    agent_type: 'summarizer',
    agent_index: 0,
    tokens: 620,
    cost: 0.009,
    iteration: 1,
  })
  // ── finalizer ──
  events.push({ t: 75, type: 'phase_started', phase: 'finalization', iteration: 1 })
  events.push({ t: 75.5, type: 'agent_started', agent_type: 'finalizer', agent_index: 0, iteration: 1 })
  // finalizer streams the actual final code (last ~3000 chars chunked)
  const finalTail = finalCode.slice(-Math.min(3000, finalCode.length))
  const finChunks = []
  const finN = 8
  const finChunkSize = Math.ceil(finalTail.length / finN)
  for (let i = 0; i < finN; i++) finChunks.push(finalTail.slice(i * finChunkSize, (i + 1) * finChunkSize))
  let finAcc = ''
  for (let k = 0; k < finN; k++) {
    finAcc += finChunks[k]
    events.push({
      t: 76.5 + k * 1.4,
      type: 'agent_streaming',
      agent_type: 'finalizer',
      agent_index: 0,
      partial_content: finAcc,
    })
  }
  events.push({
    t: 88,
    type: 'agent_completed',
    agent_type: 'finalizer',
    agent_index: 0,
    tokens: 1100,
    cost: 0.015,
    iteration: 1,
  })
  events.push({ t: 89, type: 'iteration_completed', iteration: 1 })
  events.push({ t: 90, type: 'workflow_completed' })

  // Sort by t (slight jitter may push some out of order)
  events.sort((a, b) => a.t - b.t)

  return {
    id: tpl.id,
    name: tpl.name,
    description: tpl.description,
    language: tpl.language,
    spec: tpl.spec,
    duration_seconds: 90,
    coders: tpl.coders,
    testers: tpl.testers,
    summarizer: { model: tpl.summarizer },
    finalizer: { model: tpl.finalizer },
    events,
    final_code: finalCode,
    thumbnail: tpl.thumbnail,
  }
}

const index = []
for (const tpl of TEMPLATES) {
  const tl = buildTimeline(tpl)
  const out = join(PUB, `${tpl.id}.json`)
  writeFileSync(out, JSON.stringify(tl))
  console.log(`wrote ${out} (${tl.events.length} events, ${Math.round(JSON.stringify(tl).length / 1024)} KB)`)
  index.push({
    id: tl.id,
    name: tl.name,
    description: tl.description,
    language: tl.language,
    thumbnail: tl.thumbnail,
    duration_seconds: tl.duration_seconds,
  })
}
writeFileSync(join(PUB, 'index.json'), JSON.stringify(index, null, 2))
console.log(`wrote index.json with ${index.length} entries`)
