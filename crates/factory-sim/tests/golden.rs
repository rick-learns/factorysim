//! The bundled template must produce the same outcome everywhere. The browser
//! build checks the same expected file (see `web/scripts/golden.mjs`).

use std::path::PathBuf;

use factory_sim::{Scenario, Sim};
use serde::Deserialize;

#[derive(Deserialize)]
struct Document {
    scenario: Scenario,
}

fn fixtures() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures")
}

#[test]
fn agentic_template_matches_golden_snapshot() {
    let doc: Document = serde_json::from_str(
        &std::fs::read_to_string(fixtures().join("agentic-factory.json")).unwrap(),
    )
    .unwrap();
    let mut sim = Sim::new(doc.scenario).unwrap();
    sim.run_to_end();
    let actual = serde_json::to_value(sim.snapshot()).unwrap();

    let path = fixtures().join("agentic-factory.expected.json");
    if std::env::var_os("UPDATE_GOLDEN").is_some() {
        std::fs::write(&path, serde_json::to_string_pretty(&actual).unwrap() + "\n").unwrap();
    }
    let expected: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    assert_eq!(
        actual, expected,
        "rerun with UPDATE_GOLDEN=1 if the change is intended"
    );
}
