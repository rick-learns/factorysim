//! Browser bindings. Scenarios come in as JSON strings; snapshots go out as
//! plain JS objects.

use factory_sim::{Scenario, Sim, ValidationError};
use serde::Serialize;
use wasm_bindgen::prelude::*;

fn to_js<T: Serialize>(value: &T) -> Result<JsValue, JsError> {
    Ok(value.serialize(&serde_wasm_bindgen::Serializer::json_compatible())?)
}

fn parse(json: &str) -> Result<Scenario, Vec<ValidationError>> {
    serde_json::from_str(json).map_err(|e| {
        vec![ValidationError {
            target: None,
            message: format!("invalid scenario JSON: {e}"),
        }]
    })
}

/// Problems that stop a scenario from running; an empty array means it is valid.
#[wasm_bindgen]
pub fn validate(scenario_json: &str) -> Result<JsValue, JsError> {
    let errors = parse(scenario_json).map_or_else(|e| e, |s| factory_sim::validate(&s));
    to_js(&errors)
}

#[wasm_bindgen]
pub fn model_version() -> u32 {
    factory_sim::MODEL_VERSION
}

#[wasm_bindgen]
pub struct Simulation {
    inner: Sim,
}

#[wasm_bindgen]
impl Simulation {
    /// Throws a string listing validation errors if the scenario cannot run.
    #[wasm_bindgen(constructor)]
    pub fn new(scenario_json: &str) -> Result<Simulation, JsError> {
        let errors_to_js = |errors: Vec<ValidationError>| {
            let lines: Vec<String> = errors.iter().map(ToString::to_string).collect();
            JsError::new(&lines.join("\n"))
        };
        let scenario = parse(scenario_json).map_err(errors_to_js)?;
        let inner = Sim::new(scenario).map_err(errors_to_js)?;
        Ok(Simulation { inner })
    }

    /// Advance to `minutes` of simulated time, processing at most `max_events`.
    pub fn advance_to(&mut self, minutes: f64, max_events: u32) -> u32 {
        self.inner.advance_to(minutes, u64::from(max_events)) as u32
    }

    pub fn run_to_end(&mut self) {
        self.inner.run_to_end();
    }

    pub fn finished(&self) -> bool {
        self.inner.finished()
    }

    pub fn snapshot(&self) -> Result<JsValue, JsError> {
        to_js(&self.inner.snapshot())
    }

    pub fn series(&self) -> Result<JsValue, JsError> {
        to_js(self.inner.series())
    }
}
