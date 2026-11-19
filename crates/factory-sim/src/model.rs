//! Scenario description: what the user builds in the editor.
//!
//! All user-facing durations are in minutes. The engine converts them to whole
//! seconds so event ordering never depends on floating-point comparisons.

use serde::{Deserialize, Serialize};

/// Bumped whenever a change to the engine can change the outcome of a seeded run.
pub const MODEL_VERSION: u32 = 1;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Scenario {
    #[serde(default = "default_model_version")]
    pub model_version: u32,
    pub seed: u32,
    pub horizon_minutes: f64,
    /// A new work item arrives at the entry station every this many minutes.
    pub arrival_interval_minutes: f64,
    /// Maximum items inside the factory at once. Extra arrivals wait in a backlog.
    #[serde(default)]
    pub wip_limit: Option<u32>,
    /// After this many trips back for rework, an item ships even if a defect is caught.
    pub max_rework: u32,
    /// Station that new work enters.
    pub entry: String,
    pub stations: Vec<Station>,
    pub edges: Vec<Edge>,
}

fn default_model_version() -> u32 {
    MODEL_VERSION
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Station {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub kind: StationKind,
    /// Parallel workers (people, agents, or CI runners).
    pub workers: u32,
    pub service: Service,
    /// Flat cost charged every time a worker starts an item (e.g. tokens per attempt).
    #[serde(default)]
    pub cost_per_task: f64,
    /// Cost per busy hour (e.g. salary or runner time).
    #[serde(default)]
    pub cost_per_hour: f64,
    /// Chance that this station's work introduces a hidden defect.
    #[serde(default)]
    pub defect_rate: f64,
    /// Chance that this station catches a hidden defect and sends the item back.
    #[serde(default)]
    pub detection_rate: f64,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum StationKind {
    #[default]
    Human,
    Agent,
    Automation,
}

/// How long one attempt at a station takes, in minutes.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Service {
    Constant { minutes: f64 },
    Triangular { min: f64, mode: f64, max: f64 },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Edge {
    pub id: String,
    pub from: String,
    pub to: String,
    pub kind: EdgeKind,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum EdgeKind {
    /// Where work goes when it passes this station. No pass edge means "shipped".
    Pass,
    /// Where work goes when this station catches a defect.
    Rework,
}
