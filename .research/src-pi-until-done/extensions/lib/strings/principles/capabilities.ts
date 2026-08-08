/**
 * Sections 5 & 6 of pi-config — Dependency / capability model + Test model.
 *
 * All external systems are abstract capabilities, declared at the boundary
 * and supplied at composition time. Business logic never constructs concrete
 * dependencies inline. Tests target public interfaces only.
 */
export const CAPABILITY_INJECTION_BLOCK = [
	"Capabilities + test model (HARD — pi-config §5–6):",
	"  • Every external system is an abstract capability. Declare it at the boundary; supply concrete implementations at composition/runtime.",
	"  • Business logic MUST NOT construct concrete external dependencies inline (no `new HttpClient()` in a service method).",
	"  • Capabilities MUST be swappable for fast deterministic tests.",
	"  • Tests target public interfaces, contracts, or system boundaries — NEVER private functions, internal state, or call patterns.",
	"  • A test that could still pass while observable behavior is wrong is BROKEN. Rewrite it.",
	"  • Tests MUST be deterministic, isolated, parallel-safe, with no shared global state.",
	"  • No real external systems (DB, network, filesystem) inside unit tests unless the test is explicitly an integration/boundary test for that purpose.",
].join("\n");
