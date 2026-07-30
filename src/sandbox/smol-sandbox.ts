import { randomUUID } from "node:crypto";
import type { WorkspaceLayer } from "../types.ts";
import type { WorkspaceStore } from "../workspace/workspace-store.ts";
import { createKeyedQueue, sleep } from "../util/async.ts";
import { swallowAs, errMessage } from "../util/errors.ts";
import { shq } from "../util/shell.ts";
import { shortHash } from "../util/crypto.ts";
import { nonInteractiveShellPrefix } from "./sandbox-env.ts";
import { createExecProcessSessions, type ExecProcessIo } from "./exec-process-session.ts";
import { materializeRoLayers } from "./ro-layers.ts";
import { createExecBackup, createExecFileOps, posixJoin } from "./exec-file-ops.ts";
import { ephemeralCredLinkScript, ephemeralCredLinkPaths } from "../credentials/resident-paths.ts";
import { killableScript, killScript } from "./exec-kill.ts";
import { createSmolApi, type SmolApi, type SmolApiOptions, type SmolNetwork } from "./smol-api.ts";
import type {
  AgentComputerProfile,
  EgressEnforcement,
  ExecOptions,
  ExecResult,
  ProvisionOptions,
  Sandbox,
  SandboxHandle,
  TeardownOptions,
} from "./sandbox.ts";

export const SMOL_DEFAULT_IMAGE = "docker.io/library/debian:12-slim";
const HOME_DIR = "/root";
const WORKSPACE_BASENAME = "workspace";
const RO_LAYERS_TAR = ".ro-layers.tar";
const RO_LAYERS_MANIFEST = ".ro-layers.manifest";

/**
 * Bytes of *raw* file content moved per exec. Base64 inflates by 4/3, so the encoded
 * payload stays comfortably under the guest agent's frame ceiling. Files larger than
 * this are streamed in several appends/reads rather than failing.
 */
export const TRANSFER_CHUNK_BYTES = 3 * 1024 * 1024;

export interface SmolSandboxOptions extends Partial<SmolApiOptions> {
  apiKey?: string;
  image?: string;
  cpus?: number;
  memoryMb?: number;
  defaultTimeoutSec?: number;
  homeDir?: string;
  /** Applied at machine creation; an empty allow-list means unrestricted egress. */
  network?: SmolNetwork;
  /**
   * What the image actually ships. The agent plans around this list, so it must describe
   * the configured image rather than a hoped-for one — an empty list is the honest
   * default for a bare base image.
   */
  runtimes?: string[];
  tools?: string[];
  notInstalled?: string[];
  /** Override the per-exec transfer size. Exposed for tests; production uses the default. */
  transferChunkBytes?: number;
  api?: SmolApi;
  onError?: (e: { category: string; code: string; message: string; scopeLabel?: string }) => void;
}

export const smolMachineName = (scopeId: string): string => `qm-sbx-${smolSlug(scopeId)}`;
const smolScratchName = (key: string): string => `qm-scratch-${smolSlug(key)}`;

/**
 * Machine names are DNS-ish labels, so the scope id is squashed and suffixed with a hash
 * of the original to keep distinct scopes from colliding after the squash.
 */
function smolSlug(id: string): string {
  const cleaned = id
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${cleaned.slice(0, 40).replace(/-+$/, "") || "scope"}-${shortHash(id)}`;
}

export function createSmolSandbox(workspace: WorkspaceStore, opts: SmolSandboxOptions = {}): Sandbox {
  const apiKey = opts.apiKey ?? "";
  if (!opts.api && !apiKey) throw new Error("SANDBOX_BACKEND=smol requires SMOL_API_KEY");
  const api =
    opts.api ??
    createSmolApi({
      apiKey,
      ...(opts.baseUrl ? { baseUrl: opts.baseUrl } : {}),
      ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    });

  const image = opts.image ?? SMOL_DEFAULT_IMAGE;
  const defaultTimeoutSec = opts.defaultTimeoutSec ?? 600;
  const homeDir = opts.homeDir ?? HOME_DIR;
  const workspaceDir = `${homeDir}/${WORKSPACE_BASENAME}`;
  const chunkBytes = opts.transferChunkBytes ?? TRANSFER_CHUNK_BYTES;
  const provisionQueue = createKeyedQueue<string>();

  const idByName = new Map<string, string>();
  const scopeById = new Map<string, string>();
  const scratchByKey = new Map<string, string>();
  const activeById = new Map<string, number>();

  async function findByName(name: string): Promise<string | null> {
    const cached = idByName.get(name);
    if (cached) return cached;
    const found = (await api.listMachines()).find((m) => m.name === name);
    if (!found) return null;
    idByName.set(name, found.id);
    return found.id;
  }

  /**
   * Drive a machine to `started`, tolerating a start already in flight.
   *
   * Creating a machine also brings it up, so firing `/start` immediately afterwards races
   * that in-flight start and the node rejects the second request. Poll instead, and only
   * issue an explicit start once the machine has actually settled while stopped.
   */
  async function bringUp(id: string): Promise<void> {
    const deadline = Date.now() + 180_000;
    let requestedStart = false;
    let last = "";
    while (Date.now() < deadline) {
      const m = await api.getMachine(id);
      if (!m) throw new Error(`smol sandbox machine ${id} disappeared while starting`);
      last = m.state;
      if (m.state === "started") return;
      if (m.state === "error" || m.state === "failed") {
        throw new Error(`smol sandbox machine ${id} failed to start (state: ${m.state})`);
      }
      if (m.state === "stopped" && !requestedStart) {
        requestedStart = true;
        await api.startMachine(id);
      }
      await sleep(500);
    }
    throw new Error(`smol sandbox machine ${id} never reached "started" (last state: ${last})`);
  }

  async function ensureMachine(name: string, scope: string | undefined): Promise<{ id: string; coldStart: boolean }> {
    const existing = await findByName(name);
    if (existing) {
      // A machine wedged in `error` can never be revived, and it holds the scope's name.
      // Replace it rather than failing this scope forever; its disk is unrecoverable
      // either way, so the rebuild is a cold start.
      const current = await api.getMachine(existing);
      if (current && (current.state === "error" || current.state === "failed")) {
        await api.deleteMachine(existing).catch(swallowAs("smol-sandbox: replace errored machine", undefined));
        idByName.delete(name);
      } else {
        await bringUp(existing);
        if (scope) scopeById.set(existing, scope);
        return { id: existing, coldStart: false };
      }
    }
    const created = await api.createMachine({
      name,
      image,
      ...(opts.cpus ? { cpus: opts.cpus } : {}),
      ...(opts.memoryMb ? { memoryMb: opts.memoryMb } : {}),
      ...(opts.network ? { network: opts.network } : {}),
    });
    idByName.set(name, created.id);
    if (scope) scopeById.set(created.id, scope);
    await bringUp(created.id);
    return { id: created.id, coldStart: true };
  }

  async function execRaw(id: string, command: string, timeoutSec: number, signal?: AbortSignal): Promise<ExecResult> {
    const r = await api.exec(id, {
      command,
      timeoutSec,
      ...(signal ? { signal } : {}),
    });
    return {
      stdout: Buffer.from(r.stdout).toString("utf8"),
      stderr: Buffer.from(r.stderr).toString("utf8"),
      code: r.exitCode,
      // The fleet kills the command at the deadline and surfaces it as a non-zero exit;
      // 124 is what `timeout(1)` reports, which is what the guest agent uses.
      timedOut: r.exitCode === 124,
    };
  }

  async function writeAbsBytes(id: string, absPath: string, data: Uint8Array): Promise<void> {
    const dir = absPath.slice(0, Math.max(0, absPath.lastIndexOf("/"))) || "/";
    const mk = await execRaw(id, `mkdir -p ${shq(dir)}`, 30);
    if (mk.code !== 0) throw new Error(`smol sandbox mkdir ${dir} failed: ${mk.stderr.slice(0, 200)}`);

    // Truncate first, then append chunk by chunk, so a large file needs neither a huge
    // single frame nor a temp file on the guest.
    const truncate = await execRaw(id, `: > ${shq(absPath)}`, 30);
    if (truncate.code !== 0) throw new Error(`smol sandbox write ${absPath} failed: ${truncate.stderr.slice(0, 200)}`);

    for (let off = 0; off < data.length || (off === 0 && data.length === 0); off += chunkBytes) {
      const chunk = data.subarray(off, Math.min(off + chunkBytes, data.length));
      const r = await api.exec(id, {
        command: `base64 -d >> ${shq(absPath)}`,
        timeoutSec: 120,
        stdin: Buffer.from(chunk).toString("base64"),
      });
      if (r.exitCode !== 0)
        throw new Error(
          `smol sandbox write ${absPath} failed: ${Buffer.from(r.stderr).toString("utf8").slice(0, 200)}`,
        );
      if (data.length === 0) break;
    }
  }

  async function readAbsBytes(id: string, absPath: string): Promise<Uint8Array | null> {
    // 66 is chosen to be distinguishable from a shell/`cat` failure so a missing file
    // reads back as null rather than an error.
    const sized = await execRaw(id, `[ -f ${shq(absPath)} ] || exit 66; stat -c %s ${shq(absPath)}`, 60);
    if (sized.code === 66) return null;
    if (sized.code !== 0) throw new Error(`smol sandbox read ${absPath} failed: ${sized.stderr.slice(0, 200)}`);
    const size = Number(sized.stdout.trim());
    if (!Number.isFinite(size)) throw new Error(`smol sandbox read ${absPath}: unexpected size ${sized.stdout.trim()}`);
    if (size === 0) return new Uint8Array(0);

    const parts: Uint8Array[] = [];
    for (let off = 0; off < size; off += chunkBytes) {
      const count = Math.min(chunkBytes, size - off);
      const r = await api.exec(id, {
        command: `tail -c +${off + 1} ${shq(absPath)} | head -c ${count}`,
        timeoutSec: 120,
      });
      if (r.exitCode !== 0)
        throw new Error(`smol sandbox read ${absPath} failed: ${Buffer.from(r.stderr).toString("utf8").slice(0, 200)}`);
      parts.push(r.stdout);
    }
    return Buffer.concat(parts.map((p) => Buffer.from(p)));
  }

  function teardownQueueKey(handle: SandboxHandle): string {
    if (handle.scratch) {
      for (const [k, id] of scratchByKey) if (id === handle.id) return `scratch:${k}`;
      return handle.id;
    }
    return scopeById.get(handle.id) ?? handle.id;
  }

  const egressEnforcement: EgressEnforcement =
    opts.network?.blocked || opts.network?.allowedHosts?.length || opts.network?.allowedCidrs?.length
      ? "domain"
      : "none";

  const profile: AgentComputerProfile = {
    backend: "smol-machines",
    writablePersistence: "resident_disk",
    processSessions: true,
    egressEnforcement,
    spec: {
      os: `${image} in a smol machine (hardware-isolated microVM)`,
      runtimes: opts.runtimes ?? [],
      tools: opts.tools ?? [],
      notInstalled: opts.notInstalled ?? [],
      ...(opts.cpus ? { cpus: opts.cpus } : {}),
      ...(opts.memoryMb ? { memoryMb: opts.memoryMb } : {}),
      homeDir,
      workdir: workspaceDir,
    },
  };

  const procIo: ExecProcessIo = {
    async run(handle, command, execOpts): Promise<ExecResult> {
      const timeoutSec = execOpts?.timeoutMs ? Math.ceil(execOpts.timeoutMs / 1000) : defaultTimeoutSec;
      await bringUp(handle.id);
      return execRaw(handle.id, command, timeoutSec);
    },
  };
  const procSessions = createExecProcessSessions(procIo);

  const execFileOps = createExecFileOps({
    label: "smol",
    exec: (id, script, t) => execRaw(id, script, t),
    writeInline: (id, abs, data) => writeAbsBytes(id, abs, data),
  });

  const execBackup = createExecBackup({
    label: "smol",
    exec: (id, script, t) => execRaw(id, script, t),
    readAbsBytes,
    defaultHomeDir: homeDir,
    ephemeralCredentialPrefixes: ephemeralCredLinkPaths().map(({ rel }) => rel),
  });

  const sandbox: Sandbox = {
    profile,
    startProcess: procSessions.startProcess,
    readProcess: procSessions.readProcess,
    writeStdin: procSessions.writeStdin,
    signalProcess: procSessions.signalProcess,
    listProcesses: procSessions.listProcesses,
    ...execFileOps,

    async provision(layers: WorkspaceLayer[], provOpts?: ProvisionOptions): Promise<SandboxHandle> {
      const scratch = provOpts?.scratch;
      const writable = layers.find((l) => l.mode === "rw") ?? layers[0];
      const scope = writable?.scopeId ?? "default";
      const name = scratch ? smolScratchName(scratch.key) : smolMachineName(scope);

      const body = await provisionQueue(scratch ? `scratch:${scratch.key}` : scope, async () => {
        const ensured = await ensureMachine(name, scratch ? undefined : scope);
        if (scratch) scratchByKey.set(scratch.key, ensured.id);
        activeById.set(ensured.id, (activeById.get(ensured.id) ?? 0) + 1);
        return ensured;
      });

      const env = provOpts?.env && Object.keys(provOpts.env).length ? provOpts.env : undefined;
      const handle: SandboxHandle = {
        id: body.id,
        rootDir: workspaceDir,
        homeDir,
        coldStart: body.coldStart,
        ...(scratch ? { scratch: true } : {}),
        ...(env ? { env } : {}),
      };

      try {
        const prep = await execRaw(body.id, `mkdir -p ${shq(workspaceDir)} && ${ephemeralCredLinkScript(homeDir)}`, 60);
        if (prep.code !== 0) throw new Error(`smol sandbox provision prep failed: ${prep.stderr.slice(0, 200)}`);

        await materializeRoLayers(
          workspace,
          layers,
          handle,
          {
            readFile: (h, rel) => sandbox.readFile(h, rel),
            writeFileBytes: (h, rel, data) => sandbox.writeFileBytes(h, rel, data),
            exec: (script, t) => execRaw(body.id, script, t),
          },
          { manifest: RO_LAYERS_MANIFEST, tar: RO_LAYERS_TAR, label: "smol" },
        );

        return handle;
      } catch (err) {
        await sandbox.teardown(handle).catch(swallowAs("smol-sandbox: teardown after failed provision", undefined));
        throw err;
      }
    },

    async run(handle, command, execOpts?: ExecOptions): Promise<ExecResult> {
      const timeoutSec = execOpts?.timeoutMs ? Math.ceil(execOpts.timeoutMs / 1000) : defaultTimeoutSec;
      await bringUp(handle.id);
      const exports = Object.entries(handle.env ?? {})
        .map(([k, v]) => `export ${k}=${shq(v)}`)
        .join("; ");
      const script = `${nonInteractiveShellPrefix()}${exports ? exports + "; " : ""}cd ${handle.rootDir} 2>/dev/null; ${command}`;
      const signal = execOpts?.signal;
      if (!signal) return execRaw(handle.id, script, timeoutSec);
      const killUid = randomUUID();
      const fireKill = () => {
        execRaw(handle.id, killScript(killUid), 15).catch(swallowAs("smol-sandbox: kill in-flight exec", undefined));
      };
      if (signal.aborted) fireKill();
      const onAbort = () => fireKill();
      signal.addEventListener("abort", onAbort, { once: true });
      try {
        return await execRaw(handle.id, killableScript(script, killUid), timeoutSec, signal);
      } finally {
        signal.removeEventListener("abort", onAbort);
      }
    },

    async writeFileBytes(handle, relPath, data): Promise<void> {
      await writeAbsBytes(handle.id, posixJoin(handle.rootDir, relPath), data);
    },
    async writeFile(handle, relPath, data): Promise<void> {
      await sandbox.writeFileBytes(handle, relPath, Buffer.from(data, "utf8"));
    },
    async readFileBytes(handle, relPath): Promise<Uint8Array | null> {
      return readAbsBytes(handle.id, posixJoin(handle.rootDir, relPath));
    },
    async readFile(handle, relPath): Promise<string | null> {
      const bytes = await sandbox.readFileBytes(handle, relPath);
      return bytes === null ? null : Buffer.from(bytes).toString("utf8");
    },

    backupComputer: execBackup.backupComputer,

    async teardown(handle, tdOpts?: TeardownOptions): Promise<void> {
      return provisionQueue(teardownQueueKey(handle), async () => {
        const remaining = (activeById.get(handle.id) ?? 1) - 1;
        if (remaining > 0) {
          activeById.set(handle.id, remaining);
          return;
        }
        activeById.delete(handle.id);

        const forget = (): void => {
          for (const [n, id] of idByName) if (id === handle.id) idByName.delete(n);
          for (const [k, id] of scratchByKey) if (id === handle.id) scratchByKey.delete(k);
          scopeById.delete(handle.id);
        };

        if (handle.scratch || tdOpts?.destroy) {
          await api.deleteMachine(handle.id).catch(swallowAs("smol-sandbox: destroy machine", undefined));
          forget();
          return;
        }

        if (tdOpts?.keepWarm) return;

        // Park it: stopping preserves the machine's disk, so the next provision for this
        // scope restarts the same computer with its installed tools intact.
        try {
          await api.stopMachine(handle.id);
        } catch (e) {
          opts.onError?.({
            category: "sandbox_park",
            code: "smol_stop_failed",
            message: errMessage(e),
            ...(scopeById.get(handle.id) ? { scopeLabel: scopeById.get(handle.id)! } : {}),
          });
        }
      });
    },
  };

  return sandbox;
}
