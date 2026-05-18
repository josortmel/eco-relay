import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createGroupStore } from "./groups";

describe("GroupStore", () => {
    let dir: string;
    let store: ReturnType<typeof createGroupStore>;

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-groups-test-"));
        store = createGroupStore(dir);
    });

    afterEach(() => {
        fs.rmSync(dir, { recursive: true, force: true });
    });

    test("create group with 3 members: all are members, admin is included", () => {
        const data = store.create("alpha", "alice", ["bob", "carol"]);
        expect(Object.keys(data.members).sort()).toEqual(["alice", "bob", "carol"]);
        expect(data.admin).toBe("alice");
        expect(store.isMember("alpha", "alice")).toBe(true);
        expect(store.isMember("alpha", "bob")).toBe(true);
        expect(store.isMember("alpha", "carol")).toBe(true);
        expect(store.isAdmin("alpha", "alice")).toBe(true);
        expect(store.isAdmin("alpha", "bob")).toBe(false);
    });

    test("addMember: new peer becomes member", () => {
        store.create("beta", "alice", []);
        store.addMember("beta", "dave");
        expect(store.isMember("beta", "dave")).toBe(true);
    });

    test("removeMember: peer is removed and system message added to history", () => {
        store.create("gamma", "alice", ["bob"]);
        const data = store.removeMember("gamma", "bob", "misbehavior", "alice");
        expect(store.isMember("gamma", "bob")).toBe(false);
        const sysMsg = data.messages.find((m) => m.type === "system");
        expect(sysMsg).toBeDefined();
        expect(sysMsg!.text).toContain("bob");
        expect(sysMsg!.text).toContain("misbehavior");
    });

    test("leaveMember: peer is removed and system message added", () => {
        store.create("delta", "alice", ["bob"]);
        const data = store.leaveMember("delta", "bob");
        expect(store.isMember("delta", "bob")).toBe(false);
        const sysMsg = data.messages.find((m) => m.type === "system");
        expect(sysMsg).toBeDefined();
        expect(sysMsg!.text).toContain("bob");
    });

    test("getUnread: offline delivery — messages sent while peer absent are returned on next call", () => {
        store.create("epsilon", "alice", ["bob"]);
        store.addMessage("epsilon", "alice", "msg1");
        store.addMessage("epsilon", "alice", "msg2");
        const { messages, remaining } = store.getUnread("epsilon", "bob");
        expect(messages.length).toBe(2);
        expect(remaining).toBe(0);
        expect(messages.map((m) => m.text)).toEqual(["msg1", "msg2"]);
    });

    test("getUnread: marks read, subsequent call returns nothing new", () => {
        store.create("zeta", "alice", ["bob"]);
        store.addMessage("zeta", "alice", "hello");
        store.getUnread("zeta", "bob");
        const { messages } = store.getUnread("zeta", "bob");
        expect(messages.length).toBe(0);
    });

    test("ring buffer: 501 messages — oldest dropped, 500 remain", () => {
        store.create("eta", "alice", []);
        for (let i = 1; i <= 501; i++) {
            store.addMessage("eta", "alice", `msg-${i}`);
        }
        const data = store.load("eta")!;
        expect(data.messages.length).toBe(500);
        expect(data.messages[0]!.text).toBe("msg-2");
        expect(data.messages[499]!.text).toBe("msg-501");
    });

    test("deleteGroup: exists returns false after delete", () => {
        store.create("theta", "alice", []);
        expect(store.exists("theta")).toBe(true);
        store.deleteGroup("theta");
        expect(store.exists("theta")).toBe(false);
    });

    test("listForPeer: returns correct unread counts per group", () => {
        store.create("iota", "alice", ["bob"]);
        store.create("kappa", "bob", ["alice"]);
        store.addMessage("iota", "alice", "hi");
        store.addMessage("iota", "alice", "there");
        store.addMessage("kappa", "bob", "hey");
        const groups = store.listForPeer("bob");
        const iota = groups.find((g) => g.name === "iota");
        const kappa = groups.find((g) => g.name === "kappa");
        expect(iota?.unread_count).toBe(2);
        expect(kappa?.unread_count).toBe(1);
    });

    test("listForPeer: only returns groups the peer belongs to", () => {
        store.create("lambda", "alice", []);
        store.create("mu", "bob", []);
        const groups = store.listForPeer("alice");
        const names = groups.map((g) => g.name);
        expect(names).toContain("lambda");
        expect(names).not.toContain("mu");
    });

    test("getUnread with limit: returns page and remaining count", () => {
        store.create("nu", "alice", ["bob"]);
        for (let i = 1; i <= 10; i++) store.addMessage("nu", "alice", `msg-${i}`);
        const { messages, remaining } = store.getUnread("nu", "bob", 3);
        expect(messages.length).toBe(3);
        expect(remaining).toBe(7);
    });
});
