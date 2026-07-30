import { Machine } from "smolmachines";
import { errMessage } from "../util/errors.ts";

/**
 * Thin adapter over the official `smolmachines` SDK, exposing only what the sandbox
 * backend needs.
 *
 * Going through the SDK rather than hand-rolling HTTP keeps the wire shapes the vendor's
 * problem. The hand-rolled client this replaced sent `cpus`/`memoryMb` at the top level
 * where the API nests them under `resources`; the server accepted that with a 200 and
 * silently ignored it, so every computer came up at the fallback size.
 *
 * One REST call remains. The SDK addresses machines by id (`Machine.connect`) and the
 * control plane does not resolve names — `GET /v1/machines/<name>` is a 404 — but a
 * scope's computer has to be findable by its stable name across process restarts, so
 * listing is the only way to map name to id.
 */

export const SMOL_DEFAULT_BASE_URL = "https://api.smolmachines.com";

export interface SmolApiOptions {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export interface SmolMachine {
  id: string;
  name: string | null;
  state: string;
  /** The machine's app URL, present once it publishes a port. */
  url?: string;
}

/** `allowedHosts` empty means unrestricted; a non-empty list is enforced by the fleet. */
export interface SmolNetwork {
  allowedHosts?: readonly string[];
  allowedCidrs?: readonly string[];
  blocked?: boolean;
}

export interface SmolCreateOptions {
  name: string;
  image: string;
  cpus?: number;
  memoryMb?: number;
  network?: SmolNetwork;
  /** Guest ports to publish. Required for a machine that serves HTTP. */
  ports?: number[];
  /**
   * Idle seconds before the fleet stops the machine.
   *
   * Leaving this unset does NOT mean "never": the control plane applies a fleet-wide
   * default to any machine that publishes a port, on the assumption that such a machine
   * restarts its workload on boot and so can safely scale to zero. Pass a value explicitly
   * to opt out of that assumption.
   */
  autoStopSeconds?: number;
  /**
   * Wait for the machine to report READY before returning (default true).
   *
   * Readiness for a port-publishing machine includes "the published port accepts
   * connections", which cannot happen before the workload is uploaded — and the upload
   * needs the machine first. Set false to break that circle: the machine still exists and
   * its agent still comes up, so the caller can poll for what it actually needs.
   */
  waitForReady?: boolean;
}

export interface SmolExecOptions {
  command: string;
  timeoutSec: number;
  signal?: AbortSignal;
}

export interface SmolExecResult {
  stdout: Uint8Array;
  stderr: Uint8Array;
  exitCode: number;
}

export interface SmolApi {
  listMachines(): Promise<SmolMachine[]>;
  getMachine(id: string): Promise<SmolMachine | null>;
  createMachine(opts: SmolCreateOptions): Promise<SmolMachine>;
  /**
   * Start a machine. `waitForReady: false` returns once the start is issued — needed for a
   * machine publishing a port whose workload is not installed yet, since readiness there
   * includes the port answering.
   */
  startMachine(id: string, opts?: { waitForReady?: boolean }): Promise<void>;
  stopMachine(id: string): Promise<void>;
  deleteMachine(id: string): Promise<void>;
  exec(id: string, opts: SmolExecOptions): Promise<SmolExecResult>;
  readFile(id: string, path: string): Promise<Uint8Array | null>;
  writeFile(id: string, path: string, data: Uint8Array): Promise<void>;
  /** Grant account-less access to this machine's published app URL. */
  makePublic(id: string): Promise<string | null>;
}

export class SmolApiError extends Error {
  readonly status: number;
  constructor(status: number, path: string, body: string) {
    super(`smol api ${path} failed (${status}): ${body.slice(0, 300)}`);
    this.name = "SmolApiError";
    this.status = status;
  }
}

const asBytes = (b: Uint8Array | undefined): Uint8Array => (b ? new Uint8Array(b) : new Uint8Array(0));

/**
 * Egress belongs under `resources`, not at the top level of the machine config: the SDK
 * derives the wire `network` block from `resources.network` / `allowHosts` / `allowCidrs`
 * and ignores anything else. A top-level `network` object is accepted by the type cast and
 * then silently dropped — the allow-list would go unenforced while the profile still
 * claimed `egressEnforcement: "domain"`.
 *
 * `network: false` is the SDK default, so "no allow-list" must say `network: true`
 * explicitly rather than leaving egress to a default.
 */
function egressResources(net: SmolNetwork | undefined): {
  network?: boolean;
  allowHosts?: string[];
  allowCidrs?: string[];
} {
  if (net?.blocked) return { network: false };
  const allowHosts = [...(net?.allowedHosts ?? [])];
  const allowCidrs = [...(net?.allowedCidrs ?? [])];
  if (allowHosts.length || allowCidrs.length) return { allowHosts, allowCidrs };
  return { network: true };
}

/**
 * The wire shape of the egress block, for the raw create path.
 *
 * The SDK derives this from `resources` (see `egressResources`); a raw POST has to spell it
 * out. Both must agree, so keep them adjacent.
 */
function networkBody(net: SmolNetwork | undefined): Record<string, unknown> {
  if (net?.blocked) return { mode: "blocked" };
  const hosts = [...(net?.allowedHosts ?? [])];
  const cidrs = [...(net?.allowedCidrs ?? [])];
  if (hosts.length || cidrs.length) return { mode: "allowCidrs", hosts, cidrs };
  return { mode: "open" };
}

/** A missing file must read back as `null`, not as a thrown error. */
function isNotFound(e: unknown): boolean {
  const msg = errMessage(e).toLowerCase();
  return msg.includes("no such file") || msg.includes("not found") || msg.includes("enoent");
}

export function createSmolApi(opts: SmolApiOptions): SmolApi {
  const baseUrl = (opts.baseUrl ?? SMOL_DEFAULT_BASE_URL).replace(/\/+$/, "");
  const fetchImpl = opts.fetchImpl ?? fetch;
  const conn = { target: "cloud" as const, apiKey: opts.apiKey, baseUrl };

  // Each `connect` is a round trip and the backend touches the same computer many times
  // within one turn, so keep the handles. A failed connect must not poison the cache.
  const handles = new Map<string, Promise<Machine>>();
  const handle = (id: string): Promise<Machine> => {
    let m = handles.get(id);
    if (!m) {
      m = Machine.connect(id, conn).catch((e: unknown) => {
        handles.delete(id);
        throw e;
      });
      handles.set(id, m);
    }
    return m;
  };

  /**
   * Resume a stopped machine.
   *
   * The SDK has `stop()` and `delete()` but no `start()`, so a parked computer cannot be
   * brought back through it at all — and `waitUntilReady()` does not start one either, it
   * throws on a stopped state. Parking is this backend's whole persistence story
   * (`resident_disk`), so the resume path has to go straight to the REST endpoint.
   */
  async function startRaw(id: string): Promise<void> {
    const path = `/v1/machines/${encodeURIComponent(id)}/start`;
    let res: Response;
    try {
      res = await fetchImpl(`${baseUrl}${path}`, {
        method: "POST",
        headers: { authorization: `Bearer ${opts.apiKey}` },
        signal: AbortSignal.timeout(120_000),
      });
    } catch (e) {
      throw new Error(`smol api ${path} unreachable: ${errMessage(e)}`, { cause: e });
    }
    // Starting an already-started machine is a no-op fast-path (200), so two callers racing
    // to wake the same computer both succeed. A 409 is tolerated for the same reason: the
    // desired end state is "running", and someone else having got there first is not a
    // failure.
    if (res.status === 409) return;
    if (res.status < 200 || res.status >= 300) throw new SmolApiError(res.status, path, await res.text());
  }

  /**
   * Create a machine WITHOUT waiting for readiness.
   *
   * `Machine.create` blocks until the machine reports ready, and for a machine that
   * publishes a port readiness includes "the port accepts connections" — which cannot
   * happen before its workload is installed, and installing needs the machine. Worse, the
   * control plane REAPS a machine that never becomes ready, so waiting does not merely
   * time out, it destroys the machine (verified: the id 404s afterwards).
   *
   * Exec, however, works as soon as the guest agent is up and long before the port answers
   * (measured ~11s), so the caller can create, start, upload and launch inside that window.
   */
  async function createRaw(create: SmolCreateOptions): Promise<SmolMachine> {
    const network = networkBody(create.network);
    const body = {
      name: create.name,
      source: { type: "image", reference: create.image },
      resources: {
        ...(create.cpus ? { cpus: create.cpus } : {}),
        ...(create.memoryMb ? { memoryMb: create.memoryMb } : {}),
      },
      network,
      ...(create.ports?.length ? { ports: create.ports.map((port) => ({ port })) } : {}),
      ...(create.autoStopSeconds !== undefined ? { autoStopSeconds: create.autoStopSeconds } : {}),
    };
    let res: Response;
    try {
      res = await fetchImpl(`${baseUrl}/v1/machines`, {
        method: "POST",
        headers: { authorization: `Bearer ${opts.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(120_000),
      });
    } catch (e) {
      throw new Error(`smol api /v1/machines unreachable: ${errMessage(e)}`, { cause: e });
    }
    const text = await res.text();
    if (res.status < 200 || res.status >= 300) throw new SmolApiError(res.status, "/v1/machines", text);
    return asMachine(JSON.parse(text) as Record<string, unknown>);
  }

  async function listRaw(): Promise<Record<string, unknown>[]> {
    let res: Response;
    try {
      res = await fetchImpl(`${baseUrl}/v1/machines`, {
        headers: { authorization: `Bearer ${opts.apiKey}` },
        signal: AbortSignal.timeout(60_000),
      });
    } catch (e) {
      throw new Error(`smol api /v1/machines unreachable: ${errMessage(e)}`, { cause: e });
    }
    const text = await res.text();
    if (res.status < 200 || res.status >= 300) throw new SmolApiError(res.status, "/v1/machines", text);
    const parsed: unknown = JSON.parse(text);
    const rows = Array.isArray(parsed)
      ? parsed
      : ((parsed as { machines?: unknown[] }).machines ?? (parsed as { data?: unknown[] }).data ?? []);
    return rows as Record<string, unknown>[];
  }

  const asMachine = (m: Record<string, unknown>): SmolMachine => ({
    id: String(m.id ?? ""),
    name: typeof m.name === "string" ? m.name : null,
    state: String(m.state ?? "unknown"),
    ...(typeof m.url === "string" && m.url ? { url: m.url } : {}),
  });

  return {
    async listMachines(): Promise<SmolMachine[]> {
      return (await listRaw()).map(asMachine);
    },

    async getMachine(id: string): Promise<SmolMachine | null> {
      try {
        const m = await handle(id);
        return { id, name: m.name ?? null, state: await m.state() };
      } catch (e) {
        if (isNotFound(e)) {
          handles.delete(id);
          return null;
        }
        throw e;
      }
    },

    async createMachine(create: SmolCreateOptions): Promise<SmolMachine> {
      const config = {
        name: create.name,
        image: create.image,
        resources: {
          ...(create.cpus ? { cpus: create.cpus } : {}),
          ...(create.memoryMb ? { memoryMb: create.memoryMb } : {}),
          ...egressResources(create.network),
        },
        // Only the guest port matters on cloud — the control plane allocates the host side.
        ...(create.ports?.length ? { ports: create.ports.map((guest) => ({ host: guest, guest })) } : {}),
      };
      if (create.waitForReady === false) return createRaw(create);
      const m = await Machine.create(config, conn);
      // `Machine` exposes only `name`, but every other call addresses machines by id, so
      // the id has to come back from a listing. Cold start only.
      const state = await m.state();
      const created = (await listRaw()).map(asMachine).find((row) => row.name === create.name);
      if (!created) throw new Error(`smol api: created machine ${create.name} did not appear in the listing`);
      handles.set(created.id, Promise.resolve(m));
      return { ...created, state };
    },

    async startMachine(id: string, startOpts?: { waitForReady?: boolean }): Promise<void> {
      if (startOpts?.waitForReady === false) {
        await startRaw(id);
        return;
      }
      const m = await handle(id);
      // Start first, then wait. `waitUntilReady()` THROWS on a stopped machine rather than
      // starting it, so waiting alone would strand every parked computer at
      // "stopped, not yet ready" forever. Issue the start whenever the machine is not
      // already running; `startRaw` treats an already-started 409 as success.
      if ((await m.state()) !== "running") await startRaw(id);
      // Still required after a start (and after `create`, despite the SDK doc): the state
      // reaches "started" while the guest agent is still booting and exec would fail.
      await m.waitUntilReady();
    },

    async stopMachine(id: string): Promise<void> {
      await (await handle(id)).stop();
    },

    async deleteMachine(id: string): Promise<void> {
      try {
        await (await handle(id)).delete();
      } catch (e) {
        if (!isNotFound(e)) throw e;
      } finally {
        handles.delete(id);
      }
    },

    async exec(id: string, execOpts: SmolExecOptions): Promise<SmolExecResult> {
      const m = await handle(id);
      // The backend composes shell scripts — pipes, redirection, `&&` — so hand the whole
      // string to a shell rather than splitting it into argv.
      const r = await m.exec(["sh", "-c", execOpts.command], { timeout: execOpts.timeoutSec });
      // The `*Bytes` fields, not the strings: the cloud caps text `stdout`/`stderr` at
      // 1 MiB and replaces invalid UTF-8, while these stay byte-exact and untruncated.
      return {
        stdout: asBytes(r.stdoutBytes),
        stderr: asBytes(r.stderrBytes),
        exitCode: r.exitCode ?? 0,
      };
    },

    async readFile(id: string, path: string): Promise<Uint8Array | null> {
      try {
        return asBytes(await (await handle(id)).readFile(path));
      } catch (e) {
        if (isNotFound(e)) return null;
        throw e;
      }
    },

    async writeFile(id: string, path: string, data: Uint8Array): Promise<void> {
      await (await handle(id)).writeFile(path, data);
    },

    async makePublic(id: string): Promise<string | null> {
      // No SDK method for this; the control plane owns anonymous app ingress.
      const path = `/v1/machines/${encodeURIComponent(id)}/public`;
      let res: Response;
      try {
        res = await fetchImpl(`${baseUrl}${path}`, {
          method: "POST",
          headers: { authorization: `Bearer ${opts.apiKey}` },
          signal: AbortSignal.timeout(60_000),
        });
      } catch (e) {
        throw new Error(`smol api ${path} unreachable: ${errMessage(e)}`, { cause: e });
      }
      const text = await res.text();
      if (res.status < 200 || res.status >= 300) throw new SmolApiError(res.status, path, text);
      const parsed = JSON.parse(text) as { url?: unknown };
      return typeof parsed.url === "string" ? parsed.url : null;
    },
  };
}
