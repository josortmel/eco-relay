# Integration Test Plan — EcoRelay v0.7.6 "It Just Works"

> Real CC + real OC. Zero synthetic. Each test = observable behavior in TUI.

## Prerequisites
- [ ] `bash install.sh` completed
- [ ] CC running (this session = gamma)
- [ ] OC running (2 windows: alfa + beta)
- [ ] Hub auto-started (no manual spawn)

## Test Matrix

### A: Cold Start

| # | Scenario | Action | Expected |
|---|----------|--------|----------|
| A1 | OC first, no Hub | Close CC. Kill Hub. Open OC alfa. | Hub auto-starts. alfa registers. `relay_peers` shows alfa. |
| A2 | CC joins | Open CC gamma. | gamma connects via Unix. `relay_peers` shows alfa + gamma. |
| A3 | CC first, no Hub | Close OC. Kill Hub. Open CC gamma. | Hub auto-starts. gamma registers. |
| A4 | OC joins | Open OC alfa. | alfa connects via WS. `relay_peers` shows gamma + alfa. |

### B: Cross-CLI Messaging

| # | Action | Expected |
|---|--------|----------|
| B1 | gamma: `relay_send(to="alfa", text="ping from CC")` | alfa TUI shows `[Relay · gamma]: ping from CC` |
| B2 | alfa: `relay_send(to="gamma", text="pong from OC")` | gamma receives notification |
| B3 | gamma: `relay_send(to="alfa", text="urgent!", urgent=true)` | alfa TUI shows `⚡[Relay URGENT · gamma]: urgent!` |
| B4 | alfa: `relay_inbox` | Shows message history |

### C: Multi-Session OC

| # | Action | Expected |
|---|--------|----------|
| C1 | Open OC beta (second session) | beta registers. alfa and gamma see beta in `relay_peers` |
| C2 | beta: `relay_send(to="alfa", text="hello sister")` | alfa TUI shows message |
| C3 | gamma: `relay_broadcast(question="everyone here?")` | alfa AND beta both receive broadcast |
| C4 | alfa: `relay_reply(ask_id="...", text="present!")` | gamma receives reply |

### D: Identity Persistence

| # | Action | Expected |
|---|--------|----------|
| D1 | alfa: `relay_rename("alfav2")` | Name changes. `relay_peers` shows alfav2 |
| D2 | Close OC alfa. Reopen. | alfa auto-reconnects as "alfav2" (cache hit) |
| D3 | `relay_peers` | Shows alfav2 (not session title fallback) |

### E: Error Recovery

| # | Action | Expected |
|---|--------|----------|
| E1 | Kill Hub (`pkill -f hub-daemon.ts`) | Both CC and OC detect disconnect |
| E2 | Wait 5s | Hub auto-restarted by whichever plugin wakes first. Both reconnect. |
| E3 | `relay_peers` on gamma | Shows all peers again. No data lost. |
| E4 | `relay_inbox` on alfa | Messages from during crash are in mailbox |

### F: Zero Config

| # | Check | Expected |
|---|-------|----------|
| F1 | No ECORELAY_OC_PORT set | Push still works (auto-discovered URL) |
| F2 | No ECORELAY_WS_PORT set | WS connects on default 9376 |
| F3 | No opencode.jsonc server.port | Plugin discovers URL another way or degrades gracefully |
| F4 | No manual `opencode serve` | OC TUI alone is sufficient |

## Pass Criteria

- All A1-F4: expected behavior observed
- Zero manual commands beyond opening CC/OC
- Zero env vars required
- `relay_peers` shows all peers across CLIs
- Messages delivered <2s

## Gate 2

- [ ] All tests pass → APPROVE deployment
- [ ] Any test fails → fix + re-test
