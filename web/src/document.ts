import agentic from "../../fixtures/agentic-factory.json";
import type { FactoryDocument, Station, StationKind } from "./types";

export const TEMPLATE = agentic as FactoryDocument;

/** Share links longer than this fall back to JSON export. */
export const MAX_SHARE_URL = 8000;

export function cloneDocument(doc: FactoryDocument): FactoryDocument {
  return structuredClone(doc);
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

/** Shape check for what the editor needs to render; the engine validates the rest. */
export function parseDocument(text: string): FactoryDocument {
  const doc = JSON.parse(text) as Partial<FactoryDocument>;
  const s = doc.scenario;
  const ok =
    doc.format === "factorysim/1" &&
    isObject(s) &&
    Array.isArray(s.stations) &&
    Array.isArray(s.edges) &&
    s.stations.every((st) => isObject(st) && typeof st.id === "string" && isObject(st.service)) &&
    s.edges.every((e) => isObject(e) && typeof e.id === "string" && typeof e.from === "string" && typeof e.to === "string");
  if (!ok) {
    throw new Error("Not a valid factorysim file (format \"factorysim/1\").");
  }
  return {
    format: "factorysim/1",
    name: typeof doc.name === "string" ? doc.name : "Imported factory",
    scenario: s,
    layout: isObject(doc.layout) ? doc.layout : {},
  };
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
