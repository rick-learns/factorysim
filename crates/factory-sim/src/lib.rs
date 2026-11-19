//! Deterministic simulator for software factories: stations of people, agents,
//! and automation connected by pass and rework routes. No LLMs; plain code.

mod engine;
mod model;
mod validate;

pub use engine::{EVENT_BUDGET, EdgeSnapshot, Series, Sim, Snapshot, StationSnapshot, Totals};
pub use model::{Edge, EdgeKind, MODEL_VERSION, Scenario, Service, Station, StationKind};
pub use validate::{MAX_HORIZON_MINUTES, ValidationError, validate};
