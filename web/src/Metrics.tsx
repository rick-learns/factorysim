import type { Scenario, Series, Snapshot, Totals } from "./types";

const PALETTE = ["#2563eb", "#dc2626", "#16a34a", "#d97706", "#7c3aed", "#0891b2", "#db2777", "#65a30d"];

export function formatMinutes(m: number | null | undefined): string {
  if (m === null || m === undefined) return "–";
  if (m < 90) return `${Math.round(m)} min`;
  if (m < 60 * 48) return `${(m / 60).toFixed(1)} h`;
  return `${(m / 1440).toFixed(1)} d`;
}

function money(v: number | null): string {
  if (v === null) return "–";
  return v >= 1000 ? `$${(v / 1000).toFixed(1)}k` : `$${v.toFixed(v < 10 ? 2 : 0)}`;
}

interface Line {
  label: string;
  values: number[];
  color: string;
}

function LineChart(props: { title: string; time: number[]; lines: Line[]; horizon: number }) {
  const W = 480;
  const H = 110;
  const pad = { l: 34, r: 6, t: 6, b: 18 };
  const max = Math.max(1, ...props.lines.flatMap((l) => l.values));
  const x = (t: number) => pad.l + (t / props.horizon) * (W - pad.l - pad.r);
  const y = (v: number) => H - pad.b - (v / max) * (H - pad.t - pad.b);
  return (
    <figure className="chart">
      <figcaption>{props.title}</figcaption>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={props.title}>
        <line x1={pad.l} x2={W - pad.r} y1={y(0)} y2={y(0)} className="axis" />
        <line x1={pad.l} x2={pad.l} y1={pad.t} y2={y(0)} className="axis" />
        <text x={pad.l - 4} y={pad.t + 8} textAnchor="end" className="tick">
          {Math.round(max)}
        </text>
        <text x={pad.l - 4} y={y(0)} textAnchor="end" className="tick">
          0
        </text>
        <text x={W - pad.r} y={H - 4} textAnchor="end" className="tick">
          {formatMinutes(props.horizon)}
        </text>
        {props.lines.map((l) => (
          <polyline
            key={l.label}
            fill="none"
            stroke={l.color}
            strokeWidth={1.6}
            points={l.values.map((v, i) => `${x(props.time[i]).toFixed(1)},${y(v).toFixed(1)}`).join(" ")}
          />
        ))}
      </svg>
      <div className="legend">
        {props.lines.map((l) => (
          <span key={l.label}>
            <i style={{ background: l.color }} />
            {l.label}
          </span>
        ))}
      </div>
    </figure>
  );
}

function Delta(props: { now: number | null; base: number | null | undefined; lowerIsBetter?: boolean }) {
  const { now, base } = props;
  if (now === null || base === null || base === undefined || base === 0) return null;
  const pct = ((now - base) / Math.abs(base)) * 100;
  if (Math.abs(pct) < 0.5) return <span className="delta">±0%</span>;
  const good = props.lowerIsBetter ? pct < 0 : pct > 0;
  return (
    <span className={`delta ${good ? "good" : "bad"}`}>
      {pct > 0 ? "+" : ""}
      {pct.toFixed(0)}%
    </span>
  );
}

function Card(props: {
  label: string;
  value: string;
  sub?: string;
  now?: number | null;
  base?: number | null;
  lowerIsBetter?: boolean;
}) {
  return (
    <div className="card">
      <div className="card-label">{props.label}</div>
      <div className="card-value">
        {props.value}
        {props.now !== undefined && <Delta now={props.now} base={props.base} lowerIsBetter={props.lowerIsBetter} />}
      </div>
      {props.sub && <div className="card-sub">{props.sub}</div>}
    </div>
  );
}

export function Metrics(props: {
  scenario: Scenario;
  snapshot: Snapshot | null;
  series: Series | null;
  baseline: Totals | null;
  bottleneck: string | null;
}) {
  const { snapshot: snap, series, scenario, baseline: base } = props;
  if (!snap) return <div className="metrics empty">Fix the problems above to run the factory.</div>;
  const t = snap.totals;
  const escapeRate = t.shipped > 0 ? t.defectsEscaped / t.shipped : null;
  const baseEscape = base && base.shipped > 0 ? base.defectsEscaped / base.shipped : null;
  const name = (id: string) => scenario.stations.find((s) => s.id === id)?.name ?? id;
  const neck = props.bottleneck ? snap.stations.find((s) => s.id === props.bottleneck) : undefined;

  return (
    <div className="metrics">
      <div className="cards">
        <Card label="Shipped" value={String(t.shipped)} sub={`of ${t.arrived} started`} now={t.shipped} base={base?.shipped} />
        <Card
          label="Throughput"
          value={`${t.throughputPerDay.toFixed(1)}/day`}
          now={t.throughputPerDay}
          base={base?.throughputPerDay}
        />
        <Card
          label="Lead time p50"
          value={formatMinutes(t.leadTimeP50Minutes)}
          sub={`p95 ${formatMinutes(t.leadTimeP95Minutes)}`}
          now={t.leadTimeP50Minutes}
          base={base?.leadTimeP50Minutes}
          lowerIsBetter
        />
        <Card label="In progress" value={String(t.wip)} sub={`${t.backlog} waiting in backlog`} now={t.wip} base={base?.wip} lowerIsBetter />
        <Card
          label="Cost per shipped"
          value={money(t.costPerShipped)}
          sub={`${money(t.cost)} total`}
          now={t.costPerShipped}
          base={base?.costPerShipped}
          lowerIsBetter
        />
        <Card
          label="Defects escaped"
          value={escapeRate === null ? "–" : `${(escapeRate * 100).toFixed(1)}%`}
          sub={`${t.defectsEscaped} shipped bugs · ${t.defectsCaught} caught · ${t.reworks} reworks`}
          now={escapeRate}
          base={baseEscape}
          lowerIsBetter
        />
      </div>

      <p className="summary" aria-live="polite">
        {neck
          ? `Bottleneck: ${name(neck.id)} is ${Math.round(neck.utilization * 100)}% busy with ${neck.queue} waiting (avg wait ${formatMinutes(neck.avgWaitMinutes)}).`
          : "No bottleneck: no station is both near capacity and building a queue."}{" "}
        {t.reworkCapHits > 0 && `${t.reworkCapHits} items hit the rework cap and shipped with a known defect.`}
      </p>

      {series && series.timeMinutes.length > 1 && (
        <div className="charts">
          <LineChart
            title="Work in progress"
            time={series.timeMinutes}
            horizon={snap.horizonMinutes}
            lines={[
              { label: "in progress", values: series.wip, color: PALETTE[0] },
              { label: "backlog", values: series.backlog, color: PALETTE[3] },
            ]}
          />
          <LineChart
            title="Queues by station"
            time={series.timeMinutes}
            horizon={snap.horizonMinutes}
            lines={scenario.stations.map((s, i) => ({
              label: s.name,
              values: series.queues[i] ?? [],
              color: PALETTE[i % PALETTE.length],
            }))}
          />
          <LineChart
            title="Shipped (cumulative)"
            time={series.timeMinutes}
            horizon={snap.horizonMinutes}
            lines={[{ label: "shipped", values: series.shipped, color: PALETTE[2] }]}
          />
        </div>
      )}
      <p className="muted small">
        Scenario estimate from a seeded simulation, not a forecast. {base && "Deltas compare against your pinned baseline."}
      </p>
    </div>
  );
}
