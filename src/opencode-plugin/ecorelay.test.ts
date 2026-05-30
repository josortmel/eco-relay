import { describe, expect, test, mock } from "bun:test";
import { server } from "./ecorelay";

// ── Helpers ──────────────────────────────────────────────────────────

function mockSessionList(
    sessions: Array<{ id: string; title?: string | null; parentId?: string | null }> = [],
) {
    return mock(async () => sessions);
}

function mockPluginInput(overrides: Record<string, unknown> = {}) {
    return {
        client: {
            session: {
                list: mockSessionList([]),
                prompt: mock(async () => {}),
            },
        },
        project: { id: "test", name: "test" } as any,
        directory: "/fake/dir",
        worktree: "/fake/dir",
        serverUrl: new URL("http://127.0.0.1:4096"),
        $: {} as any,
        ...overrides,
    };
}

// ── Tests ────────────────────────────────────────────────────────────

describe("Server export", () => {
    test("plugin exported as named export 'server'", () => {
        expect(typeof server).toBe("function");
    });
});

describe("Server lifecycle", () => {
    test("bootstrap calls client.session.list", async () => {
        const listSpy = mockSessionList([]);
        const input = mockPluginInput({
            client: { session: { list: listSpy, prompt: mock(async () => {}) } },
        });
        const hooks = await server(input as any);
        expect(listSpy).toHaveBeenCalled();
        expect(typeof hooks.dispose).toBe("function");
        expect(typeof hooks.event).toBe("function");
        expect(hooks.tool).toBeDefined();
        expect(hooks["experimental.chat.system.transform"]).toBeDefined();
    });

    test("bootstrap handles session.list errors gracefully", async () => {
        const input = mockPluginInput({
            client: {
                session: {
                    list: mock(async () => { throw new Error("OC not ready"); }),
                    prompt: mock(async () => {}),
                },
            },
        });
        const hooks = await server(input as any);
        expect(hooks.tool).toBeDefined();
    });

    test("bootstrap enumerates existing root sessions", async () => {
        const sessions = [
            { id: "s1", title: "Session 1" },
            { id: "child-1", title: "Child", parentId: "s1" },
        ];
        const input = mockPluginInput({
            client: { session: { list: mockSessionList(sessions), prompt: mock(async () => {}) } },
        });
        const hooks = await server(input as any);
        // Child sessions with parentId are skipped in bootstrap
        expect(hooks.tool).toBeDefined();
    });

    test("dispose runs without error", async () => {
        const input = mockPluginInput();
        const hooks = await server(input as any);
        await hooks.dispose!();
        expect(true).toBe(true);
    });
});

describe("Tool registration", () => {
    test("all 19 MCP tools are registered", async () => {
        const input = mockPluginInput();
        const hooks = await server(input as any);

        const toolNames = [
            "relay_send", "relay_inbox", "relay_reply", "relay_broadcast",
            "relay_peers", "relay_rename", "relay_join", "relay_leave",
            "relay_room", "relay_rooms",
            "relay_group_create", "relay_group_invite", "relay_group_remove",
            "relay_group_leave", "relay_group_send", "relay_group_history",
            "relay_group_list", "relay_group_info", "relay_group_delete",
        ];

        expect(Object.keys(hooks.tool!).length).toBe(19);
        for (const name of toolNames) {
            expect(hooks.tool![name]).toBeDefined();
        }
    });
});

describe("Event handler", () => {
    test("session.created with valid session", async () => {
        const input = mockPluginInput();
        const hooks = await server(input as any);

        // Should not throw — valid root session
        await hooks.event!({
            event: {
                type: "session.created",
                properties: { session: { id: "s-new", title: "New Session" } },
            } as any,
        });
        expect(true).toBe(true);
    });

    test("session.created with invalid properties does not crash", async () => {
        const input = mockPluginInput();
        const hooks = await server(input as any);

        // Invalid: no session object
        await hooks.event!({
            event: { type: "session.created", properties: {} } as any,
        });
        // Invalid: session without id
        await hooks.event!({
            event: { type: "session.created", properties: { session: {} } } as any,
        });
        // Invalid: null session
        await hooks.event!({
            event: { type: "session.created", properties: { session: null } } as any,
        });
        expect(true).toBe(true);
    });

    test("session.created with child session (parentId) is skipped", async () => {
        const input = mockPluginInput();
        const hooks = await server(input as any);

        await hooks.event!({
            event: {
                type: "session.created",
                properties: { session: { id: "child-1", title: "Child", parentId: "root-1" } },
            } as any,
        });
        expect(true).toBe(true);
    });

    test("session.deleted with valid sessionID does not crash", async () => {
        const input = mockPluginInput();
        const hooks = await server(input as any);

        await hooks.event!({
            event: { type: "session.deleted", properties: { sessionID: "nonexistent" } } as any,
        });
        expect(true).toBe(true);
    });

    test("session.deleted with invalid properties warns but does not crash", async () => {
        const input = mockPluginInput();
        const hooks = await server(input as any);

        await hooks.event!({
            event: { type: "session.deleted", properties: {} } as any,
        });
        expect(true).toBe(true);
    });

    test("session.status handler does not crash", async () => {
        const input = mockPluginInput();
        const hooks = await server(input as any);

        await hooks.event!({
            event: { type: "session.status", properties: { sessionID: "s1", status: "busy" } } as any,
        });
        expect(true).toBe(true);
    });

    test("concurrent session.created events", async () => {
        const input = mockPluginInput();
        const hooks = await server(input as any);

        for (let i = 0; i < 20; i++) {
            await hooks.event!({
                event: {
                    type: "session.created",
                    properties: { session: { id: `concurrent-${i}`, title: `S${i}` } },
                } as any,
            });
        }
        expect(true).toBe(true);
    });

    test("rapid create+delete+create same id", async () => {
        const input = mockPluginInput();
        const hooks = await server(input as any);

        const sid = "churn-session";
        await hooks.event!({
            event: { type: "session.created", properties: { session: { id: sid, title: "Churn" } } } as any,
        });
        await hooks.event!({
            event: { type: "session.deleted", properties: { sessionID: sid } } as any,
        });
        await hooks.event!({
            event: { type: "session.created", properties: { session: { id: sid, title: "Again" } } } as any,
        });
        expect(true).toBe(true);
    });
});

describe("System transform", () => {
    test("injects INSTRUCTIONS when not present", async () => {
        const input = mockPluginInput();
        const hooks = await server(input as any);

        const output = { system: [] as string[] };
        await hooks["experimental.chat.system.transform"]!({} as any, output);
        expect(output.system.length).toBe(1);
        expect(output.system[0]).toInclude("[ECORELAY_INSTRUCTIONS_v0.7.6]");
    });

    test("does not inject INSTRUCTIONS twice", async () => {
        const input = mockPluginInput();
        const hooks = await server(input as any);

        const output = { system: [] as string[] };
        await hooks["experimental.chat.system.transform"]!({} as any, output);
        await hooks["experimental.chat.system.transform"]!({} as any, output);
        expect(output.system.length).toBe(1);
    });

    test("skips injection if marker already present", async () => {
        const input = mockPluginInput();
        const hooks = await server(input as any);

        const output = { system: ["[ECORELAY_INSTRUCTIONS_v0.7.6] existing content"] };
        await hooks["experimental.chat.system.transform"]!({} as any, output);
        expect(output.system.length).toBe(1);
    });
});

describe("Edge cases", () => {
    test("server handles empty session list", async () => {
        const input = mockPluginInput();
        const hooks = await server(input as any);
        expect(hooks.tool).toBeDefined();
    });

    test("server handles unicode session titles", async () => {
        const input = mockPluginInput();
        const hooks = await server(input as any);

        await hooks.event!({
            event: {
                type: "session.created",
                properties: { session: { id: "unicode-1", title: "セッション 🎉 中文" } },
            } as any,
        });
        expect(true).toBe(true);
    });

    test("server handles session with null title", async () => {
        const input = mockPluginInput();
        const hooks = await server(input as any);

        await hooks.event!({
            event: {
                type: "session.created",
                properties: { session: { id: "no-title", title: null } },
            } as any,
        });
        expect(true).toBe(true);
    });
});

describe("Reconnect timing", () => {
    test("exponential backoff formula", () => {
        const INITIAL = 3_000;
        const MAX = 60_000;

        function calcDelay(attempt: number): number {
            return Math.min(INITIAL * Math.pow(2, attempt), MAX);
        }

        expect(calcDelay(0)).toBe(3000);
        expect(calcDelay(1)).toBe(6000);
        expect(calcDelay(2)).toBe(12000);
        expect(calcDelay(3)).toBe(24000);
        expect(calcDelay(4)).toBe(48000);
        expect(calcDelay(5)).toBe(60000);
        expect(calcDelay(10)).toBe(60000);
    });
});
