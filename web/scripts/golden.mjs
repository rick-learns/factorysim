// Runs the wasm build on the bundled template and checks it against the same
// golden snapshot as the native Rust test, so both targets agree exactly.
import { readFileSync } from "node:fs";
import { deepStrictEqual } from "node:assert/strict";
import { initSync, Simulation, validate } from "../src/wasm/factory_wasm.js";

const root = new URL("../../", import.meta.url);
initSync({ module: readFileSync(new URL("web/src/wasm/factory_wasm_bg.wasm", root)) });

const doc = JSON.parse(readFileSync(new URL("fixtures/agentic-factory.json", root), "utf8"));
const expected = JSON.parse(readFileSync(new URL("fixtures/agentic-factory.expected.json", root), "utf8"));

deepStrictEqual(validate(JSON.stringify(doc.scenario)), []);
const sim = new Simulation(JSON.stringify(doc.scenario));
// Advance in uneven slices, like the browser does frame by frame.
for (let t = 0; !sim.finished(); t += 13.7) sim.advance_to(t, 50);
deepStrictEqual(sim.snapshot(), expected);

const broken = { ...doc.scenario, entry: "nope" };
deepStrictEqual(validate(JSON.stringify(broken)).length, 1);
console.log("wasm golden snapshot matches native");
