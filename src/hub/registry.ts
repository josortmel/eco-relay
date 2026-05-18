import type * as net from "node:net";
import { writeLine } from "../framing";
import { makeLogger } from "../logger";
import type { PeerRecord } from "../protocol";

const log = makeLogger("hub");

export type PeerEntry = {
    name: string;
    cwd: string;
    git_branch: string;
    last_seen: number;
};

export type RegisterInput = {
    name: string;
    cwd: string;
    git_branch: string;
};

export type RegisterResult = "ok" | "name_taken" | "already_registered";
export type RenameResult = "ok" | "name_taken" | "not_registered" | "noop";

export type PeerRegistry = ReturnType<typeof createPeerRegistry>;

export function createPeerRegistry() {
    const peers = new Map<string, PeerEntry>();
    const nameToSocket = new Map<string, net.Socket>();
    const remotePeers = new Map<
        string,
        { hub_id: string; localName: string; cwd: string; git_branch: string; last_seen: number }
    >();
    const socketToName = new Map<net.Socket, string>();
    const pendingProbes = new Map<string, (alive: boolean) => void>();
    const registerInProgress = new Set<string>();
    const rooms = new Map<string, Set<string>>();
    let probeIdCounter = 0;

    function probeAlive(socket: net.Socket, timeoutMs: number): Promise<boolean> {
        return new Promise<boolean>((resolve) => {
            probeIdCounter += 1;
            const reqId = `probe-${probeIdCounter}-${Date.now()}`;
            const timer = setTimeout(() => {
                if (pendingProbes.delete(reqId)) {
                    log.debug("probe_timeout", { req_id: reqId });
                    resolve(false);
                }
            }, timeoutMs);
            pendingProbes.set(reqId, (alive: boolean) => {
                clearTimeout(timer);
                pendingProbes.delete(reqId);
                resolve(alive);
            });
            try {
                writeLine(socket, { type: "ping", req_id: reqId });
            } catch {
                const resolver = pendingProbes.get(reqId);
                if (resolver) {
                    clearTimeout(timer);
                    pendingProbes.delete(reqId);
                    resolve(false);
                }
            }
        });
    }

    function handlePong(reqId: string): void {
        const resolver = pendingProbes.get(reqId);
        if (resolver) resolver(true);
    }

    async function register(socket: net.Socket, msg: RegisterInput): Promise<RegisterResult> {
        if (socketToName.has(socket)) {
            log.warn("peer_register_err", { code: "already_registered", attempted_name: msg.name });
            return "already_registered";
        }
        const existing = nameToSocket.get(msg.name);
        if (existing && existing !== socket) {
            if (existing.destroyed || !existing.writable) {
                log.info("zombie_evicted", { name: msg.name, reason: "flags" });
                removeBySocket(existing);
            } else {
                if (registerInProgress.has(msg.name)) {
                    log.warn("peer_register_err", {
                        code: "name_taken",
                        attempted_name: msg.name,
                        reason: "register_in_progress",
                    });
                    return "name_taken";
                }
                registerInProgress.add(msg.name);
                try {
                    const alive = await probeAlive(existing, 500);
                    if (alive) {
                        log.warn("peer_register_err", {
                            code: "name_taken",
                            attempted_name: msg.name,
                            reason: "probe_alive",
                        });
                        return "name_taken";
                    }
                    log.info("zombie_evicted", { name: msg.name, reason: "probe_timeout" });
                    removeBySocket(existing);
                } finally {
                    registerInProgress.delete(msg.name);
                }
            }
        }
        peers.set(msg.name, {
            name: msg.name,
            cwd: msg.cwd,
            git_branch: msg.git_branch,
            last_seen: Date.now(),
        });
        socketToName.set(socket, msg.name);
        nameToSocket.set(msg.name, socket);
        log.info("peer_register", {
            name: msg.name,
            cwd: msg.cwd,
            git_branch: msg.git_branch,
        });
        return "ok";
    }

    function rename(socket: net.Socket, newName: string): RenameResult {
        const current = socketToName.get(socket);
        if (!current) {
            log.warn("peer_rename_err", { code: "not_registered" });
            return "not_registered";
        }
        if (newName === current) return "noop";
        if (peers.has(newName) || nameToSocket.has(newName)) {
            log.warn("peer_rename_err", { code: "name_taken" });
            return "name_taken";
        }
        const entry = peers.get(current);
        if (entry) {
            peers.delete(current);
            peers.set(newName, { ...entry, name: newName });
        }
        nameToSocket.delete(current);
        nameToSocket.set(newName, socket);
        socketToName.set(socket, newName);
        for (const members of rooms.values()) {
            if (members.has(current)) {
                members.delete(current);
                members.add(newName);
            }
        }
        log.info("peer_rename", { from: current, to: newName });
        return "ok";
    }

    function touch(socket: net.Socket): void {
        const name = socketToName.get(socket);
        if (!name) return;
        const entry = peers.get(name);
        if (!entry) return;
        entry.last_seen = Date.now();
    }

    function removeBySocket(socket: net.Socket): string | undefined {
        const name = socketToName.get(socket);
        if (!name) return undefined;
        log.info("peer_disconnect", { name });
        for (const [roomName, members] of rooms) {
            if (members.delete(name) && members.size === 0) {
                rooms.delete(roomName);
            }
        }
        socketToName.delete(socket);
        if (nameToSocket.get(name) === socket) {
            nameToSocket.delete(name);
        }
        peers.delete(name);
        return name;
    }

    const MAX_REMOTE_PEERS_PER_HUB = 500;

    function addRemotePeer(
        hubId: string,
        peer: { name: string; cwd: string; git_branch: string; last_seen: number },
    ): void {
        const currentCount = [...remotePeers.keys()].filter((k) => k.endsWith(`@${hubId}`)).length;
        if (currentCount >= MAX_REMOTE_PEERS_PER_HUB) return;
        const qualifiedName = `${peer.name}@${hubId}`;
        remotePeers.set(qualifiedName, {
            hub_id: hubId,
            localName: peer.name,
            cwd: peer.cwd,
            git_branch: peer.git_branch,
            last_seen: peer.last_seen,
        });
    }

    function removeRemotePeer(hubId: string, name: string): void {
        remotePeers.delete(`${name}@${hubId}`);
    }

    function removeAllRemotePeersForHub(hubId: string): void {
        for (const key of [...remotePeers.keys()]) {
            if (key.endsWith(`@${hubId}`)) remotePeers.delete(key);
        }
    }

    function getRemotePeer(
        qualifiedName: string,
    ): { hub_id: string; localName: string } | undefined {
        const entry = remotePeers.get(qualifiedName);
        if (!entry) return undefined;
        return { hub_id: entry.hub_id, localName: entry.localName };
    }

    function hasRemotePeer(qualifiedName: string): boolean {
        return remotePeers.has(qualifiedName);
    }

    function list(exceptName?: string): PeerRecord[] {
        const out: PeerRecord[] = [];
        for (const p of peers.values()) {
            if (p.name === exceptName) continue;
            out.push({
                name: p.name,
                cwd: p.cwd,
                git_branch: p.git_branch,
                last_seen: p.last_seen,
            });
        }
        for (const [qualifiedName, r] of remotePeers) {
            if (qualifiedName === exceptName) continue;
            out.push({
                name: qualifiedName,
                cwd: r.cwd,
                git_branch: r.git_branch,
                last_seen: r.last_seen,
            });
        }
        return out;
    }

    function joinRoom(peerName: string, room: string): string[] {
        let members = rooms.get(room);
        if (!members) {
            members = new Set();
            rooms.set(room, members);
        }
        members.add(peerName);
        return [...members];
    }

    function leaveRoom(peerName: string, room: string): boolean {
        const members = rooms.get(room);
        if (!members) return false;
        const removed = members.delete(peerName);
        if (members.size === 0) {
            rooms.delete(room);
        }
        return removed;
    }

    function listRooms(): Array<{ name: string; members: string[] }> {
        return [...rooms.entries()].map(([name, members]) => ({
            name,
            members: [...members],
        }));
    }

    function getRoomMembers(room: string): string[] {
        return [...(rooms.get(room) ?? [])];
    }

    return {
        register,
        rename,
        touch,
        removeBySocket,
        list,
        probeAlive,
        handlePong,
        getSocket: (name: string) => nameToSocket.get(name),
        getName: (socket: net.Socket) => socketToName.get(socket),
        hasName: (name: string) => nameToSocket.has(name) || remotePeers.has(name),
        isEmpty: () => peers.size === 0 && nameToSocket.size === 0,
        names: () => nameToSocket.keys(),
        sockets: () => socketToName.keys(),
        joinRoom,
        leaveRoom,
        listRooms,
        getRoomMembers,
        addRemotePeer,
        removeRemotePeer,
        removeAllRemotePeersForHub,
        getRemotePeer,
        hasRemotePeer,
    };
}
