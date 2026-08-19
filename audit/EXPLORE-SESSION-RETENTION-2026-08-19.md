# Explore-session retention — 2026-08-19

## Current behavior

The installed pi-subagents implementation distinguishes three different kinds
of persistence:

1. **Pi session persistence:** `persist_session` defaults to `false`.
   `agent-runner.ts` therefore creates `SessionManager.inMemory(effectiveCwd)`
   for the normal Explore agent. An Explore run is not a normal resumable Pi
   session unless its agent configuration explicitly opts in with
   `persist_session: true`.
2. **Run transcript persistence:** `output_transcript` defaults to `true`.
   The subagent output is written as a JSON-lines transcript below the OS temp
   directory; the README says this is independent of `persist_session` and the
   temp tree is cleared on reboot. It can be disabled globally or per custom
   agent with `output_transcript: false`.
3. **glla provenance:** glla appends a small `subagent_session` record to
   `.pi-glla/active.jsonl` containing the spawn id, agent type, summary, goal
   correlation, and timestamp. This is deliberate durable recovery metadata,
   not a saved Pi conversation.

The referenced screenshot shows `Explore#...` rows, but those identifiers are
also how pi-subagents displays Agent records/FleetView. The visual alone does
not prove that the Explore conversations are present in Pi's normal
`~/.pi/agent/sessions/` picker. The source