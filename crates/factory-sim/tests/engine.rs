use factory_sim::{Edge, EdgeKind, Scenario, Service, Sim, Station, StationKind, validate};

fn station(id: &str, workers: u32, service: Service) -> Station {
    Station {
        id: id.into(),
        name: id.into(),
        kind: StationKind::Agent,
        workers,
        service,
        cost_per_task: 0.0,
        cost_per_hour: 0.0,
        defect_rate: 0.0,
        detection_rate: 0.0,
    }
}

fn edge(from: &str, to: &str, kind: EdgeKind) -> Edge {
    Edge {
        id: format!("{from}-{to}"),
        from: from.into(),
        to: to.into(),
        kind,
    }
}

fn constant(minutes: f64) -> Service {
    Service::Constant { minutes }
}

fn scenario(stations: Vec<Station>, edges: Vec<Edge>) -> Scenario {
    Scenario {
        model_version: factory_sim::MODEL_VERSION,
        seed: 7,
        horizon_minutes: 100.0,
        arrival_interval_minutes: 10.0,
        wip_limit: None,
        max_rework: 3,
        entry: stations[0].id.clone(),
        stations,
        edges,
    }
}

/// Spec -> Code -> Review -> CI with rework from review and CI back to code.
fn factory(seed: u32) -> Scenario {
    let tri = |min, mode, max| Service::Triangular { min, mode, max };
    let mut code = station("code", 3, tri(20.0, 45.0, 120.0));
    code.defect_rate = 0.3;
    code.cost_per_task = 2.0;
    let mut review = station("review", 1, tri(5.0, 15.0, 40.0));
    review.detection_rate = 0.6;
    review.cost_per_hour = 90.0;
    let mut ci = station("ci", 4, tri(8.0, 10.0, 25.0));
    ci.detection_rate = 0.5;
    let mut s = scenario(
        vec![station("spec", 1, tri(5.0, 10.0, 30.0)), code, review, ci],
        vec![
            edge("spec", "code", EdgeKind::Pass),
            edge("code", "review", EdgeKind::Pass),
            edge("review", "ci", EdgeKind::Pass),
            edge("review", "code", EdgeKind::Rework),
            edge("ci", "code", EdgeKind::Rework),
        ],
    );
    s.seed = seed;
    s.horizon_minutes = 60.0 * 24.0 * 5.0;
    s.arrival_interval_minutes = 18.0;
    s
}

fn run(s: Scenario) -> Sim {
    let mut sim = Sim::new(s).expect("valid scenario");
    sim.run_to_end();
    sim
}

#[test]
fn constant_single_station_has_exact_throughput() {
    let sim = run(scenario(vec![station("a", 1, constant(5.0))], vec![]));
    let snap = sim.snapshot();
    // Arrivals at 0, 10, ..., 90 each finish 5 minutes later.
    assert_eq!(snap.totals.arrived, 10);
    assert_eq!(snap.totals.shipped, 10);
    assert_eq!(snap.totals.lead_time_p50_minutes, Some(5.0));
    assert!((snap.stations[0].utilization - 0.5).abs() < 1e-9);
    assert!(snap.finished);
}

#[test]
fn slow_station_builds_a_queue() {
    let sim = run(scenario(vec![station("a", 1, constant(25.0))], vec![]));
    let snap = sim.snapshot();
    assert_eq!(snap.totals.shipped, 4);
    assert!(snap.stations[0].queue > 0);
    assert_eq!(snap.totals.wip, snap.totals.arrived - snap.totals.shipped);
}

#[test]
fn same_seed_same_outcome_and_different_seed_differs() {
    let a = run(factory(1)).snapshot();
    let b = run(factory(1)).snapshot();
    let c = run(factory(2)).snapshot();
    assert_eq!(a, b);
    assert_ne!(a.totals, c.totals);
}

#[test]
fn stepping_in_small_slices_matches_one_big_run() {
    let whole = run(factory(3));
    let mut sliced = Sim::new(factory(3)).unwrap();
    let mut t = 0.0;
    while !sliced.finished() {
        t += 7.5;
        sliced.advance_to(t, 3);
        sliced.advance_to(t, u64::MAX);
    }
    assert_eq!(whole.snapshot(), sliced.snapshot());
    assert_eq!(whole.series(), sliced.series());
}

#[test]
fn wip_limit_holds_extra_work_in_the_backlog() {
    let mut s = factory(4);
    s.wip_limit = Some(5);
    let mut sim = Sim::new(s).unwrap();
    let mut t = 0.0;
    let mut saw_backlog = false;
    while !sim.finished() {
        t += 30.0;
        sim.advance_to(t, u64::MAX);
        let snap = sim.snapshot();
        assert!(snap.totals.wip <= 5);
        saw_backlog |= snap.totals.backlog > 0;
    }
    assert!(saw_backlog);
    assert!(sim.series().wip.iter().all(|&w| w <= 5));
}

#[test]
fn caught_defects_loop_until_the_rework_cap_then_escape() {
    let mut code = station("code", 1, constant(1.0));
    code.defect_rate = 1.0;
    let mut review = station("review", 1, constant(1.0));
    review.detection_rate = 1.0;
    let mut s = scenario(
        vec![code, review],
        vec![
            edge("code", "review", EdgeKind::Pass),
            edge("review", "code", EdgeKind::Rework),
        ],
    );
    s.horizon_minutes = 1000.0;
    s.arrival_interval_minutes = 100.0;
    s.max_rework = 2;
    let snap = run(s).snapshot();
    let t = &snap.totals;
    assert_eq!(t.shipped, 10);
    assert_eq!(t.reworks, 20);
    assert_eq!(t.rework_cap_hits, 10);
    assert_eq!(t.defects_escaped, 10);
    // code ran 3 times per item, review 3 times per item.
    assert_eq!(snap.stations[0].completed, 30);
    assert_eq!(snap.edges[1].moved, 20);
}

#[test]
fn costs_add_up() {
    let mut a = station("a", 1, constant(30.0));
    a.cost_per_task = 1.0;
    a.cost_per_hour = 10.0;
    let mut s = scenario(vec![a], vec![]);
    s.arrival_interval_minutes = 40.0;
    let snap = run(s).snapshot();
    // Items start at 0, 40, 80, each costing 1 + 10 * 0.5.
    assert!((snap.totals.cost - 18.0).abs() < 1e-9);
}

#[test]
fn validation_rejects_broken_graphs_but_allows_rework_cycles() {
    assert!(validate(&factory(1)).is_empty());

    let mut s = factory(1);
    s.edges.push(edge("ci", "spec", EdgeKind::Pass));
    let errs = validate(&s);
    assert!(errs.iter().any(|e| e.message.contains("loop")), "{errs:?}");

    let mut s = factory(1);
    s.edges.retain(|e| e.id != "ci-code");
    assert!(
        validate(&s)
            .iter()
            .any(|e| e.target.as_deref() == Some("ci"))
    );

    let mut s = factory(1);
    s.edges.push(edge("code", "nowhere", EdgeKind::Pass));
    assert!(!validate(&s).is_empty());

    let mut s = factory(1);
    s.edges.push(edge("code", "ci", EdgeKind::Pass));
    assert!(
        validate(&s)
            .iter()
            .any(|e| e.message.contains("more than one"))
    );

    let mut s = factory(1);
    s.stations[0].workers = 0;
    s.entry = "missing".into();
    assert_eq!(validate(&s).len(), 2);
}

#[test]
fn scenario_json_round_trips() {
    let s = factory(9);
    let json = serde_json::to_string(&s).unwrap();
    let back: Scenario = serde_json::from_str(&json).unwrap();
    assert_eq!(s, back);
}
