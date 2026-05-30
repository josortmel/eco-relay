import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as net from "node:net";
import { startCh, tmpSocket } from "./test-helpers";

describe("channel hub connection", () => {
    let sockPath: string;
    const closers: Array<() => Promise<void>> = [];

    beforeEach(() => {
        sockPath = tmpSocket();
    });

    afterEach(async () => {
        while (closers.length) {
            const c = closers.pop()!;
            try {
                await c();
            } catch {}
        }
    });

    test("relay_peers times out cleanly when hub never replies", async () => {
        // Server that answers the bootstrap handshake (ping -> pong) but never
        // replies to actual requests, so the call times out cleanly.
        const silentServer = net.createServer((sock) => {
            sock.on("data", (buf) => {
                const line = buf.toString().split("\n")[0] ?? "";
                try {
                    const msg = JSON.parse(line);
                    if (msg.type === "ping") {
                        sock.write(JSON.stringify({ type: "pong", req_id: msg.req_id }) + "\n");
                    }
                } catch {}
            });
        });
        await new Promise<void>((resolve) => silentServer.listen(sockPath, resolve));
        closers.push(
            () =>
                new Promise<void>((resolve) => {
                    silentServer.close(() => resolve());
                }),
        );
        const ch = await startCh({
            socketPath: sockPath,
            requestTimeoutMs: 50,
            skipRegister: true,
        });
        closers.push(() => ch.close());
        const result = await ch.callTool("relay_peers", {});
        expect(result.isError).toBe(true);
        expect(JSON.parse(result.content[0]!.text)).toEqual({ ok: false, code: "hub_unreachable" });
    });

    test("relay_broadcast times out cleanly when hub never acks", async () => {
        const silentServer = net.createServer((sock) => {
            sock.on("data", (buf) => {
                const line = buf.toString().split("\n")[0] ?? "";
                try {
                    const msg = JSON.parse(line);
                    if (msg.type === "ping") {
                        sock.write(JSON.stringify({ type: "pong", req_id: msg.req_id }) + "\n");
                    }
                } catch {}
            });
        });
        await new Promise<void>((resolve) => silentServer.listen(sockPath, resolve));
        closers.push(
            () =>
                new Promise<void>((resolve) => {
                    silentServer.close(() => resolve());
                }),
        );
        const ch = await startCh({
            socketPath: sockPath,
            broadcastTimeoutMs: 50,
            skipRegister: true,
        });
        closers.push(() => ch.close());
        const result = await ch.callTool("relay_broadcast", { question: "?" });
        expect(result.isError).toBe(true);
        expect(JSON.parse(result.content[0]!.text)).toEqual({ ok: false, code: "hub_unreachable" });
    });
});
