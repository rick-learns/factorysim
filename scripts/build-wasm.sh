#!/usr/bin/env bash
# Build the engine to wasm and generate JS bindings into web/src/wasm.
set -euo pipefail
cd "$(dirname "$0")/.."
cargo build -p factory-wasm --release --target wasm32-unknown-unknown
wasm-bindgen --target web --out-dir web/src/wasm \
  target/wasm32-unknown-unknown/release/factory_wasm.wasm
