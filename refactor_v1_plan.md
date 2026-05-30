# Plan — Eco Relay v1.0 Multi-Platform

> **For**: Hilo (DeepSeek V4 Pro, OpenCode) — construction lead
> **From**: Prima — design lead
> **Based on**: Brief v4 + Spec v1 (4 adversarial loops, 8 reviews, both APPROVE 9.5+/10)
> **Reference**: `refactor_v1_spec.md` for component signatures, message formats, error handling

---

## Pre-Gate 0: Verification (MUST RUN FIRST)

**objetivo**: Verify that OpenCode Server API endpoints work as documented. Entire push mechanism depends on V1 passing.

**archivos_a_tocar**: None (read-only verification)

**accion**:
```bash
# OpenCode TUI auto-starts internal server. Plugin receives serverUrl at init.
# No manual port config needed. Server always running when TUI is open.

# V1: noReply injection via Plugin's internal serverUrl
# Start OC TUI, run plugin. In plugin console or via MCP tool:
#   fetch(`${serverUrl}session/${sessionId}/message`, {
#     method: "POST",
#     body: JSON.stringify({ noReply: true, parts: [{ type: "text", text: "[TEST] push OK" }] }),
#   })
# Expected: message appears in TUI conversation, no AI response triggered

# If needed for debugging, can also use curl against auto-assigned port:
# (port visible in OC startup logs or via GET {serverUrl}/global/health)
```

**pre_condiciones**: OpenCode v1.15.12 installed. No manual config needed — OC TUI auto-runs internal server.

**post_condiciones**: Verification results recorded in `verification_checkpoint.md`. If V1 fails → escalate to Pepe (design depends on it).

**tests**: Literal curl commands above. Pass = expected output matches.

**criterio_de_exito**: V1 shows message in TUI without AI response. V2 returns session ID. V3 returns MCP registrations.

**rollback**: `no_destructiva` (read-only)

**depende_de**: OpenCode v1.15.12+ installed with server.port configured

---

## Task 1: Hub WS Endpoint

**objetivo**: Add WebSocket transport to Hub daemon. Same protocol, new wire. VirtualSocket wraps WS as net.Socket-compatible EventEmitter.

**archivos_a_tocar**:
- `src/hub/ws-endpoint.ts` (NEW, ~110 LOC)
- `src/hub/index.ts` (MODIFY, ~10 LOC in sendTo + ~5 LOC StartHubOptions)

**accion**:
1. Create `src/hub/ws-endpoint.ts`:
   - `class VirtualSocket extends EventEmitter` — writable, destroyed, remoteAddress, write(), end(), destroy()
   - `function addWsEndpoint(server, registry, handleLine, opts)` — Bun.serve() with WS
   - Auth: first message `{ auth: token }` within 5s → timingSafeEqual → store hub_id
   - Bridge WS events to VirtualSocket events: message→emit("data"), close→emit("close")
   - handleLine(line, virtualSocket, send) for message routing
2. Modify `src/hub/index.ts`:
   - Add `wsPort?: number` to `StartHubOptions`
   - In `sendTo`: check if socket is VirtualSocket → use write() instead of writeLine()
   - Call `addWsEndpoint(server, registry, handleLine, { port: wsPort })` after listenWithRecovery
3. Token generation on first Hub start: `crypto.randomBytes(32).toString("hex")` → `~/.eco-relay/hub-ws-token` (chmod 0o600)

**pre_condiciones**: Hub v0.7.2 compiles. Bun runtime. `node:events`, `node:crypto` available.

**post_condiciones**: Hub starts with WS on 127.0.0.1:9376. WS clients can register as peers. Existing Unix socket path works unchanged (all 320 tests green).

**tests**:
```bash
# Unit: VirtualSocket EventEmitter contract
bun test src/hub/ws-endpoint.test.ts
# - write() returns false after destroy()
# - emit("close") fires on destroy()
# - emit("data") fires on WS message
# - remoteAddress = "127.0.0.1"

# Unit: Auth
bun test src/hub/ws-endpoint.auth.test.ts
# - Valid token → WS stays open
# - Invalid token → close 4003
# - No auth within 5s → close 4003
# - timingSafeEqual used (mock crypto)

# Regression: all existing tests
bun test
# Expected: 320+ tests PASS (zero regressions)
```

**criterio_de_exito**: WS endpoint starts, auth works, VirtualSocket passes registry socket contract, 0 regressions.

**rollback**: Delete `src/hub/ws-endpoint.ts`. Revert `src/hub/index.ts` changes. `git checkout src/hub/index.ts`.

**depende_de**: Nothing

---

## Task 2: OC Plugin — Scaffold + WS Connect + Events

**objetivo**: Create OpenCode plugin that connects to Hub WS, handles session lifecycle events.

**archivos_a_tocar**:
- `src/opencode-plugin/ecorelay.ts` (NEW, ~130 LOC for scaffold)

**accion**:
1. Create `src/opencode-plugin/ecorelay.ts`:
   - Module state: `peerBySession: Map<string, PeerConn>`, `HUB_WS_URL`, `AUTH_TOKEN`
   - `PeerConn` type: sessionId, peerName, ws, registered, messageSenders, reconnectAttempts, closed
   - `ensurePeer(session)` — creates PeerConn, does NOT connect WS (lazy)
   - `lazyConnect(sessionId)` — opens WS, sends auth, sends register, waits for ack
   - `removePeer(sessionId)` — closes WS, clears timeouts, deletes entry
   - WS reconnect: exponential backoff 3s×2^n, max 60s, 50 attempts
   - Plugin export with event listeners:
     - `session.created` → ensurePeer (root sessions only)
     - `session.deleted` → removePeer
     - `session.status` → track busy/idle locally
   - Cleanup: beforeExit, SIGINT, SIGTERM
2. Load auth token from `~/.eco-relay/hub-ws-token` or `ECORELAY_WS_TOKEN` env var
3. Bootstrap: enumerate existing root sessions on next tick (setTimeout(0))

**pre_condiciones**: Task 1 complete (Hub WS running). OpenCode v1.15.12+. Verification V1/V2/V3 passed.

**post_condiciones**: Plugin loads on OC start. WS connects on first relay_rename. Session create/delete lifecycle works.

**tests**:
```bash
# Unit: Plugin lifecycle
bun test src/opencode-plugin/ecorelay.test.ts
# - ensurePeer creates PeerConn, does NOT open WS
# - lazyConnect opens WS, sends auth, sends register
# - removePeer closes WS, clears state
# - session.created → ensurePeer called
# - session.deleted → removePeer called
# - Reconnect backoff schedule correct
```

**criterio_de_exito**: Plugin loads clean, WS connects, session lifecycle tracked.

**rollback**: Delete `src/opencode-plugin/ecorelay.ts`. Remove from `~/.opencode/plugin/`.

**depende_de**: Task 1

---

## Task 3: OC Plugin — MCP Tools (19 tools)

**objetivo**: Register all 19 relay MCP tools in the plugin. Each tool translates to Hub protocol message over WS.

**archivos_a_tocar**:
- `src/opencode-plugin/ecorelay.ts` (MODIFY, ~180 LOC added)

**accion**:
1. Implement 19 MCP tool handlers using OC's `tool()` API:
   - `relay_send` — `{ type: "send", to, text, reply_to?, urgent? }` → wait for send_ack
   - `relay_inbox` — `{ type: "inbox", limit?, since_id? }` → wait for inbox_result
   - `relay_reply` — check messageSenders map → relay_send or Hub reply (see Task 3b)
   - `relay_broadcast` — `{ type: "broadcast", question, broadcast_id, exclude_self? }`
   - `relay_peers` — `{ type: "list_peers" }` → format peer list
   - `relay_rename` — trigger lazyConnect if not connected → `{ type: "rename", new_name }`
   - `relay_join/leave/room/rooms` — room protocol messages
   - `relay_group_*` (9 tools) — group protocol messages
2. Each tool: serialize args → ws.send(JSON.stringify(msg)) → wait for response on message queue → format output
3. Request/response correlation: req_id numbering
4. `callerPeer(ctx)` helper: extracts peerName from ctx.sessionID → peerBySession

**pre_condiciones**: Task 2 complete (WS connected, events working).

**post_condiciones**: All 19 tools functional. Same tool behavior as Channel CC.

**tests**:
```bash
bun test src/opencode-plugin/ecorelay.tools.test.ts
# - relay_send → correct Hub message { type: "send", to, text }
# - relay_send with reply_to → includes reply_to field
# - relay_send with urgent → includes urgent: true
# - relay_inbox → correct Hub message { type: "inbox" }
# - relay_rename → triggers lazyConnect, sends { type: "rename", new_name }
# - relay_broadcast → generates broadcast_id, waits for broadcast_ack
# - All 19 tools registered in tool() API
```

**criterio_de_exito**: All 19 tools return same results as Channel CC equivalents.

**rollback**: Remove tool registration block from plugin. `relay_rename` still triggers connect.

**depende_de**: Task 2

---

## Task 4: OC Plugin — Push Delivery + Ping/Pong

**objetivo**: Deliver all 6 Hub message types to OC sessions via push. Handle Hub ping/pong.

**archivos_a_tocar**:
- `src/opencode-plugin/ecorelay.ts` (MODIFY, ~100 LOC added)

**accion**:
1. `handleHubMessage(conn, raw)` — JSON.parse with try/catch, route by msg.type
2. Format functions:
   - `formatMessage(msg)` — `[Relay · {from}]: {text}` or `⚡[Relay URGENT · {from}]: {text}`
   - `formatBroadcast(msg)` — `[broadcast · {from}]: {question}`
   - `formatReply(msg)` — `[reply · {from}]: {text}`
   - `formatRoom(msg)` — `[room:{name} · {from}]: {text}`
   - `formatGroup(msg)` — `[group:{name} · {from}]: {text}`
3. `pushToSession(sessionId, text, retries=3)` — POST to OC Server API with backoff
4. Ping handler: auto-reply `{ type: "pong", req_id }`

**pre_condiciones**: Task 3 complete. OC Server API accessible (verification V1 passed).

**post_condiciones**: All 6 message types delivered as push. Hub sweep doesn't kill plugin.

**tests**:
```bash
bun test src/opencode-plugin/ecorelay.push.test.ts
# - incoming_message → "Relay · from: text"
# - incoming_message urgent → "⚡URGENT · from: text"
# - incoming_ask → "broadcast · from: question"
# - incoming_reply → "reply · from: text"
# - incoming_room_msg → "room:name · from: text"
# - incoming_group_msg → "group:name · from: text"
# - ping → pong reply
# - pushToSession retry: 4xx → false, network → retry, 3 retries exhausted → false
# - Malformed JSON → logged, message ignored
```

**criterio_de_exito**: Push delivers all 6 types. Urgent preserved. Ping/pong works. Retry with backoff.

**rollback**: Remove handleHubMessage dispatch. Plugin still connects but doesn't deliver push.

**depende_de**: Task 3

---

## Task 5: OC Plugin — peer_id Persistence + Agent Instructions

**objetivo**: Cache peer identity across OC restarts. Inject relay behavior instructions into agent context.

**archivos_a_tocar**:
- `src/opencode-plugin/ecorelay.ts` (MODIFY, ~60 LOC added)

**accion**:
1. Peer ID cache:
   - Cache file: `~/.cache/ecorelay/peer-ids.json`
   - Atomic write: temp file + `fs.renameSync(temp, target)`
   - `loadPeerId(sessionId)` → name or null
   - `savePeerId(sessionId, name)` — skip if unchanged
   - Key: `{projectPath}#{sessionId}`
2. Agent instructions:
   - INSTRUCTIONS constant with full behavioral rules
   - Injected via `experimental.chat.system.transform` hook
   - Content: quote-first-then-act, urgent priority, relay_reply BEFORE other work, relay_send vs relay_broadcast, question-back surfacing, trust tool defaults, rooms semantics

**pre_condiciones**: Tasks 3-4 complete.

**post_condiciones**: Peer names survive OC restart. Agent receives relay instructions in context.

**tests**:
```bash
bun test src/opencode-plugin/ecorelay.persistence.test.ts
# - savePeerId writes to cache with tmp+rename
# - loadPeerId returns saved name
# - Cache miss → null
# - Malformed cache → returns null (no crash)
# - Name unchanged → no write

bun test src/opencode-plugin/ecorelay.instructions.test.ts
# - INSTRUCTIONS constant matches v4 §3.7 text
# - Injected via chat.system.transform hook
# - Contains all 9 behavioral rules from CC INSTRUCTIONS
```

**criterio_de_exito**: Peer name survives restart. Instructions reach agent.

**rollback**: Delete cache file. Remove instructions hook.

**depende_de**: Task 3, Task 4

---

## Task 6: Unit Tests — WS Endpoint + Plugin (~48 tests)

**objetivo**: Comprehensive unit test suite covering VirtualSocket, auth, Hub WS routing, plugin lifecycle, tools, push, and persistence.

**archivos_a_tocar**:
- `src/hub/ws-endpoint.test.ts` (NEW, ~15 tests)
- `src/hub/ws-endpoint.auth.test.ts` (NEW, ~5 tests)
- `src/opencode-plugin/ecorelay.test.ts` (NEW, ~6 tests)
- `src/opencode-plugin/ecorelay.tools.test.ts` (NEW, ~8 tests)
- `src/opencode-plugin/ecorelay.push.test.ts` (NEW, ~8 tests)
- `src/opencode-plugin/ecorelay.persistence.test.ts` (NEW, ~4 tests)
- `src/opencode-plugin/ecorelay.instructions.test.ts` (NEW, ~2 tests)

**accion**:
1. Write tests using existing eco-relay test patterns (`src/test-helpers.ts`, `src/channel/test-helpers.ts`)
2. Mock Hub for plugin tests (in-process startHub with test socket)
3. Mock OC Server API for push tests
4. All tests callable via `bun test`

**pre_condiciones**: Tasks 1-5 complete.

**post_condiciones**: ~48 new tests pass. Combined with 320 existing = ~368 total tests pass.

**tests**: The test suite itself is the deliverable. `bun test` must pass.

**criterio_de_exito**: `bun test` → all tests green. Coverage: VirtualSocket contract, auth flow, plugin lifecycle, 19 tools, all 6 push types, persistence, instructions.

**rollback**: Delete new test files. Existing 320 tests unaffected.

**depende_de**: Tasks 1, 2, 3, 4, 5

---

## Task 7: Integration Test

**objetivo**: End-to-end cross-CLI messaging: CC ↔ OC via Hub.

**archivos_a_tocar**: None (runtime test only)

**accion**:
```bash
# Terminal 1: Hub
bun run src/hub-daemon.ts

# Terminal 2: OC session A (peer "alfa")
opencode  # Plugin auto-installed, serverUrl auto-provided by OC
> llámame alfa
> relay_peers  # shows itself

# Terminal 3: OC session B (peer "beta")
opencode  # OC auto-assigns port internally, zero manual config
> llámame beta
> relay_send(to="alfa", text="ping desde beta")
# → alfa receives "[Relay · beta]: ping desde beta" ✅

# Terminal 4: CC session (peer "gamma")
claude
> relay_send(to="alfa", text="ping cross-CLI")
# → alfa receives "[Relay · gamma]: ping cross-CLI" ✅

# Test 2: reply
# Session B:
> relay_reply(ask_id="{msg_id}", text="pong!")
# → gamma receives reply ✅

# Test 3: broadcast
# Session gamma:
> relay_broadcast(question="¿todos online?")
# → alfa and beta both receive broadcast ✅

# Test 4: rename
# Session B:
> relay_rename("betav2")
> relay_send(to="alfav2", text="nuevo nombre")
# → delivered with new name ✅
```

**pre_condiciones**: Tasks 1-6 complete. All tests green. OC server.port configured.

**post_condiciones**: Cross-CLI messaging verified. Push delivery confirmed in OC TUI.

**tests**: Manual integration test steps above. Each step = observable behavior.

**criterio_de_exito**: CC → OC push works. OC → CC push works. Broadcast reaches all. Rename works across CLIs.

**rollback**: `no_destructiva` (runtime test, no code changes)

**depende_de**: Tasks 1, 2, 3, 4, 5, 6

---

## Task 8: Installation Script + Docs

**objetivo**: One-command plugin installation. Update README with multi-platform docs.

**archivos_a_tocar**:
- `scripts/install-opencode-plugin.sh` (NEW, ~20 LOC)
- `README.md` (MODIFY, add multi-platform section)
- `CHANGELOG.md` (MODIFY, add v1.0 entry)

**accion**:
1. Install script: copies `ecorelay.ts` to `~/.opencode/plugin/`, prints instructions
2. README: new "Multi-Platform" section under Architecture
3. CHANGELOG: v1.0.0 entry — cross-CLI messaging, OC Plugin, Hub WS endpoint

**pre_condiciones**: Task 7 complete.

**post_condiciones**: Plugin installable with one command. Docs reflect v1.0 capabilities.

**tests**: `bash scripts/install-opencode-plugin.sh` → plugin appears in `~/.opencode/plugin/ecorelay.ts`

**criterio_de_exito**: Install script works. README explains OC setup.

**rollback**: Revert README/CHANGELOG. Delete install script.

**depende_de**: Task 7

---

## Dependency Graph

```
Gate 0 (Verification)
  │
  ▼
Task 1 (Hub WS) ──────────────────────┐
  │                                   │
  ▼                                   │
Task 2 (Plugin scaffold)              │
  │                                   │
  ▼                                   │
Task 3 (MCP tools) ───┐               │
  │                   │               │
  ▼                   ▼               │
Task 4 (Push delivery)                │
  │                                   │
  ▼                                   │
Task 5 (Persistence + Instructions)   │
  │                                   │
  ▼                                   │
Task 6 (Unit tests) ◄─────────────────┘
  │
  ▼
Task 7 (Integration test)
  │
  ▼
Task 8 (Install script + Docs)
```

## Time Estimates

| Task | Est. time | Accumulated |
|------|-----------|-------------|
| Gate 0 | 20 min | 20 min |
| Task 1 | 2h | 2h 20min |
| Task 2 | 1h | 3h 20min |
| Task 3 | 3h | 6h 20min |
| Task 4 | 1.5h | 7h 50min |
| Task 5 | 1h | 8h 50min |
| Task 6 | 2h | 10h 50min |
| Task 7 | 1h | 11h 50min |
| Task 8 | 30 min | 12h 20min |

**Total**: ~12.5h (2-3 days with review)
