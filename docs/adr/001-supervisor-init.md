# ADR 001 — Supervisor Initialization: Spec vs Imperative

## Status
Resolved — spec not needed for Phase 1–4.

## Decision
Phase 1 Supervisor uses an **imperative API** (`spawn()`, `spawnSupervisor()`). There is no static child spec.

Restart works recursively: each child (actor or sub-supervisor) implements `restart()`. Actor records hold the original `fn` + `options` to recreate the actor. Sub-supervisors delegate `restart()` down to their own children. No spec required.

## When a spec would matter
Only if the supervisor tree needs to be **recreated from nothing** — e.g. deserializing from config after a full process crash. That is a distributed systems / persistence concern outside the current scope.

## Future direction
If Phase 4+ requires cross-process or cross-machine supervisor trees, revisit a declarative spec format. The imperative API remains for dynamic actors (e.g. per-request workers).
