import { createContext, useContext } from "react";
import {
  BaseEdge,
  Handle,
  Position,
  getBezierPath,
  getSmoothStepPath,
  type EdgeProps,
  type NodeProps,
} from "@xyflow/react";
import { KIND_LABEL } from "./document";
import type { EdgeKind, Station, StationSnapshot } from "./types";

/** Live state shared with nodes and edges, so React Flow's own node data stays static. */
export interface Live {
  stations: Map<string, Station>;
  stats: Map<string, StationSnapshot>;
  entry: string;
  shipping: Set<string>;
  bottleneck: string | null;
  errors: Map<string, string[]>;
  movedByEdge: Map<string, number>;
  activeEdges: Set<string>;
}

export const LiveContext = createContext<Live | null>(null);

function useLive(): Live {
  const live = useContext(LiveContext);
  if (!live) throw new Error("LiveContext missing");
  return live;
}

function heat(utilization: number): string {
  if (utilization >= 0.9) return "hot";
  if (utilization >= 0.7) return "warm";
  return "cool";
}

export function StationNode({ id, selected }: NodeProps) {
  const live = useLive();
  const station = live.stations.get(id);
  if (!station) return null;
  const stats = live.stats.get(id);
  const errors = live.errors.get(id);
  const busy = stats?.busy ?? 0;
  const queue = stats?.queue ?? 0;
  const utilization = stats?.utilization ?? 0;
  const workerDots = Math.min(station.workers, 12);

  return (
    <div
      className={[
        "station",
        `kind-${station.kind}`,
        stats ? `heat-${heat(utilization)}` : "",
        selected ? "selected" : "",
        live.bottleneck === id ? "bottleneck" : "",
        errors ? "invalid" : "",
      ].join(" ")}
      title={errors?.join("\n")}
    >
      <Handle type="target" position={Position.Left} id="in" aria-label="Incoming work" />
      <div className="station-head">
        <span className="kind-badge">{KIND_LABEL[station.kind]}</span>
        {live.entry === id && <span className="tag">entry</span>}
        {live.shipping.has(id) && <span className="tag ship">ships</span>}
        {live.bottleneck === id && <span className="tag hot">bottleneck</span>}
      </div>
      <div className="station-name">{station.name}</div>
      <div className="workers" aria-label={`${busy} of ${station.workers} workers busy`}>
        {Array.from({ length: workerDots }, (_, i) => (
          <span key={i} className={i < busy ? "worker busy" : "worker"} />
        ))}
        {station.workers > workerDots && <span className="more">+{station.workers - workerDots}</span>}
      </div>
      <div className="station-stats">
        <span>
          queue <b>{queue}</b>
        </span>
        <span>
          busy <b>{stats ? Math.round(utilization * 100) : "–"}%</b>
        </span>
        {station.detectionRate > 0 && (
          <span>
            caught <b>{stats?.caught ?? 0}</b>
          </span>
        )}
      </div>
      <div className="queue-bar" aria-hidden>
        <span style={{ width: `${Math.min(100, queue * 4)}%` }} />
      </div>
      {errors && <div className="station-error">{errors[0]}</div>}
      <Handle type="source" position={Position.Right} id="pass" aria-label="Pass route" />
      <Handle
        type="source"
        position={Position.Bottom}
        id="rework"
        className="handle-rework"
        style={{ left: "72%" }}
        aria-label="Rework route"
      />
      <Handle
        type="target"
        position={Position.Bottom}
        id="rework-in"
        className="handle-rework-in"
        style={{ left: "28%" }}
        aria-label="Incoming rework"
      />
    </div>
  );
}

export type FlowEdgeData = { kind: EdgeKind };

export function FlowEdge(props: EdgeProps) {
  const live = useLive();
  const kind = (props.data as FlowEdgeData | undefined)?.kind ?? "pass";
  const [path, labelX, labelY] =
    kind === "rework"
      ? getSmoothStepPath({ ...props, offset: 40, borderRadius: 16 })
      : getBezierPath(props);
  const moved = live.movedByEdge.get(props.id) ?? 0;
  const active = live.activeEdges.has(props.id);

  return (
    <>
      <BaseEdge
        id={props.id}
        path={path}
        markerEnd={props.markerEnd}
        className={`flow-edge ${kind}${props.selected ? " selected" : ""}`}
        label={moved > 0 ? String(moved) : undefined}
        labelX={labelX}
        // Sit above the line so moving tokens and handles don't cover the count.
        labelY={labelY - 12}
        labelBgPadding={[4, 2]}
        labelBgBorderRadius={4}
        labelStyle={{ fontSize: 11 }}
      />
      {active &&
        [0, 1, 2].map((i) => (
          <circle key={i} r={4} className={`token ${kind}`}>
            <animateMotion dur="1.5s" begin={`${i * 0.5}s`} repeatCount="indefinite" path={path} />
          </circle>
        ))}
    </>
  );
}
