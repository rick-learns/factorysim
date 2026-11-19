import init, { Simulation, validate as wasmValidate } from "./wasm/factory_wasm.js";
import type { Scenario, Series, Snapshot, ValidationError } from "./types";

let ready: Promise<unknown> | null = null;

export function loadEngine(): Promise<unknown> {
  ready ??= init();
  return ready;
}

export function validate(scenario: Scenario): ValidationError[] {
  return wasmValidate(JSON.stringify(scenario)) as ValidationError[];
}

/** Thin typed wrapper; one instance per run. Call `free()` when replacing it. */
export class Run {
  private sim: Simulation;

  constructor(scenario: Scenario) {
    this.sim = new Simulation(JSON.stringify(scenario));
  }

  advanceTo(minutes: number, maxEvents: number): number {
    return this.sim.advance_to(minutes, maxEvents);
  }

  runToEnd(): void {
    this.sim.run_to_end();
  }

  get finished(): boolean {
    return this.sim.finished();
  }

  snapshot(): Snapshot {
    return this.sim.snapshot() as Snapshot;
  }

  series(): Series {
    return this.sim.series() as Series;
  }

  free(): void {
    this.sim.free();
  }
}
