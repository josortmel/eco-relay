import { describe, expect, test } from "bun:test";
import type { ServerMsg } from "../protocol";
import type { HubConnection } from "./hub-connection";
import { createPendingBroadcasts } from "./pending-broadcasts";
import { messageSenders, trackMessageSender, wireHubRouting } from "./routing";

type Captured = { sent: unknown[]; listener: ((m: ServerMsg) => void) | null };

function createMockHub(captured: Captured): HubConnection {
    return {
        onMessage: (cb: (m: ServerMsg) => void) => {
            captured.listener = cb;
            return () => {
                captured.listener = null;
            };
        },
        send: (obj: unknown) => {
            captured.sent.push(obj);
        },
        onDisconnect: () => () => {},
    } as unknown as HubConnection;
}

describe("wireHubRouting — incoming_message routing", () => {
    test("incoming_message routes to emitNotification", () => {
        const captured: Captured = { sent: [], listener: null };
        const hub = createMockHub(captured);
        const notifications: ReturnType<
            typeof import("./notifications").buildMessageNotification
        >[] = [];
        wireHubRouting(hub, createPendingBroadcasts(), (n) => {
            notifications.push(
                n as ReturnType<typeof import("./notifications").buildMessageNotification>,
            );
        });

        if (captured.listener === null) throw new Error("listener not registered");
        captured.listener({
            type: "incoming_message",
            msg_id: "m-1-abc",
            from: "alice",
            text: "hello",
            reply_to: null,
            ts: "2026-01-01T00:00:00.000Z",
        });

        expect(notifications.length).toBe(1);
        const n = notifications[0]!;
        expect(n.params.content).toBe("hello");
        expect(n.params.meta.from).toBe("alice");
        expect(n.params.meta.msg_id).toBe("m-1-abc");
        expect(captured.sent).toEqual([]);
    });
});

describe("messageSenders tracking", () => {
    test("incoming_message populates messageSenders map", () => {
        messageSenders.clear();
        const captured: Captured = { sent: [], listener: null };
        const hub = createMockHub(captured);
        wireHubRouting(hub, createPendingBroadcasts(), () => {});

        if (captured.listener === null) throw new Error("listener not registered");
        captured.listener({
            type: "incoming_message",
            msg_id: "m-track-1",
            from: "bob",
            text: "hi",
            reply_to: null,
            ts: "2026-01-01T00:00:00.000Z",
        });

        expect(messageSenders.get("m-track-1")).toBe("bob");
        messageSenders.clear();
    });

    test("trackMessageSender evicts oldest when cap reached", () => {
        messageSenders.clear();
        for (let i = 0; i < 200; i++) {
            trackMessageSender(`evict-msg-${i}`, `sender-${i}`);
        }
        expect(messageSenders.size).toBe(200);
        expect(messageSenders.has("evict-msg-0")).toBe(true);

        trackMessageSender("evict-msg-200", "sender-200");
        expect(messageSenders.size).toBe(200);
        expect(messageSenders.has("evict-msg-0")).toBe(false);
        expect(messageSenders.has("evict-msg-200")).toBe(true);
        messageSenders.clear();
    });

    test("messageSenders cleared on disconnect", () => {
        messageSenders.clear();
        messageSenders.set("pre-existing", "alice");

        let disconnectCb: (() => void) | undefined;
        const hub: HubConnection = {
            onMessage: (cb: (m: ServerMsg) => void) => {
                void cb;
                return () => {};
            },
            send: () => {},
            onDisconnect: (cb: () => void) => {
                disconnectCb = cb;
                return () => {};
            },
        } as unknown as HubConnection;

        wireHubRouting(hub, createPendingBroadcasts(), () => {});
        expect(messageSenders.has("pre-existing")).toBe(true);

        disconnectCb!();
        expect(messageSenders.size).toBe(0);
    });
});

describe("wireHubRouting — ping handler", () => {
    test("responds to ping with pong carrying the same req_id", () => {
        const captured: Captured = { sent: [], listener: null };
        const hub = createMockHub(captured);
        wireHubRouting(hub, createPendingBroadcasts(), () => {});

        if (captured.listener === null) throw new Error("listener not registered");
        captured.listener({ type: "ping", req_id: "probe-123" });

        expect(captured.sent).toEqual([{ type: "pong", req_id: "probe-123" }]);
    });

    test("ping handler does not interfere with other message types", () => {
        const captured: Captured = { sent: [], listener: null };
        const hub = createMockHub(captured);
        wireHubRouting(hub, createPendingBroadcasts(), () => {});

        if (captured.listener === null) throw new Error("listener not registered");
        captured.listener({
            type: "incoming_ask",
            from: "alice",
            question: "?",
            ask_id: "a1",
        });

        expect(captured.sent).toEqual([]);
    });
});
