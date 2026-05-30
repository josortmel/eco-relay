# Plan — EcoRelay v0.7.6 "It Just Works"

> Design: Prima + 2 rounds adversarial (adv-code + adv-seg). 6 architectural vulns resolved.
> Base: v0.7.5 (505 tests)

## Task 1: Bootstrap simétrico + Lock file

- **objetivo**: Ambos plugins (CC y OC) pueden spawnear el Hub. Lock file previene carrera. Módulo compartido `hub-spawner.ts`.

- **archivos_a_tocar**:
  - `src/shared/hub-spawner.ts` (NUEVO, ~120 LOC)
  - `src/channel/daemon-spawn.ts` (MODIFICAR, delegar a shared)
  - `src/opencode-plugin/ecorelay.ts` (MODIFICAR, importar bootstrapHub)

- **accion**:
  1. Crear `src/shared/hub-spawner.ts`: extraer `spawnDetachedDaemon` de daemon-spawn.ts. Añadir lock file `~/.eco-relay/hub.lock` con O_CREAT|O_EXCL. Contenido: `{pid, port, socketPath, bootId}`. Si lock ocupado → kill(pid, 0) + cmdline check → conectar. Si libre → spawn Hub → esperar WS ready → conectar. Hash SHA-256 de hub-daemon.ts verificado antes del spawn.
  2. Modificar `src/channel/daemon-spawn.ts`: delegar a `src/shared/hub-spawner.ts`.
  3. Modificar `src/opencode-plugin/ecorelay.ts`: lazyConnect importa y usa `bootstrapHub` compartido en vez de solo WS connect. Si Hub no existe → lo spawnea.

- **pre_condiciones**: Install script copió repo a `~/.ecorelay/` (Tarea 3). Bun en PATH. `~/.eco-relay/` dir existe.

- **post_condiciones**: Abrir solo OC → Hub se levanta. Abrir CC después → CC detecta Hub y conecta. Abrir ambos a la vez → uno spawnea (lock), otro conecta. Cero comandos manuales.

- **tests**:
  ```bash
  bun test src/shared/hub-spawner.test.ts  # lock file atomic, PID verify, hash verify
  bun test src/channel/daemon-spawn.test.ts  # existing tests still pass
  bun test  # 505+ tests, zero regressions
  ```

- **criterio_de_exito**: Lock file previene double-spawn. Hash verification bloquea binario malicioso. Ambos plugins arrancan Hub si no existe.

- **rollback**: Delete `src/shared/hub-spawner.ts`. Revert `daemon-spawn.ts` and `ecorelay.ts` changes. `git checkout src/channel/daemon-spawn.ts src/opencode-plugin/ecorelay.ts`

- **depende_de**: Tarea 3

## Task 2: Auto-descubrimiento push URL + detección versiones

- **objetivo**: Plugin OC descubre URL de push automáticamente. Sin `ECORELAY_OC_PORT`. Version mismatch → error claro al usuario.

- **archivos_a_tocar**:
  - `src/opencode-plugin/ecorelay.ts` (MODIFICAR, +~50 LOC)

- **accion**:
  1. `discoverPushUrl(pluginContext)`: intenta `serverUrl` de rest params → parse `directory/opencode.jsonc` server.port → `ECORELAY_OC_PORT` env → default `http://127.0.0.1:4096`. Loggea fuente.
  2. En ack handler: `hub_version` del ack vs `PLUGIN_VERSION`. Si hub > plugin → log error claro: `"[ecorelay] VERSION MISMATCH: plugin=v0.7.6 hub=v{N}. Run: bash ~/.ecorelay/scripts/install-opencode-plugin.sh"`
  3. `registerWithRetries`: name_taken → auto-suffix -2..-10. protocol_mismatch → error claro + conn.closed.

- **pre_condiciones**: Tarea 1 (Hub corriendo, WS conectado, ack recibido).

- **post_condiciones**: Push funciona sin ECORELAY_OC_PORT. Version mismatch muestra comando exacto de actualización.

- **tests**:
  ```bash
  bun test src/opencode-plugin/ecorelay.push.test.ts  # existing push tests pass
  bun test  # 505+ tests, zero regressions
  ```

- **criterio_de_exito**: `discoverPushUrl` resuelve URL sin env var. Version check en ack detecta mismatch. registerWithRetries maneja name_taken.

- **rollback**: Revert `ecorelay.ts` push URL + ack handler changes. `git checkout src/opencode-plugin/ecorelay.ts`

- **depende_de**: Tarea 1

## Task 3: Install script unificado

- **objetivo**: Un comando instala todo. Hub + plugin OC en paths fijos conocidos.

- **archivos_a_tocar**:
  - `scripts/install.sh` (NUEVO, ~30 LOC)
  - `scripts/install-opencode-plugin.sh` (REESCRIBIR, delegar a install.sh)

- **accion**:
  1. `install.sh`: copia repo entero a `~/.ecorelay/` (src/hub/, src/shared/, src/opencode-plugin/, package.json, bun.lock, tsconfig.json). `bun install --production`. Copia/symlink `ecorelay.ts` a `~/.opencode/plugin/`. Hash SHA-256 de `hub-daemon.ts` → `~/.ecorelay/hub.sha256`. `bun run typecheck && bun test`. Output: "EcoRelay v0.7.6 installed. Open Claude Code or OpenCode. Done."

- **pre_condiciones**: Bun instalado. Git repo clonado. `~/.opencode/plugin/` dir existe.

- **post_condiciones**: `~/.ecorelay/` contiene todo el código. `~/.opencode/plugin/ecorelay.ts` es el plugin. `~/.ecorelay/hub.sha256` contiene hash.

- **tests**:
  ```bash
  bash scripts/install.sh  # ejecuta sin errores
  test -f ~/.ecorelay/src/hub/hub-daemon.ts  # existe
  test -f ~/.ecorelay/hub.sha256  # existe
  test -f ~/.opencode/plugin/ecorelay.ts  # existe
  ```

- **criterio_de_exito**: `bash install.sh` → abrir CC o OC → funciona. Sin pasos extra. Sin env vars.

- **rollback**: `rm -rf ~/.ecorelay/`. `rm ~/.opencode/plugin/ecorelay.ts`. Revertir git changes.

- **depende_de**: ninguna

## Dependency Graph

```
T3 (install script)
  │
  ▼
T1 (bootstrap + lock)
  │
  ▼
T2 (push URL + versions)
```

## Time Estimates

| Task | Est. | Accumulated |
|------|------|-------------|
| T3 | 30 min | 30 min |
| T1 | 2h | 2h 30min |
| T2 | 1h | 3h 30min |
