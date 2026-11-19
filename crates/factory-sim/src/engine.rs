//! Discrete-event engine. Time is whole seconds; events are ordered by
//! `(time, sequence)` so ties always resolve in the order they were scheduled.
//! How the caller slices `advance_to` calls never changes the outcome.

use std::cmp::Reverse;
use std::collections::{BinaryHeap, VecDeque};

use rand_core::Rng;
use rand_pcg::Pcg64Mcg;
use serde::Serialize;

use crate::model::{EdgeKind, Scenario, Service};
use crate::validate::{ValidationError, validate};

/// Roughly how many chart samples a full run records.
const SAMPLES_PER_RUN: u64 = 300;

/// Hard stop so an extreme model cannot hang the browser. Deterministic, so a
/// truncated run is still reproducible.
pub const EVENT_BUDGET: u64 = 5_000_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
enum EventKind {
    Arrival,
    Done { station: usize, item: usize },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
struct Event {
    time: u64,
    seq: u64,
    kind: EventKind,
}

#[derive(Clone, Debug)]
struct Item {
    arrived: u64,
    enqueued: u64,
    defect: bool,
    /// Sent back for rework and not yet re-worked by the rework station.
    awaiting_fix: bool,
    reworks: u32,
    /// Hit the rework cap; moves on with its defect and is not caught again.
    waved_through: bool,
}

#[derive(Clone, Debug)]
struct StationState {
    /// Each station draws from its own stream, so adding or editing one station
    /// does not reshuffle the random draws of the others.
    rng: Pcg64Mcg,
    workers: u32,
    service: Service,
    cost_per_task: f64,
    cost_per_hour: f64,
    defect_rate: f64,
    detection_rate: f64,
    pass: Option<(usize, usize)>,
    rework: Option<(usize, usize)>,

    queue: VecDeque<usize>,
    busy: u32,
    busy_seconds: u64,
    last_change: u64,
    started: u64,
    completed: u64,
    wait_seconds: u64,
    caught: u64,
    /// Flat per-attempt charges so far; hourly cost accrues from busy time.
    task_cost: f64,
}

impl StationState {
    fn busy_seconds_at(&self, now: u64) -> u64 {
        self.busy_seconds + u64::from(self.busy) * (now - self.last_change)
    }

    fn cost_at(&self, now: u64) -> f64 {
        self.task_cost + self.busy_seconds_at(now) as f64 / 3600.0 * self.cost_per_hour
    }
}

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Totals {
    pub arrived: u64,
    pub shipped: u64,
    pub backlog: u64,
    pub wip: u64,
    pub defects_introduced: u64,
    pub defects_caught: u64,
    /// Shipped items that still had a hidden defect.
    pub defects_escaped: u64,
    /// Items that hit `max_rework` and moved on with a known defect.
    pub rework_cap_hits: u64,
    pub reworks: u64,
    pub cost: f64,
    pub cost_per_shipped: Option<f64>,
    pub lead_time_p50_minutes: Option<f64>,
    pub lead_time_p95_minutes: Option<f64>,
    pub throughput_per_day: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StationSnapshot {
    pub id: String,
    pub queue: u64,
    pub busy: u32,
    pub workers: u32,
    pub started: u64,
    pub completed: u64,
    pub caught: u64,
    pub utilization: f64,
    pub avg_wait_minutes: Option<f64>,
    pub cost: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EdgeSnapshot {
    pub id: String,
    /// Items that have travelled this edge so far.
    pub moved: u64,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub model_version: u32,
    pub time_minutes: f64,
    pub horizon_minutes: f64,
    pub finished: bool,
    /// Stopped early at `EVENT_BUDGET`; results cover only `time_minutes`.
    pub truncated: bool,
    pub events: u64,
    pub totals: Totals,
    pub stations: Vec<StationSnapshot>,
    pub edges: Vec<EdgeSnapshot>,
}

/// State over time, sampled at a fixed simulated interval.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Series {
    pub time_minutes: Vec<f64>,
    pub wip: Vec<u64>,
    pub backlog: Vec<u64>,
    pub shipped: Vec<u64>,
    pub cost: Vec<f64>,
    /// `queues[station][sample]`, stations in scenario order.
    pub queues: Vec<Vec<u64>>,
}

pub struct Sim {
    scenario: Scenario,
    events: BinaryHeap<Reverse<Event>>,
    seq: u64,
    now: u64,
    horizon: u64,
    arrival_interval: u64,
    entry: usize,
    stations: Vec<StationState>,
    edge_moved: Vec<u64>,
    items: Vec<Item>,
    backlog: VecDeque<usize>,
    lead_times: Vec<u64>,
    totals: Totals,
    processed: u64,
    /// All events through the horizon are handled (or the budget ran out).
    done: bool,
    truncated: bool,
    sample_every: u64,
    next_sample: u64,
    series: Series,
}

fn to_seconds(minutes: f64) -> u64 {
    (minutes * 60.0).round() as u64
}

impl Sim {
    pub fn new(scenario: Scenario) -> Result<Self, Vec<ValidationError>> {
        let errors = validate(&scenario);
        if !errors.is_empty() {
            return Err(errors);
        }

        let station_index = |id: &str| scenario.stations.iter().position(|s| s.id == id);
        let mut stations: Vec<StationState> = scenario
            .stations
            .iter()
            .map(|s| StationState {
                rng: station_rng(scenario.seed, &s.id),
                workers: s.workers,
                service: s.service,
                cost_per_task: s.cost_per_task,
                cost_per_hour: s.cost_per_hour,
                defect_rate: s.defect_rate,
                detection_rate: s.detection_rate,
                pass: None,
                rework: None,
                queue: VecDeque::new(),
                busy: 0,
                busy_seconds: 0,
                last_change: 0,
                started: 0,
                completed: 0,
                wait_seconds: 0,
                caught: 0,
                task_cost: 0.0,
            })
            .collect();
        for (edge, e) in scenario.edges.iter().enumerate() {
            let from = station_index(&e.from).expect("validated");
            let to = station_index(&e.to).expect("validated");
            match e.kind {
                EdgeKind::Pass => stations[from].pass = Some((edge, to)),
                EdgeKind::Rework => stations[from].rework = Some((edge, to)),
            }
        }

        let horizon = to_seconds(scenario.horizon_minutes);
        let sample_every = (horizon / SAMPLES_PER_RUN).max(60);
        let mut sim = Sim {
            events: BinaryHeap::new(),
            seq: 0,
            now: 0,
            horizon,
            arrival_interval: to_seconds(scenario.arrival_interval_minutes).max(1),
            entry: station_index(&scenario.entry).expect("validated"),
            edge_moved: vec![0; scenario.edges.len()],
            series: Series {
                queues: vec![Vec::new(); stations.len()],
                ..Series::default()
            },
            stations,
            items: Vec::new(),
            backlog: VecDeque::new(),
            lead_times: Vec::new(),
            totals: Totals::default(),
            processed: 0,
            done: false,
            truncated: false,
            sample_every,
            next_sample: 0,
            scenario,
        };
        sim.schedule(0, EventKind::Arrival);
        Ok(sim)
    }

    pub fn scenario(&self) -> &Scenario {
        &self.scenario
    }

    pub fn finished(&self) -> bool {
        self.done
    }

    /// Process events up to `minutes` (capped at the horizon), stopping early
    /// after `max_events`. Returns the number of events processed.
    pub fn advance_to(&mut self, minutes: f64, max_events: u64) -> u64 {
        let target = to_seconds(minutes.max(0.0)).min(self.horizon);
        let mut count = 0;
        while count < max_events && !self.done {
            if self.processed >= EVENT_BUDGET {
                self.truncated = true;
                self.done = true;
                break;
            }
            match self.events.peek() {
                Some(Reverse(e)) if e.time <= target => {
                    let Reverse(e) = self.events.pop().expect("peeked");
                    self.record_samples_before(e.time);
                    self.now = e.time;
                    self.handle(e.kind);
                    count += 1;
                    self.processed += 1;
                }
                _ => {
                    self.record_samples_before(target + 1);
                    self.now = self.now.max(target);
                    self.done = target == self.horizon;
                    break;
                }
            }
        }
        count
    }

    pub fn run_to_end(&mut self) {
        while !self.done {
            self.advance_to(self.scenario.horizon_minutes, u64::MAX);
        }
    }

    fn schedule(&mut self, time: u64, kind: EventKind) {
        self.seq += 1;
        self.events.push(Reverse(Event {
            time,
            seq: self.seq,
            kind,
        }));
    }

    /// Unit-interval sample with 53 bits of precision.
    fn uniform(&mut self, station: usize) -> f64 {
        (self.stations[station].rng.next_u64() >> 11) as f64 * (1.0 / (1u64 << 53) as f64)
    }

    fn chance(&mut self, station: usize, p: f64) -> bool {
        // Always draw, so changing one rate does not shift every later sample.
        let u = self.uniform(station);
        u < p
    }

    fn service_seconds(&mut self, station: usize) -> u64 {
        let minutes = match self.stations[station].service {
            Service::Constant { minutes } => minutes,
            Service::Triangular { min, mode, max } => {
                // Inverse CDF. Uses only +, -, *, / and sqrt, which IEEE 754
                // rounds identically on native and wasm targets.
                let u = self.uniform(station);
                let span = max - min;
                if span <= 0.0 {
                    min
                } else {
                    let split = (mode - min) / span;
                    if u < split {
                        min + (u * span * (mode - min)).sqrt()
                    } else {
                        max - ((1.0 - u) * span * (max - mode)).sqrt()
                    }
                }
            }
        };
        to_seconds(minutes)
    }

    fn handle(&mut self, kind: EventKind) {
        match kind {
            EventKind::Arrival => self.arrive(),
            EventKind::Done { station, item } => self.finish(station, item),
        }
    }

    fn arrive(&mut self) {
        let item = self.items.len();
        self.items.push(Item {
            arrived: self.now,
            enqueued: self.now,
            defect: false,
            awaiting_fix: false,
            reworks: 0,
            waved_through: false,
        });
        self.totals.arrived += 1;
        let next = self.now + self.arrival_interval;
        if next < self.horizon {
            self.schedule(next, EventKind::Arrival);
        }
        if self
            .scenario
            .wip_limit
            .is_some_and(|limit| self.totals.wip >= u64::from(limit))
        {
            self.backlog.push_back(item);
        } else {
            self.admit(item);
        }
    }

    fn admit(&mut self, item: usize) {
        self.totals.wip += 1;
        self.enqueue(self.entry, item);
    }

    fn enqueue(&mut self, station: usize, item: usize) {
        self.items[item].enqueued = self.now;
        self.stations[station].queue.push_back(item);
        self.start_work(station);
    }

    fn set_busy(&mut self, station: usize, busy: u32) {
        let st = &mut self.stations[station];
        st.busy_seconds += u64::from(st.busy) * (self.now - st.last_change);
        st.last_change = self.now;
        st.busy = busy;
    }

    fn start_work(&mut self, station: usize) {
        while self.stations[station].busy < self.stations[station].workers {
            let Some(item) = self.stations[station].queue.pop_front() else {
                break;
            };
            let busy = self.stations[station].busy + 1;
            self.set_busy(station, busy);
            let duration = self.service_seconds(station);
            let st = &mut self.stations[station];
            st.started += 1;
            st.wait_seconds += self.now - self.items[item].enqueued;
            st.task_cost += st.cost_per_task;
            self.schedule(self.now + duration, EventKind::Done { station, item });
        }
    }

    fn finish(&mut self, station: usize, item: usize) {
        let busy = self.stations[station].busy - 1;
        self.set_busy(station, busy);
        self.stations[station].completed += 1;

        if self.items[item].awaiting_fix {
            // This station is where the caught defect was routed: it is fixed now.
            self.items[item].awaiting_fix = false;
            self.items[item].defect = false;
        }

        let (detection_rate, defect_rate) = {
            let st = &self.stations[station];
            (st.detection_rate, st.defect_rate)
        };
        let caught = self.chance(station, detection_rate)
            && self.items[item].defect
            && !self.items[item].waved_through;
        let introduced = self.chance(station, defect_rate);

        if caught {
            self.totals.defects_caught += 1;
            self.stations[station].caught += 1;
        }
        if caught && self.items[item].reworks < self.scenario.max_rework {
            let (edge, to) = self.stations[station].rework.expect("validated");
            self.items[item].reworks += 1;
            self.items[item].awaiting_fix = true;
            self.totals.reworks += 1;
            self.edge_moved[edge] += 1;
            self.enqueue(to, item);
        } else {
            if caught {
                self.totals.rework_cap_hits += 1;
                self.items[item].waved_through = true;
            }
            if introduced && !self.items[item].defect {
                self.items[item].defect = true;
                self.totals.defects_introduced += 1;
            }
            match self.stations[station].pass {
                Some((edge, to)) => {
                    self.edge_moved[edge] += 1;
                    self.enqueue(to, item);
                }
                None => self.ship(item),
            }
        }

        self.start_work(station);
    }

    fn ship(&mut self, item: usize) {
        self.totals.shipped += 1;
        self.totals.wip -= 1;
        if self.items[item].defect {
            self.totals.defects_escaped += 1;
        }
        self.lead_times.push(self.now - self.items[item].arrived);
        if let Some(next) = self.backlog.pop_front() {
            self.admit(next);
        }
    }

    /// Record every sample point strictly before `time`, using the state as it
    /// stands, since state only changes at events.
    fn record_samples_before(&mut self, time: u64) {
        while self.next_sample < time && self.next_sample <= self.horizon {
            let s = &mut self.series;
            s.time_minutes.push(self.next_sample as f64 / 60.0);
            s.wip.push(self.totals.wip);
            s.backlog.push(self.backlog.len() as u64);
            s.shipped.push(self.totals.shipped);
            s.cost.push(
                self.stations
                    .iter()
                    .map(|st| st.cost_at(self.next_sample))
                    .sum(),
            );
            for (q, st) in s.queues.iter_mut().zip(&self.stations) {
                q.push(st.queue.len() as u64);
            }
            self.next_sample += self.sample_every;
        }
    }

    pub fn series(&self) -> &Series {
        &self.series
    }

    pub fn snapshot(&self) -> Snapshot {
        let now = self.now.max(1);
        let mut totals = self.totals.clone();
        totals.cost = self.stations.iter().map(|st| st.cost_at(self.now)).sum();
        totals.backlog = self.backlog.len() as u64;
        if totals.shipped > 0 {
            totals.cost_per_shipped = Some(totals.cost / totals.shipped as f64);
        }
        let mut lead = self.lead_times.clone();
        lead.sort_unstable();
        totals.lead_time_p50_minutes = percentile(&lead, 0.50);
        totals.lead_time_p95_minutes = percentile(&lead, 0.95);
        totals.throughput_per_day = totals.shipped as f64 * 86_400.0 / now as f64;

        let stations = self
            .stations
            .iter()
            .zip(&self.scenario.stations)
            .map(|(st, def)| {
                let busy_seconds = st.busy_seconds_at(self.now);
                StationSnapshot {
                    id: def.id.clone(),
                    queue: st.queue.len() as u64,
                    busy: st.busy,
                    workers: st.workers,
                    started: st.started,
                    completed: st.completed,
                    caught: st.caught,
                    utilization: busy_seconds as f64 / (u64::from(st.workers) * now) as f64,
                    avg_wait_minutes: (st.started > 0)
                        .then(|| st.wait_seconds as f64 / st.started as f64 / 60.0),
                    cost: st.cost_at(self.now),
                }
            })
            .collect();

        let edges = self
            .scenario
            .edges
            .iter()
            .zip(&self.edge_moved)
            .map(|(e, &moved)| EdgeSnapshot {
                id: e.id.clone(),
                moved,
            })
            .collect();

        Snapshot {
            model_version: crate::MODEL_VERSION,
            time_minutes: self.now as f64 / 60.0,
            horizon_minutes: self.scenario.horizon_minutes,
            finished: self.done,
            truncated: self.truncated,
            events: self.processed,
            totals,
            stations,
            edges,
        }
    }
}

/// Seed a station's stream from the scenario seed and the station id (FNV-1a).
fn station_rng(seed: u32, id: &str) -> Pcg64Mcg {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in id.bytes() {
        h = (h ^ u64::from(b)).wrapping_mul(0x0100_0000_01b3);
    }
    Pcg64Mcg::new((u128::from(seed) << 64 | u128::from(h)) | 1)
}

/// Nearest-rank percentile of sorted values, in minutes.
fn percentile(sorted: &[u64], p: f64) -> Option<f64> {
    if sorted.is_empty() {
        return None;
    }
    let rank = ((p * sorted.len() as f64).ceil() as usize).clamp(1, sorted.len());
    Some(sorted[rank - 1] as f64 / 60.0)
}
