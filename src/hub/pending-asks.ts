import { makeLogger } from "../logger";

const log = makeLogger("hub");

export type PendingAsk = {
    caller: string;
    target: string;
    created_at: number;
    timer: ReturnType<typeof setTimeout>;
    broadcast_id?: string;
    thread_id?: string;
};

type NewPendingAsk = Omit<PendingAsk, "timer" | "created_at">;

export type DisconnectCleanup = {
    peerGone: { askId: string; caller: string }[];
};

export type PendingAsks = ReturnType<typeof createPendingAsks>;

export function createPendingAsks(injected?: Map<string, PendingAsk>) {
    const map = injected ?? new Map<string, PendingAsk>();

    function create(
        askId: string,
        entry: NewPendingAsk,
        timeoutMs: number,
        onTimeout: () => void,
    ): void {
        const timer = setTimeout(() => {
            const existed = map.delete(askId);
            if (existed) onTimeout();
        }, timeoutMs);
        map.set(askId, {
            ...entry,
            created_at: Date.now(),
            timer,
        });
    }

    function resolve(askId: string): PendingAsk | undefined {
        const pending = map.get(askId);
        if (!pending) return undefined;
        clearTimeout(pending.timer);
        map.delete(askId);
        return pending;
    }

    function peek(askId: string): PendingAsk | undefined {
        return map.get(askId);
    }

    function updateNameOnRename(oldName: string, newName: string): void {
        for (const [askId, pending] of map) {
            if (pending.caller === oldName || pending.target === oldName) {
                map.set(askId, {
                    ...pending,
                    caller: pending.caller === oldName ? newName : pending.caller,
                    target: pending.target === oldName ? newName : pending.target,
                });
            }
        }
    }

    function cleanupForDisconnect(name: string): DisconnectCleanup {
        const peerGone: { askId: string; caller: string }[] = [];
        for (const [askId, pending] of Array.from(map.entries())) {
            if (pending.target === name) {
                clearTimeout(pending.timer);
                map.delete(askId);
                log.warn("pending_ask_peer_gone", {
                    ask_id: askId,
                    caller: pending.caller,
                    target: pending.target,
                });
                peerGone.push({ askId, caller: pending.caller });
            } else if (pending.caller === name) {
                clearTimeout(pending.timer);
                map.delete(askId);
            }
        }
        return { peerGone };
    }

    function cleanupByCallerSuffix(suffix: string): void {
        for (const [askId, pending] of Array.from(map.entries())) {
            if (pending.caller.endsWith(suffix)) {
                clearTimeout(pending.timer);
                map.delete(askId);
            }
        }
    }

    function cleanupByTargetSuffix(suffix: string): DisconnectCleanup {
        const peerGone: { askId: string; caller: string }[] = [];
        for (const [askId, pending] of Array.from(map.entries())) {
            if (pending.target.endsWith(suffix)) {
                clearTimeout(pending.timer);
                map.delete(askId);
                log.warn("pending_ask_peer_gone", {
                    ask_id: askId,
                    caller: pending.caller,
                    target: pending.target,
                });
                peerGone.push({ askId, caller: pending.caller });
            }
        }
        return { peerGone };
    }

    function clearAll(): void {
        for (const p of map.values()) clearTimeout(p.timer);
        map.clear();
    }

    return {
        create,
        resolve,
        peek,
        updateNameOnRename,
        cleanupForDisconnect,
        cleanupByTargetSuffix,
        cleanupByCallerSuffix,
        clearAll,
    };
}
