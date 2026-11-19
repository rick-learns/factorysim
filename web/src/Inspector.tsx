import { useEffect, useId, useState } from "react";
import { KIND_LABEL } from "./document";
import type { Edge, EdgeKind, Scenario, Service, Station, StationKind } from "./types";

type Update = (fn: (s: Scenario) => Scenario) => void;

function NumberField(props: {
  label: string;
  value: number | null;
  onChange: (v: number | null) => void;
  min?: number;
  max?: number;
  step?: number;
  allowEmpty?: boolean;
  hint?: string;
}) {
  const id = useId();
  const [text, setText] = useState(props.value === null ? "" : String(props.value));
  useEffect(() => {
    setText(props.value === null ? "" : String(props.value));
  }, [props.value]);
  return (
    <label className="field" htmlFor={id}>
      <span>{props.label}</span>
      <input
        id={id}
        type="number"
        inputMode="decimal"
        value={text}
        min={props.min}
        max={props.max}
        step={props.step ?? "any"}
        placeholder={props.allowEmpty ? "none" : undefined}
        onChange={(e) => {
          setText(e.target.value);
          if (e.target.value === "" && props.allowEmpty) props.onChange(null);
          const v = e.target.valueAsNumber;
          if (Number.isFinite(v)) props.onChange(v);
        }}
      />
      {props.hint && <small>{props.hint}</small>}
    </label>
  );
}

function PercentField(props: { label: string; value: number; onChange: (v: number) => void; hint?: string }) {
  return (
    <NumberField
      label={props.label}
      hint={props.hint}
      value={Math.round(props.value * 1000) / 10}
      min={0}
      max={100}
      step={1}
      onChange={(v) => props.onChange((v ?? 0) / 100)}
    />
  );
}

function SelectField<T extends string>(props: {
  label: string;
  value: T;
  options: [T, string][];
  onChange: (v: T) => void;
}) {
  const id = useId();
  return (
    <label className="field" htmlFor={id}>
      <span>{props.label}</span>
      <select id={id} value={props.value} onChange={(e) => props.onChange(e.target.value as T)}>
        {props.options.map(([v, label]) => (
          <option key={v} value={v}>
            {label}
          </option>
        ))}
      </select>
    </label>
  );
}

function routeOf(s: Scenario, from: string, kind: EdgeKind): string {
  return s.edges.find((e) => e.from === from && e.kind === kind)?.to ?? "";
}

/** Replace the station's route of one kind; an empty target removes it. */
export function setRoute(s: Scenario, from: string, kind: EdgeKind, to: string): Scenario {
  const edges = s.edges.filter((e) => !(e.from === from && e.kind === kind));
  if (to) {
    const base = kind === "rework" ? `${from}-rework-${to}` : `${from}-${to}`;
    let id = base;
    for (let i = 2; edges.some((e) => e.id === id); i++) id = `${base}-${i}`;
    edges.push({ id, from, to, kind });
  }
  return { ...s, edges };
}

function StationInspector(props: { scenario: Scenario; station: Station; update: Update; onDelete: () => void }) {
  const { scenario, station, update } = props;
  const patch = (p: Partial<Station>) =>
    update((s) => ({ ...s, stations: s.stations.map((st) => (st.id === station.id ? { ...st, ...p } : st)) }));
  const setService = (service: Service) => patch({ service });
  const others = scenario.stations.filter((st) => st.id !== station.id);
  const routeOptions = (empty: string): [string, string][] => [
    ["", empty],
    ...others.map((st): [string, string] => [st.id, st.name]),
  ];
  const svc = station.service;

  return (
    <div className="inspector-body">
      <h2>Station</h2>
      <label className="field">
        <span>Name</span>
        <input value={station.name} onChange={(e) => patch({ name: e.target.value })} />
      </label>
      <SelectField<StationKind>
        label="Who does the work"
        value={station.kind}
        options={(Object.keys(KIND_LABEL) as StationKind[]).map((k) => [k, KIND_LABEL[k]])}
        onChange={(kind) => patch({ kind })}
      />
      <NumberField
        label="Workers in parallel"
        value={station.workers}
        min={1}
        step={1}
        onChange={(v) => patch({ workers: Math.max(1, Math.round(v ?? 1)) })}
      />

      <h3>Time per attempt (minutes)</h3>
      <SelectField
        label="Distribution"
        value={svc.type}
        options={[
          ["triangular", "Varies (min / likely / max)"],
          ["constant", "Always the same"],
        ]}
        onChange={(type) =>
          setService(
            type === "constant"
              ? { type, minutes: svc.type === "constant" ? svc.minutes : svc.mode }
              : svc.type === "triangular"
                ? svc
                : { type, min: svc.minutes * 0.5, mode: svc.minutes, max: svc.minutes * 2 },
          )
        }
      />
      {svc.type === "constant" ? (
        <NumberField label="Minutes" value={svc.minutes} min={0} onChange={(v) => setService({ ...svc, minutes: v ?? 0 })} />
      ) : (
        <div className="row3">
          <NumberField label="Min" value={svc.min} min={0} onChange={(v) => setService({ ...svc, min: v ?? 0 })} />
          <NumberField label="Likely" value={svc.mode} min={0} onChange={(v) => setService({ ...svc, mode: v ?? 0 })} />
          <NumberField label="Max" value={svc.max} min={0} onChange={(v) => setService({ ...svc, max: v ?? 0 })} />
        </div>
      )}

      <h3>Quality</h3>
      <PercentField
        label="Introduces a hidden defect (%)"
        value={station.defectRate}
        onChange={(defectRate) => patch({ defectRate })}
      />
      <PercentField
        label="Catches a hidden defect (%)"
        hint="Caught work goes back along the rework route."
        value={station.detectionRate}
        onChange={(detectionRate) => patch({ detectionRate })}
      />

      <h3>Cost</h3>
      <div className="row2">
        <NumberField label="Per attempt" value={station.costPerTask} min={0} onChange={(v) => patch({ costPerTask: v ?? 0 })} />
        <NumberField label="Per busy hour" value={station.costPerHour} min={0} onChange={(v) => patch({ costPerHour: v ?? 0 })} />
      </div>

      <h3>Routes</h3>
      <SelectField
        label="Passed work goes to"
        value={routeOf(scenario, station.id, "pass")}
        options={routeOptions("Ships to production")}
        onChange={(to) => update((s) => setRoute(s, station.id, "pass", to))}
      />
      <SelectField
        label="Caught defects go back to"
        value={routeOf(scenario, station.id, "rework")}
        options={routeOptions("No rework route")}
        onChange={(to) => update((s) => setRoute(s, station.id, "rework", to))}
      />

      <div className="actions">
        <button
          disabled={scenario.entry === station.id}
          onClick={() => update((s) => ({ ...s, entry: station.id }))}
        >
          {scenario.entry === station.id ? "New work enters here" : "Make entry station"}
        </button>
        <button className="danger" onClick={props.onDelete}>
          Delete station
        </button>
      </div>
    </div>
  );
}

function EdgeInspector(props: { scenario: Scenario; edge: Edge; onDelete: () => void }) {
  const name = (id: string) => props.scenario.stations.find((s) => s.id === id)?.name ?? id;
  return (
    <div className="inspector-body">
      <h2>{props.edge.kind === "pass" ? "Pass route" : "Rework route"}</h2>
      <p>
        {name(props.edge.from)} → {name(props.edge.to)}
      </p>
      <p className="muted">
        {props.edge.kind === "pass"
          ? "Work that passes this station moves on here."
          : "Work with a caught defect is sent back here to be fixed."}
      </p>
      <div className="actions">
        <button className="danger" onClick={props.onDelete}>
          Delete route
        </button>
      </div>
    </div>
  );
}

function FactoryInspector(props: { scenario: Scenario; update: Update }) {
  const { scenario, update } = props;
  const patch = (p: Partial<Scenario>) => update((s) => ({ ...s, ...p }));
  return (
    <div className="inspector-body">
      <h2>Factory</h2>
      <p className="muted">Select a station or route to edit it. Drag from a station's right handle to route passed work, or from its red bottom handle to route rework.</p>
      <NumberField
        label="New work arrives every (minutes)"
        value={scenario.arrivalIntervalMinutes}
        min={0.1}
        onChange={(v) => patch({ arrivalIntervalMinutes: v ?? 1 })}
      />
      <NumberField
        label="Simulate for (days)"
        value={Math.round((scenario.horizonMinutes / 1440) * 100) / 100}
        min={0.1}
        onChange={(v) => patch({ horizonMinutes: Math.round((v ?? 1) * 1440) })}
      />
      <NumberField
        label="WIP limit (items in progress)"
        value={scenario.wipLimit}
        min={1}
        step={1}
        allowEmpty
        hint="Leave empty for no limit. Extra work waits in a backlog."
        onChange={(v) => patch({ wipLimit: v === null ? null : Math.max(1, Math.round(v)) })}
      />
      <NumberField
        label="Max rework trips per item"
        value={scenario.maxRework}
        min={0}
        step={1}
        hint="After this, caught work ships anyway."
        onChange={(v) => patch({ maxRework: Math.max(0, Math.round(v ?? 0)) })}
      />
      <NumberField
        label="Random seed"
        value={scenario.seed}
        min={0}
        step={1}
        hint="Same seed and settings always give the same run."
        onChange={(v) => patch({ seed: Math.min(2 ** 32 - 1, Math.max(0, Math.round(v ?? 0))) })}
      />
    </div>
  );
}

export function Inspector(props: {
  scenario: Scenario;
  selection: { kind: "station" | "edge"; id: string } | null;
  update: Update;
  onDeleteStation: (id: string) => void;
  onDeleteEdge: (id: string) => void;
}) {
  const { scenario, selection } = props;
  if (selection?.kind === "station") {
    const station = scenario.stations.find((s) => s.id === selection.id);
    if (station)
      return (
        <StationInspector
          key={station.id}
          scenario={scenario}
          station={station}
          update={props.update}
          onDelete={() => props.onDeleteStation(station.id)}
        />
      );
  }
  if (selection?.kind === "edge") {
    const edge = scenario.edges.find((e) => e.id === selection.id);
    if (edge) return <EdgeInspector scenario={scenario} edge={edge} onDelete={() => props.onDeleteEdge(edge.id)} />;
  }
  return <FactoryInspector scenario={scenario} update={props.update} />;
}
