import agentic from "../../fixtures/agentic-factory.json";
import type { Edge, FactoryDocument, Position, Scenario, Service, Station, StationKind } from "./types";

export const TEMPLATE = agentic as FactoryDocument;

/** Share links longer than this fall back to JSON export. */
export const MAX_SHARE_URL = 8000;

export function cloneDocument(doc: FactoryDocument): FactoryDocument {
  return structuredClone(doc);
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const isNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isString = (v: unknown): v is string => typeof v === "string";
const KINDS: readonly unknown[] = ["human", "agent", "automation"];

class InvalidDocument extends Error {}

function fail(): never {
  throw new InvalidDocument();
}

/** A finite number, or `fallback` when omitted (mirrors the engine's serde defaults). */
function num(v: unknown, fallback?: number): number {
  if (v === undefined && fallback !== undefined) return fallback;
  return isNumber(v) ? v : fail();
}

function str(v: unknown): string {
  return isString(v) ? v : fail();
}

function service(v: unknown): Service {
  if (!isObject(v)) fail();
  if (v.type === "constant") return { type: "constant", minutes: num(v.minutes) };
  if (v.type === "triangular") return { type: "triangular", min: num(v.min), mode: num(v.mode), max: num(v.max) };
  return fail();
}

function station(v: unknown): Station {
  if (!isObject(v)) fail();
  if (v.kind !== undefined && !KINDS.includes(v.kind)) fail();
  return {
    id: str(v.id),
    name: str(v.name),
    kind: (v.kind as StationKind | undefined) ?? "human",
    workers: num(v.workers),
    service: service(v.service),
    costPerTask: num(v.costPerTask, 0),
    costPerHour: num(v.costPerHour, 0),
    defectRate: num(v.defectRate, 0),
    detectionRate: num(v.detectionRate, 0),
  };
}

function edge(v: unknown): Edge {
  if (!isObject(v) || (v.kind !== "pass" && v.kind !== "rework")) fail();
  return { id: str(v.id), from: str(v.from), to: str(v.to), kind: v.kind };
}

function scenario(v: unknown): Scenario {
  if (!isObject(v) || !Array.isArray(v.stations) || !Array.isArray(v.edges)) fail();
  if (v.wipLimit !== undefined && v.wipLimit !== null && !isNumber(v.wipLimit)) fail();
  return {
    modelVersion: num(v.modelVersion, 1),
    seed: num(v.seed),
    horizonMinutes: num(v.horizonMinutes),
    arrivalIntervalMinutes: num(v.arrivalIntervalMinutes),
    wipLimit: (v.wipLimit as number | null | undefined) ?? null,
    maxRework: num(v.maxRework),
    entry: str(v.entry),
    stations: v.stations.map(station),
    edges: v.edges.map(edge),
  };
}

function layout(v: unknown): Record<string, Position> {
  if (v === undefined) return {};
  if (!isObject(v)) fail();
  return Object.fromEntries(
    Object.entries(v).map(([id, p]) => [id, isObject(p) ? { x: num(p.x), y: num(p.y) } : fail()]),
  );
}

/**
 * Type-check every field the editor renders, filling in the engine's defaults
 * for omitted optional fields. The engine validates values and structure.
 */
export function parseDocument(text: string): FactoryDocument {
  const doc: unknown = JSON.parse(text);
  try {
    if (!isObject(doc) || doc.format !== "factorysim/1") fail();
    return {
      format: "factorysim/1",
      name: isString(doc.name) ? doc.name : "Imported factory",
      scenario: scenario(doc.scenario),
      layout: layout(doc.layout),
    };
  } catch (e) {
    if (e instanceof InvalidDocument) throw new Error("Not a valid factorysim file (format \"factorysim/1\").");
    throw e;
  }
}

export function serializeDocument(doc: FactoryDocument): string {
  return JSON.stringify(doc, null, 2);
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

async function pipe(bytes: Uint8Array<ArrayBuffer>, stream: CompressionStream | DecompressionStream) {
  const out = new Blob([bytes]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(out).arrayBuffer());
}

export async function encodeShareHash(doc: FactoryDocument): Promise<string> {
  const json = new TextEncoder().encode(JSON.stringify(doc));
  return "#s=" + toBase64Url(await pipe(json, new CompressionStream("deflate-raw")));
}

export async function decodeShareHash(hash: string): Promise<FactoryDocument | null> {
  const match = /^#s=([A-Za-z0-9_-]+)$/.exec(hash);
  if (!match) return null;
  const bytes = await pipe(fromBase64Url(match[1]), new DecompressionStream("deflate-raw"));
  return parseDocument(new TextDecoder().decode(bytes));
}

export function uniqueId(base: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  const slug = base.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "station";
  if (!used.has(slug)) return slug;
  for (let i = 2; ; i++) {
    if (!used.has(`${slug}-${i}`)) return `${slug}-${i}`;
  }
}

const DEFAULTS: Record<StationKind, Omit<Station, "id" | "name" | "kind">> = {
  human: {
    workers: 1,
    service: { type: "triangular", min: 10, mode: 20, max: 45 },
    costPerTask: 0,
    costPerHour: 90,
    defectRate: 0.1,
    detectionRate: 0,
  },
  agent: {
    workers: 2,
    service: { type: "triangular", min: 5, mode: 15, max: 40 },
    costPerTask: 2,
    costPerHour: 0,
    defectRate: 0.25,
    detectionRate: 0,
  },
  automation: {
    workers: 4,
    service: { type: "constant", minutes: 8 },
    costPerTask: 0.3,
    costPerHour: 0,
    defectRate: 0,
    detectionRate: 0,
  },
};

export const KIND_LABEL: Record<StationKind, string> = {
  human: "Human",
  agent: "Agent",
  automation: "Automation",
};

export function newStation(kind: StationKind, taken: Iterable<string>): Station {
  const name = `New ${KIND_LABEL[kind].toLowerCase()}`;
  return { id: uniqueId(name, taken), name, kind, ...structuredClone(DEFAULTS[kind]) };
}
