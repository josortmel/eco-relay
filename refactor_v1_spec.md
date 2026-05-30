# Spec — Eco Relay v1.0 Multi-Platform

## 1. Reference to Brief and verification_checkpoint

- **Brief**: `F:\obsidian\GuildWars\Eco_Consulting\Faro\Informes\Diseño\Eco_relay\2026-05-29_relay_v1.0_multiplatform_design_v4_FINAL.md`
- **verification_checkpoint**: `C:\Users\Admin\Documents\EcoRelay\verification_checkpoint.md` (run before Gate 1)
- **Date**: 2026-05-29
- **Review chain**: 4 adversarial loops × 2 architectures (Opus + DeepSeek) = 8 reviews. Both APPROVE @ 9.5+/10.

## 2. Architecture — What Gets Built

```
ECO RELAY HUB (v0.7.2, unchanged core)
Unix socket: /tmp/eco-relay-hub.sock
NEW: WS endpoint ws://127.0.0.1:9376
     │
     ├── Channel CC (v0.7.2, ZERO changes)
     │
     └── OC Plugin (~450 LOC, NEW)
          · Lives inside OpenCode runtime
          · Connects to Hub via WebSocket
          · Receives OC events (session.*)
          · Registers 19 MCP tools
          · Push via POST /session/:id/message (noReply: true)
```

## 3. Component Signatures

### 3.1 Hub WS Endpoint (`src/hub/ws-endpoint.ts`)

```typescript
// NEW FILE — ~110 LOC
// Added to startHub(): if wsPort is set, starts WS server alongside Unix socket

import { EventEmitter } from "node:events";

class VirtualSocket extends EventEmitter {
  writable: boolean;         // true while WS open, false after close
  destroyed: boolean;        // true after destroy()
  remoteAddress: string;     // "127.0.0.1"
  
  constructor(ws: ServerWebSocket);
  write(data: string): boolean;  // ws.send(), returns false if destroyed
  end(): void;                   // ws.close()
  destroy(): void;               // set destroyed, close WS, emit "close"
}

function addWsEndpoint(
  server: net.Server,
  registry: PeerRegistry,
  handleLine: Handler,
  opts: { port: number }
): { close: () => Promise<void> };

// WS lifecycle:
// ws.on("open")   → create VirtualSocket, set auth timer (5s)
// ws.on("message") → if no hub_id: validate auth token via timingSafeEqual
//                    → store hub_id, clear auth timer
//                    → if has hub_id: emit "data" on VirtualSocket → handleLine
// ws.on("close")   → VirtualSocket.destroy() → registry.removeBySocket()

// Auth:
// Token: crypto.randomBytes(32).toString("hex")
// Stored: ~/.eco-relay/hub-ws-token (chmod 0o600)
// Env override: ECORELAY_WS_TOKEN
// First WS message: { auth: "<token>" }
// Comparison: crypto.timingSafeEqual(Buffer.from(received), Buffer.from(stored))
// No valid token within 5s → close 4003
```

### 3.2 sendTo() Dispatch Update (`src/hub/index.ts`)

```typescript
// In startHub(), sendTo function gains WS routing (~10 LOC):
const sendTo = (name: string, msg: ServerMsg): boolean => {
  const s = registry.getSocket(name);
  if (s) {
    try {
      if (s instanceof VirtualSocket) {
        s.write(JSON.stringify(msg));  // WS write
      } else {
        writeLine(s, msg);              // Unix socket write
      }
      return true;
    } catch { return false; }
  }
  if (bridge) return bridge.sendForward(name, msg);
  return false;
};
```

### 3.3 OC Plugin (`src/opencode-plugin/ecorelay.ts`)

```typescript
// NEW FILE — ~450 LOC
// Plugin entry point for OpenCode. TypeScript, runs inside OC's Node.js process.

type PeerConn = {
  sessionId: string;
  sessionTitle: string | null;
  peerName: string;
  ws: WebSocket | null;
  registered: boolean;
  messageSenders: Map<string, string>;  // msg_id → sender_name
  reconnectTimeout: ReturnType<typeof setTimeout> | null;
  reconnectAttempts: number;
  closed: boolean;
};

// Module-level state
const peerBySession: Map<string, PeerConn>;  // sessionId → PeerConn
const HUB_WS_URL = process.env.ECORELAY_WS_URL || "ws://127.0.0.1:9376";
const MAX_RECONNECT_ATTEMPTS = 50;

// Auth token — lazy, read at connect time (Hub may not have started yet)
function getAuthToken(): string;
  // Reads ~/.eco-relay/hub-ws-token or ECORELAY_WS_TOKEN env var
  // Called inside lazyConnect(), not at module load time

// --- Session lifecycle ---
function ensurePeer(session: { id: string; title?: string | null }): void;
  // Creates PeerConn, does NOT connect WS (lazy)

function lazyConnect(sessionId: string): Promise<void>;
  // Triggered by: (a) first relay_rename call, OR
  //               (b) session.created if peer_name found in PEER_ID_CACHE
  // 1. Open WS to HUB_WS_URL
  // 2. Send: { auth: getAuthToken() }
  // 3. Send: { type: "register", name, cwd, git_branch, protocol_version: "5" }
  // 4. Wait for { type: "ack" }
  // 5. peerBySession[sessionId].registered = true

function removePeer(sessionId: string): void;
  // Close WS, clear timeouts, delete from peerBySession

// --- WS message handling ---
function handleHubMessage(conn: PeerConn, raw: string): void;
  // Parse JSON (try/catch, return on error)
  // Route by msg.type:
  //   "incoming_message" → pushToSession(conn, formatMessage(msg))
  //   "incoming_ask"     → pushToSession(conn, formatBroadcast(msg))
  //   "incoming_reply"   → pushToSession(conn, formatReply(msg))
  //   "incoming_room_msg"→ pushToSession(conn, formatRoom(msg))
  //   "incoming_group_msg"→ pushToSession(conn, formatGroup(msg))
  //   "broadcast_ack"    → logged
  //   "ping"             → ws.send({ type: "pong", req_id })
  //   "ack"/"err"/"send_ack"/"inbox_result"/"peers"/"rooms_list" → route to pending request resolver

// --- Push delivery ---
function formatMessage(msg): string;
  // urgent → "⚡[Relay URGENT · {from}]: {text}"
  // normal → "[Relay · {from}]: {text}"

function formatBroadcast(msg): string;
  // "[broadcast · {from}]: {question}"

function formatReply(msg): string;
  // "[reply · {from}]: {text}"

function formatRoom(msg): string;
  // "[room:{name} · {from}]: {text}"

function formatGroup(msg): string;
  // "[group:{name} · {from}]: {text}"

let serverUrl: string;  // Provided by OC at plugin init. No manual config.
  // "When you run opencode it starts a TUI and a server. The TUI is the client
  //  that talks to the server." — OpenCode docs. Server is always running.

async function pushToSession(sessionId: string, text: string, retries = 3): Promise<boolean>;
  // POST {serverUrl}/session/{id}/message { noReply: true, parts: [{ type: "text", text }] }
  // serverUrl = auto-provided by OC at Plugin init (rest.serverUrl). Zero config.
  // 4xx → return false (no retry)
  // 5xx/network → retry with backoff (1s, 2s, 3s)
  // signal: AbortSignal.timeout(3000)

// --- MCP tools (19) ---
// Registered via OC tool() API
// Each tool = fetch() to Hub WS + wait for response + format output
// relay_send, relay_inbox, relay_reply, relay_broadcast, relay_peers,
// relay_rename, relay_join, relay_leave, relay_room, relay_rooms,
// relay_group_create/invite/remove/leave/send/history/list/info/delete

function relayReply(args: { ask_id: string; text: string }, ctx): Promise<string>;
  // 1. Check conn.messageSenders for ask_id → sender_name
  // 2. If found → relaySend({ to: sender_name, text, reply_to: ask_id })
  // 3. If not found → ws.send({ type: "reply", ask_id, text }) → Hub discards

// --- Ping/Pong ---
// Hub ping → ws.send({ type: "pong", req_id }) automatically

// --- peer_id persistence ---
const PEER_ID_CACHE: string;  // ~/.cache/ecorelay/peer-ids.json
function loadPeerId(sessionId: string): string | null;
function savePeerId(sessionId: string, peerId: string): void;
  // Atomic write: temp file + fs.renameSync(temp, target)

// --- Instructions ---
const INSTRUCTIONS: string;
  // Injected into agent context. Content from v4 §3.7.
  // Tells agent: quote-first-then-act, urgent priority, relay_reply BEFORE other work,
  // relay_send vs relay_broadcast, question-back surfacing, trust tool defaults.

// --- Plugin export ---
export const EcoRelayPlugin: Plugin = async ({ client, directory }) => {
  // Bootstrap: enumerate existing root sessions on next tick (setTimeout(0))
  // Register event listeners: session.created, session.deleted, session.status
  // Register 19 MCP tools
  // Register "experimental.chat.system.transform" for INSTRUCTIONS injection
  // Cleanup on beforeExit/SIGINT/SIGTERM
};
```

## 4. Real Examples

### Example 1: Cross-CLI Direct Message

```
Input (CC session "frontend", via relay_send MCP):
  relay_send(to="alfa", text="¿cambió el token de la API?")

Hub processing:
  1. handleSend → mailbox.addMessage("alfa", "frontend", "¿cambió el token de la API?", null, false)
  2. sendTo("alfa", { type: "incoming_message", msg_id: "m-abc123", from: "frontend", text: "¿cambió el token de la API?" })
  3. Registry finds WS socket for "alfa" → writes JSON over WS

Plugin processing:
  1. handleHubMessage receives incoming_message
  2. formatMessage → "[Relay · frontend]: ¿cambió el token de la API?"
  3. pushToSession(alfaSessionId, text) → POST to OC Server API

Output (OC session "alfa", in conversation):
  [Relay · frontend]: ¿cambió el token de la API?
  (AI sees this as context on next turn)
```

### Example 2: Urgent Cross-CLI

```
Input (CC session "gamma", urgent):
  relay_send(to="beta", text="¡Pepe necesita el reporte YA!", urgent=true)

Hub processing:
  1. mailbox.addMessage("beta", "gamma", "¡Pepe necesita el reporte YA!", null, true)
  2. sendTo("beta", { type: "incoming_message", msg_id: "m-def456", from: "gamma", text: "¡Pepe necesita el reporte YA!", urgent: true })

Plugin processing:
  1. formatMessage with urgent=true → "⚡[Relay URGENT · gamma]: ¡Pepe necesita el reporte YA!"
  2. pushToSession(betaSessionId, text)

Output (OC session "beta"):
  ⚡[Relay URGENT · gamma]: ¡Pepe necesita el reporte YA!
  (AI instructions: "act on them BEFORE other work")
```

### Example 3: Broadcast

```
Input (CC session "eco"):
  relay_broadcast(question="¿Alguien ha visto el bug del mailbox?")

Hub processing:
  1. handleBroadcast → for each peer: incoming_ask with ask_id = "bcast-X:peerName"
  2. Delivered to all connected peers (CC and OC)

Plugin processing (per peer):
  1. handleHubMessage receives incoming_ask
  2. formatBroadcast → "[broadcast · eco]: ¿Alguien ha visto el bug del mailbox?"

Output (all OC sessions):
  [broadcast · eco]: ¿Alguien ha visto el bug del mailbox?
  (AI instructions: "Reply with relay_reply(ask_id, text) BEFORE handling other work")

Note: cross-CLI broadcast replies are Tier 2 (v1.1). The OC agent receives
the broadcast ask, but relay_reply won't route back to a CC sender — the
Plugin's messageSenders map only tracks local msg_ids. For v1.0, use
relay_send(to=sender, text=response) for direct broadcast responses.
```

<｜｜DSML｜｜parameter name="replace_all" string="false">false

## 5. External Dependencies

| Dependency | Version | Purpose | Link |
|-----------|---------|---------|------|
| TypeScript | ^5.5.0 | Plugin language | (already in eco-relay devDeps) |
| Bun | latest | Runtime | https://bun.sh |
| OpenCode | >=1.15.0 | Target CLI | https://opencode.ai |
| OpenCode Plugin API | v1 (stable) | Plugin runtime | https://opencode.ai/docs/plugin/ |
| OpenCode Server API | v1 (stable) | Push delivery | https://opencode.ai/docs/server/ |
| `node:events` | built-in | VirtualSocket EventEmitter | Node.js stdlib |
| `node:crypto` | built-in | timingSafeEqual, randomBytes | Node.js stdlib |
| `@modelcontextprotocol/sdk` | ^1.0.0 | MCP types (plugin tools) | (already in eco-relay deps) |

**No new dependencies.** All deps already in eco-relay v0.7.2 package.json or Node.js stdlib.

## 6. Error Handling

### Hub WS Endpoint

| Error | Condition | Response |
|-------|-----------|----------|
| No auth within 5s | WS open but no valid auth msg | Close 4003 "auth_timeout" |
| Bad auth token | timingSafeEqual fails | Close 4003 "auth_failed" |
| Malformed JSON | JSON.parse throws | Log, ignore message |
| Unknown msg type | Zod rejects | `err: bad_msg` (existing behavior) |
| WS write fails | socket closed/destroyed | Return false, logged |

### OC Plugin

| Error | Condition | Response |
|-------|-----------|----------|
| WS connect fails | Hub not running | Exponential backoff reconnect (3s×2^n, max 60s, 50 attempts) |
| register fails (protocol_mismatch) | Wrong Hub version | Log error, throw to agent |
| register fails (name_taken) | Another session has name | Append suffix (-2, -3, ...) up to 10 retries |
| register fails (already_registered) | Duplicate session | Log, skip |
| Push fetch 4xx | Server API rejects | Return false, message stays in mailbox |
| Push fetch 5xx/network | Server down/transient | Retry 3x with backoff (1s, 2s, 3s) |
| Push fetch timeout | 3s AbortSignal | Retry |
| All push retries exhausted | Can't deliver | Return false, agent gets via relay_inbox |
| Malformed Hub JSON | JSON.parse throws | Log, ignore (Hub will sweep if persistent) |
| Peer name cache collision | Cached name taken after restart | Fall back to OC session name + suffix |
| Cache write fails | Disk full / permissions | Log, skip (best-effort) |

## 7. Success Criteria Per Component

### Hub WS Endpoint
- WS server starts on port 9376, binds 127.0.0.1 only
- VirtualSocket passes registry's socket contract tests (on/emit/write/destroy)
- Auth: valid token accepted, invalid token rejected (4003), missing auth times out (5s)
- Ping/pong: Hub sweep does NOT kill WS peers
- Existing Unix socket behavior: zero regressions (all 320 tests pass)

### OC Plugin
- Plugin loads on OC start without errors
- `relay_rename` triggers WS connection + Hub registration
- `relay_send` delivers message to OC session B (push visible in TUI)
- `relay_peers` shows CC and OC peers together
- Urgent messages show ⚡URGENT prefix
- Broadcast delivers to all OC sessions with correct ask_id format
- Plugin survives session delete/create cycle
- Plugin survives OC restart (peer_id cache)
- INSTRUCTIONS injected into agent context

### Integration
- CC peer "gamma" → `relay_send` → OC peer "alfa" → message appears in OC TUI
- OC peer "alfa" → `relay_send` → CC peer "gamma" → notification fires
- All 19 tools produce identical results from CC and OC
- Hub restart: both CC and OC reconnect automatically
