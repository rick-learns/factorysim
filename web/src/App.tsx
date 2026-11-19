import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  Controls,
  MarkerType,
  ReactFlow,
  useEdgesState,
  useNodesState,
  type Connection,
  type Edge as FlowEdgeModel,
  type Node,
  type OnSelectionChangeParams,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import "./styles.css";

import { FlowEdge, LiveContext, StationNode, type FlowEdgeData, type Live } from "./canvas";
import {
  MAX_SHARE_URL,
  TEMPLATE,
  cloneDocument,
  decodeShareHash,
  encodeShareHash,
  newStation,
  parseDocument,
  serializeDocument,
} from "./document";
import { Run, loadEngine, validate } from "./engine";
import { Inspector, setRoute } from "./Inspector";
import { Metrics } from "./Metrics";
import type { FactoryDocument, Scenario, Series, Snapshot, StationKind, Totals, ValidationError } from "./types";

const STORAGE_KEY = "factorysim:document";
const SPEEDS: [number, string][] = [
  [15, "15 min/s"],
  [60, "1 h/s"],
  [240, "4 h/s"],
  [960, "16 h/s"],
];
const nodeTypes = { station: StationNode };
const edgeTypes = { flow: FlowEdge };

function toNodes(doc: FactoryDocument, previous: Node[] = []): Node[] {
  return doc.scenario.stations.map((st, i) => {
    const prev = previous.find((n) => n.id === st.id);
    if (prev) return prev;
    return { id: st.id, type: "station", position: doc.layout[st.id] ?? { x: i * 280, y: 120 }, data: {} };
  });
}

function toEdges(edges: Scenario["edges"], previous: FlowEdgeModel[] = []): FlowEdgeModel[] {
  return edges.map((e) => ({
    id: e.id,
    source: e.from,
    target: e.to,
    sourceHandle: e.kind === "rework" ? "rework" : "pass",
    targetHandle: e.kind === "rework" ? "rework-in" : "in",
    type: "flow",
    data: { kind: e.kind } satisfies FlowEdgeData,
    markerEnd: { type: MarkerType.ArrowClosed, color: e.kind === "rework" ? "#ef4444" : "#64748b" },
    selected: previous.find((p) => p.id === e.id)?.selected ?? false,
  }));
}

function initialDocument(): FactoryDocument {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) return parseDocument(saved);
  } catch {
    // Ignore unreadable saved state and start from the template.
  }
  return cloneDocument(TEMPLATE);
}

function findBottleneck(snap: Snapshot | null): string | null {
  if (!snap) return null;
  let best: string | null = null;
  let worstWait = 1;
  for (const s of snap.stations) {
    if (s.utilization >= 0.85 && (s.avgWaitMinutes ?? 0) > worstWait) {
      best = s.id;
      worstWait = s.avgWaitMinutes ?? 0;
    }
  }
  return best;
}

export function App() {
  const [doc, setDoc] = useState<FactoryDocument>(initialDocument);
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>(toNodes(doc));
  const [edges, setEdges, onEdgesChange] = useEdgesState<FlowEdgeModel>(toEdges(doc.scenario.edges));
  const [selection, setSelection] = useState<{ kind: "station" | "edge"; id: string } | null>(null);
  const [engineReady, setEngineReady] = useState(false);
  const [errors, setErrors] = useState<ValidationError[]>([]);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [series, setSeries] = useState<Series | null>(null);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(240);
  const [baseline, setBaseline] = useState<{ totals: Totals; label: string } | null>(null);
  const [activeEdges, setActiveEdges] = useState<Set<string>>(new Set());
  const [toast, setToast] = useState<string | null>(null);

  const runRef = useRef<Run | null>(null);
  const simTime = useRef(0);
  const lastMoved = useRef(new Map<string, { moved: number; at: number }>());
  const fileInput = useRef<HTMLInputElement>(null);

  const scenario = doc.scenario;
  // Positions live in React Flow's nodes; fold them in for saving and sharing.
  const savedDoc = useMemo<FactoryDocument>(
    () => ({ ...doc, layout: Object.fromEntries(nodes.map((n) => [n.id, n.position])) }),
    [doc, nodes],
  );
  const scenarioJson = useMemo(() => JSON.stringify(scenario), [scenario]);

  const update = useCallback((fn: (s: Scenario) => Scenario) => {
    setDoc((d) => ({ ...d, scenario: fn(d.scenario) }));
  }, []);

  const loadDocument = useCallback(
    (next: FactoryDocument) => {
      // Derive everything first so a bad document throws before any state changes.
      const nextNodes = toNodes(next);
      const nextEdges = toEdges(next.scenario.edges);
      setDoc(next);
      setNodes(nextNodes);
      setEdges(nextEdges);
      setSelection(null);
      setBaseline(null);
    },
    [setNodes, setEdges],
  );

  useEffect(() => {
    loadEngine().then(() => setEngineReady(true));
    if (location.hash.startsWith("#s=")) {
      const hash = location.hash;
      // Drop the fragment once read, so a reload shows later edits, not the original link.
      history.replaceState(null, "", location.pathname + location.search);
      decodeShareHash(hash)
        .then((shared) => shared && loadDocument(shared))
        .catch(() => setToast("That share link could not be read."));
    }
  }, [loadDocument]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(savedDoc));
  }, [savedDoc]);

  // Keep React Flow's nodes and edges in step with the scenario.
  useEffect(() => {
    setNodes((prev) => toNodes(doc, prev));
  }, [scenario.stations.map((s) => s.id).join("\n")]);
  useEffect(() => {
    setEdges((prev) => toEdges(scenario.edges, prev));
  }, [scenario.edges, setEdges]);

  const publish = useCallback((run: Run, withSeries: boolean) => {
    const snap = run.snapshot();
    setSnapshot(snap);
    if (withSeries) setSeries(run.series());
    const now = performance.now();
    const active = new Set<string>();
    for (const e of snap.edges) {
      const prev = lastMoved.current.get(e.id);
      if (!prev || prev.moved !== e.moved) lastMoved.current.set(e.id, { moved: e.moved, at: now });
      const at = lastMoved.current.get(e.id)!.at;
      if (e.moved > 0 && now - at < 1200) active.add(e.id);
    }
    setActiveEdges(active);
  }, []);

  // Any model change restarts the run from time zero.
  const reset = useCallback(() => {
    runRef.current?.free();
    runRef.current = null;
    simTime.current = 0;
    lastMoved.current.clear();
    setActiveEdges(new Set());
    const s = JSON.parse(scenarioJson) as Scenario;
    const problems = validate(s);
    setErrors(problems);
    if (problems.length > 0) {
      setSnapshot(null);
      setSeries(null);
      setPlaying(false);
      return;
    }
    const run = new Run(s);
    runRef.current = run;
    run.advanceTo(0, 1_000_000);
    publish(run, true);
  }, [scenarioJson, publish]);

  useEffect(() => {
    if (engineReady) reset();
  }, [engineReady, reset]);

  useEffect(() => {
    if (!playing) return;
    let frame = 0;
    let last = performance.now();
    let lastSeries = 0;
    const tick = (now: number) => {
      const run = runRef.current;
      if (!run) return;
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      simTime.current += dt * speed;
      run.advanceTo(simTime.current, 200_000);
      const withSeries = now - lastSeries > 250 || run.finished;
      if (withSeries) lastSeries = now;
      publish(run, withSeries);
      if (run.finished) {
        setPlaying(false);
        return;
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing, speed, publish]);

  const runToEnd = () => {
    const run = runRef.current;
    if (!run) return;
    run.runToEnd();
    simTime.current = run.snapshot().timeMinutes;
    setPlaying(false);
    publish(run, true);
  };

  const togglePlay = () => {
    if (!runRef.current) return;
    if (runRef.current.finished) reset();
    setPlaying((p) => !p);
  };

  const addStation = (kind: StationKind) => {
    const station = newStation(kind, scenario.stations.map((s) => s.id));
    const maxX = Math.max(0, ...nodes.map((n) => n.position.x));
    // Select it on the canvas too, so Delete acts on what the inspector shows.
    setNodes((prev) => [
      ...prev.map((n) => ({ ...n, selected: false })),
      { id: station.id, type: "station", position: { x: maxX + 280, y: 320 }, data: {}, selected: true },
    ]);
    setEdges((prev) => prev.map((e) => ({ ...e, selected: false })));
    update((s) => ({ ...s, stations: [...s.stations, station] }));
    setSelection({ kind: "station", id: station.id });
  };

  const deleteStations = useCallback(
    (ids: string[]) => {
      const gone = new Set(ids);
      update((s) => {
        const stations = s.stations.filter((st) => !gone.has(st.id));
        return {
          ...s,
          stations,
          edges: s.edges.filter((e) => !gone.has(e.from) && !gone.has(e.to)),
          entry: gone.has(s.entry) ? (stations[0]?.id ?? "") : s.entry,
        };
      });
      setSelection(null);
    },
    [update],
  );

  const deleteEdges = useCallback(
    (ids: string[]) => {
      const gone = new Set(ids);
      update((s) => ({ ...s, edges: s.edges.filter((e) => !gone.has(e.id)) }));
      setSelection(null);
    },
    [update],
  );

  const onConnect = useCallback(
    (c: Connection) => {
      if (!c.source || !c.target || c.source === c.target) return;
      const kind = c.sourceHandle === "rework" ? "rework" : "pass";
      update((s) => setRoute(s, c.source, kind, c.target));
    },
    [update],
  );

  const onSelectionChange = useCallback(({ nodes, edges }: OnSelectionChangeParams) => {
    if (nodes[0]) setSelection({ kind: "station", id: nodes[0].id });
    else if (edges[0]) setSelection({ kind: "edge", id: edges[0].id });
    else setSelection(null);
  }, []);

  const flash = (message: string) => {
    setToast(message);
    setTimeout(() => setToast(null), 2500);
  };

  const share = async () => {
    const hash = await encodeShareHash(savedDoc);
    const url = `${location.origin}${location.pathname}${hash}`;
    if (url.length > MAX_SHARE_URL) {
      flash("This factory is too big for a link. Use Export instead.");
      return;
    }
    try {
      await navigator.clipboard.writeText(url);
      flash("Share link copied.");
    } catch {
      prompt("Copy this share link:", url);
    }
  };

  const exportJson = () => {
    const blob = new Blob([serializeDocument(savedDoc)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${doc.name.toLowerCase().replace(/[^a-z0-9]+/g, "-") || "factory"}.factorysim.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const importJson = async (file: File) => {
    try {
      loadDocument(parseDocument(await file.text()));
      flash(`Loaded ${file.name}.`);
    } catch (e) {
      flash(e instanceof Error ? e.message : "Could not read that file.");
    }
  };

  const bottleneck = findBottleneck(snapshot);
  const live: Live = useMemo(() => {
    const errorsByTarget = new Map<string, string[]>();
    for (const e of errors) {
      if (e.target) errorsByTarget.set(e.target, [...(errorsByTarget.get(e.target) ?? []), e.message]);
    }
    const passFrom = new Set(scenario.edges.filter((e) => e.kind === "pass").map((e) => e.from));
    return {
      stations: new Map(scenario.stations.map((s) => [s.id, s])),
      stats: new Map((snapshot?.stations ?? []).map((s) => [s.id, s])),
      entry: scenario.entry,
      shipping: new Set(scenario.stations.filter((s) => !passFrom.has(s.id)).map((s) => s.id)),
      bottleneck,
      errors: errorsByTarget,
      movedByEdge: new Map((snapshot?.edges ?? []).map((e) => [e.id, e.moved])),
      activeEdges: playing ? activeEdges : new Set(),
    };
  }, [scenario, snapshot, errors, bottleneck, activeEdges, playing]);

  const progress = snapshot ? snapshot.timeMinutes / snapshot.horizonMinutes : 0;
  const days = snapshot ? (snapshot.timeMinutes / 1440).toFixed(1) : "0.0";

  return (
    <div className="app">
      <header className="toolbar">
        <input
          className="doc-name"
          aria-label="Factory name"
          value={doc.name}
          onChange={(e) => setDoc((d) => ({ ...d, name: e.target.value }))}
        />
        <div className="group">
          <span className="muted">Add</span>
          <button onClick={() => addStation("human")}>+ Human</button>
          <button onClick={() => addStation("agent")}>+ Agent</button>
          <button onClick={() => addStation("automation")}>+ Automation</button>
        </div>
        <div className="group">
          <button className="primary" onClick={togglePlay} disabled={!snapshot}>
            {playing ? "Pause" : snapshot?.finished ? "Replay" : "Run"}
          </button>
          <button onClick={reset} disabled={!engineReady}>
            Reset
          </button>
          <button onClick={runToEnd} disabled={!snapshot || snapshot.finished}>
            Run to end
          </button>
          <label className="speed">
            <span className="muted">Speed</span>
            <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))}>
              {SPEEDS.map(([v, label]) => (
                <option key={v} value={v}>
                  {label}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="group">
          <button
            disabled={!snapshot?.finished || snapshot.truncated}
            title="Finish a run, pin it, then change something and run again to compare."
            onClick={() => {
              if (!snapshot) return;
              setBaseline({ totals: snapshot.totals, label: `${doc.name}, seed ${scenario.seed}` });
              flash("Pinned this run as the baseline.");
            }}
          >
            Pin baseline
          </button>
          {baseline && <button onClick={() => setBaseline(null)}>Clear baseline</button>}
        </div>
        <div className="group right">
          <button onClick={share}>Share link</button>
          <button onClick={exportJson}>Export</button>
          <button onClick={() => fileInput.current?.click()}>Import</button>
          <button
            onClick={() => {
              if (confirm("Replace the current factory with the template?")) loadDocument(cloneDocument(TEMPLATE));
            }}
          >
            Template
          </button>
          <input
            ref={fileInput}
            type="file"
            accept=".json,application/json"
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) importJson(file);
              e.target.value = "";
            }}
          />
        </div>
      </header>

      <div className="progress" aria-label={`Simulated ${days} days`}>
        <span style={{ width: `${progress * 100}%` }} />
        <em>
          day {days} of {(scenario.horizonMinutes / 1440).toFixed(1)}
        </em>
      </div>

      <main className="workspace">
        <section className="canvas" aria-label="Factory editor">
          <LiveContext value={live}>
            <ReactFlow
              nodes={nodes}
              edges={edges}
              nodeTypes={nodeTypes}
              edgeTypes={edgeTypes}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onConnect={onConnect}
              onNodesDelete={(ns) => deleteStations(ns.map((n) => n.id))}
              onEdgesDelete={(es) => deleteEdges(es.map((e) => e.id))}
              onSelectionChange={onSelectionChange}
              isValidConnection={(c) => c.source !== c.target}
              fitView
              fitViewOptions={{ padding: 0.3 }}
              deleteKeyCode={["Backspace", "Delete"]}
              minZoom={0.2}
            >
              <Background gap={24} />
              <Controls />
            </ReactFlow>
          </LiveContext>
        </section>

        <aside className="side">
          {errors.length > 0 && (
            <div className="errors" role="alert">
              <h2>Can't run yet</h2>
              <ul>
                {errors.map((e, i) => (
                  <li key={i}>
                    {e.target ? <b>{scenario.stations.find((s) => s.id === e.target)?.name ?? e.target}: </b> : null}
                    {e.message}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <Inspector
            scenario={scenario}
            selection={selection}
            update={update}
            onDeleteStation={(id) => deleteStations([id])}
            onDeleteEdge={(id) => deleteEdges([id])}
          />
        </aside>
      </main>

      <footer className="bottom">
        {baseline && <div className="baseline-label">Baseline: {baseline.label}</div>}
        <Metrics
          scenario={scenario}
          snapshot={snapshot}
          series={series}
          // A partial run would make every delta misleading.
          baseline={snapshot?.truncated ? null : (baseline?.totals ?? null)}
          bottleneck={bottleneck}
        />
      </footer>

      {toast && (
        <div className="toast" role="status">
          {toast}
        </div>
      )}
    </div>
  );
}
