// Mirrors crates/factory-sim/src/model.rs and engine.rs (camelCase JSON).

export type StationKind = "human" | "agent" | "automation";
export type EdgeKind = "pass" | "rework";

export type Service =
  | { type: "constant"; minutes: number }
  | { type: "triangular"; min: number; mode: number; max: number };

export interface Station {
  id: string;
  name: string;
  kind: StationKind;
  workers: number;
  service: Service;
  costPerTask: number;
  costPerHour: number;
  defectRate: number;
  detectionRate: number;
}

export interface Edge {
  id: string;
  from: string;
  to: string;
  kind: EdgeKind;
}

export interface Scenario {
  modelVersion: number;
  seed: number;
  horizonMinutes: number;
  arrivalIntervalMinutes: number;
  wipLimit: number | null;
  maxRework: number;
  entry: string;
  stations: Station[];
  edges: Edge[];
}

export interface Position {
  x: number;
  y: number;
}

/** What gets saved, shared, and imported. The engine only sees `scenario`. */
export interface FactoryDocument {
  format: "factorysim/1";
  name: string;
  scenario: Scenario;
  layout: Record<string, Position>;
}

export interface ValidationError {
  target: string | null;
  message: string;
}

export interface Totals {
  arrived: number;
  shipped: number;
  backlog: number;
  wip: number;
  defectsIntroduced: number;
  defectsCaught: number;
  defectsEscaped: number;
  reworkCapHits: number;
  reworks: number;
  cost: number;
  costPerShipped: number | null;
  leadTimeP50Minutes: number | null;
  leadTimeP95Minutes: number | null;
  throughputPerDay: number;
}

export interface StationSnapshot {
  id: string;
  queue: number;
  busy: number;
  workers: number;
  started: number;
  completed: number;
  caught: number;
  utilization: number;
  avgWaitMinutes: number | null;
  cost: number;
}

export interface EdgeSnapshot {
  id: string;
  moved: number;
}

export interface Snapshot {
  modelVersion: number;
  timeMinutes: number;
  horizonMinutes: number;
  finished: boolean;
  events: number;
  totals: Totals;
  stations: StationSnapshot[];
  edges: EdgeSnapshot[];
}

export interface Series {
  timeMinutes: number[];
  wip: number[];
  backlog: number[];
  shipped: number[];
  cost: number[];
  queues: number[][];
}
