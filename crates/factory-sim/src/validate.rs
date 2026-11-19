//! Structural checks that keep a scenario runnable. Rework cycles are allowed;
//! cycles made only of pass edges are not, because work would never ship.

use std::collections::HashMap;
use std::fmt;

use serde::Serialize;

use crate::model::{EdgeKind, Scenario, Service};

/// Upper bound on simulated time, so a pasted scenario cannot overflow the clock.
pub const MAX_HORIZON_MINUTES: f64 = 60.0 * 24.0 * 365.0;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct ValidationError {
    /// Station or edge id the problem belongs to, when there is one.
    pub target: Option<String>,
    pub message: String,
}

impl fmt::Display for ValidationError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match &self.target {
            Some(t) => write!(f, "{t}: {}", self.message),
            None => f.write_str(&self.message),
        }
    }
}

impl std::error::Error for ValidationError {}

pub fn validate(s: &Scenario) -> Vec<ValidationError> {
    let mut errors = Vec::new();
    let mut err = |target: Option<&str>, message: String| {
        errors.push(ValidationError {
            target: target.map(str::to_owned),
            message,
        })
    };

    if s.model_version != crate::MODEL_VERSION {
        err(
            None,
            format!(
                "scenario is for model version {}, this engine is version {}",
                s.model_version,
                crate::MODEL_VERSION
            ),
        );
    }
    if !(s.horizon_minutes > 0.0 && s.horizon_minutes <= MAX_HORIZON_MINUTES) {
        err(
            None,
            format!("horizon must be between 0 and {MAX_HORIZON_MINUTES} minutes"),
        );
    }
    if !(s.arrival_interval_minutes >= 1.0 / 60.0 && s.arrival_interval_minutes.is_finite()) {
        err(None, "arrival interval must be at least one second".into());
    }
    if s.wip_limit == Some(0) {
        err(
            None,
            "WIP limit must be at least 1 (leave it empty for no limit)".into(),
        );
    }

    let mut index = HashMap::new();
    for (i, st) in s.stations.iter().enumerate() {
        if index.insert(st.id.as_str(), i).is_some() {
            err(Some(&st.id), "duplicate station id".into());
        }
        let id = Some(st.id.as_str());
        if st.workers == 0 {
            err(id, "needs at least one worker".into());
        }
        match st.service {
            Service::Constant { minutes } => {
                if !(0.0..=MAX_HORIZON_MINUTES).contains(&minutes) {
                    err(
                        id,
                        "service time must be between 0 and the max horizon".into(),
                    );
                }
            }
            Service::Triangular { min, mode, max } => {
                if !(min >= 0.0 && min <= mode && mode <= max && max <= MAX_HORIZON_MINUTES) {
                    err(id, "service time needs 0 ≤ min ≤ most likely ≤ max".into());
                }
            }
        }
        for (name, p) in [
            ("defect rate", st.defect_rate),
            ("detection rate", st.detection_rate),
        ] {
            if !(0.0..=1.0).contains(&p) {
                err(id, format!("{name} must be between 0 and 1"));
            }
        }
        for (name, c) in [
            ("cost per task", st.cost_per_task),
            ("cost per hour", st.cost_per_hour),
        ] {
            if !(c >= 0.0 && c.is_finite()) {
                err(id, format!("{name} must be zero or more"));
            }
        }
    }

    if !index.contains_key(s.entry.as_str()) {
        err(None, format!("entry station '{}' does not exist", s.entry));
    }

    let mut edge_ids = HashMap::new();
    let mut pass_out: HashMap<&str, &str> = HashMap::new();
    let mut rework_out: HashMap<&str, &str> = HashMap::new();
    for e in &s.edges {
        let id = Some(e.id.as_str());
        if edge_ids.insert(e.id.as_str(), ()).is_some() {
            err(id, "duplicate edge id".into());
        }
        if !index.contains_key(e.from.as_str()) || !index.contains_key(e.to.as_str()) {
            err(id, "connects to a station that does not exist".into());
            continue;
        }
        let outs = match e.kind {
            EdgeKind::Pass => &mut pass_out,
            EdgeKind::Rework => &mut rework_out,
        };
        if outs.insert(e.from.as_str(), e.to.as_str()).is_some() {
            let kind = match e.kind {
                EdgeKind::Pass => "pass",
                EdgeKind::Rework => "rework",
            };
            err(Some(&e.from), format!("has more than one {kind} route"));
        }
    }

    for st in &s.stations {
        if st.detection_rate > 0.0 && !rework_out.contains_key(st.id.as_str()) {
            err(
                Some(&st.id),
                "catches defects but has no rework route to send them back".into(),
            );
        }
    }

    // Each station has at most one pass edge, so following them from any
    // station either ends at a shipping station or loops.
    for st in &s.stations {
        let mut seen = vec![st.id.as_str()];
        let mut at = st.id.as_str();
        while let Some(&next) = pass_out.get(at) {
            if seen.contains(&next) {
                if next == st.id {
                    err(
                        Some(&st.id),
                        "pass routes form a loop, so work would never ship".into(),
                    );
                }
                break;
            }
            seen.push(next);
            at = next;
        }
    }

    errors
}
