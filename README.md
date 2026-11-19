# factorysim

Build a software factory visually — spec writers, coding agents, reviewers, CI — and watch how it behaves. Press Run and see work flow, queues build up, and bottlenecks light up. Then change one thing (add a reviewer, cut the defect rate, set a WIP limit) and compare against a pinned baseline.

No LLMs at runtime. It is a seeded discrete-event simulation in plain Rust, compiled to WebAssembly and run entirely in the browser.

## Run it

Needs Rust with the `wasm32-unknown-unknown` target, `wasm-bindgen-cli` **0.2.129** (must match the pinned crate), and Node 24.

```sh
cd web
npm install
npm run dev      # builds the wasm engine, then starts Vite
npm run build    # static site in web/dist, deployable to any static host
```

## Tests

```sh
cargo test --workspace   # engine behaviour, validation, golden snapshot
cd web && npm test       # same golden snapshot through the wasm build
```

The bundled template (`fixtures/agentic-factory.json`) must produce exactly `fixtures/agentic-factory.expected.json` both natively and in wasm. If you change engine behaviour on purpose, regenerate it with `UPDATE_GOLDEN=1 cargo test -p factory-sim --test golden` and bump `MODEL_VERSION`.

## The model

- **Stations** have workers, a time per attempt (constant, or triangular min / likely / max), a cost per attempt and per busy hour, a chance to **introduce** a hidden defect, and a chance to **catch** one.
- **Routes**: each station has at most one *pass* route (no pass route means the work ships) and at most one *rework* route, where caught defects go to be fixed. Rework cycles are fine; loops made only of pass routes are rejected.
- **Arrivals** come at a fixed interval. An optional factory-wide **WIP limit** holds extra work in a backlog.
- Defects are tracked separately from detection: a shipped item that still carries a hidden defect counts as an **escape**. After `maxRework` trips back, caught work ships anyway, and the app reports it.
- **Metrics**: shipped, throughput, lead time p50/p95 (from arrival, including backlog), WIP, cost per shipped item including rework, escape rate, and per-station utilization, queue, and average wait. The bottleneck is the station at ≥85% utilization with the longest average wait.

Results are scenario estimates from one seeded run, not forecasts.

## Determinism

- Time is whole seconds; events are ordered by `(time, sequence)`.
- Each station draws from its own PCG stream, seeded from the scenario seed and the station id, so editing one station does not reshuffle another station's random draws. That keeps before/after comparisons fair.
- Triangular sampling uses only `+ - * /` and `sqrt`, which IEEE 754 rounds identically on native and wasm.
- How the UI slices playback (speed, frame rate, pausing) never changes the outcome; a test checks this.

## Why Rust for the engine and TypeScript for the UI

The engine is the part that has to be right: Rust gives a headless, natively testable core that can later back a CLI or batch parameter sweeps. For the editor, React Flow provides mature DOM-based nodes, connections, keyboard focus, and pan/zoom. The pure-Rust UI options (egui on a canvas, or Leptos/Dioxus/Yew with a hand-built graph editor) are weaker at text input and accessibility, or would mean building the editor from scratch.

## Layout

```
crates/factory-sim    engine: model, validation, discrete-event simulation
crates/factory-wasm   wasm-bindgen adapter (JSON in, JS objects out)
fixtures/             bundled template + golden snapshot
web/                  React + React Flow editor, metrics, charts
```

Saved and shared files use the `factorysim/1` format: `{ format, name, scenario, layout }`. Share links put the deflated document in the URL fragment, so it never reaches a server.

## Not yet

Multi-seed runs with confidence ranges, arrival variability, priorities and work types, shift calendars, per-edge buffers and blocking, and running the engine in a Web Worker for very large models.
