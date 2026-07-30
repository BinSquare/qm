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
  startMachine(id: string): Promise<void>;
  stopMachine(id: string): Promise<void>;
  deleteMachine(id: string): Promise<void>;
  exec(id: string, opts: SmolExecOptions): Promise<SmolExecResult>;
  readFile(id: string, path: string): Promise<Uint8Array | null>;
  writeFile(id: string, path: string, data: Uint8Array): Promise<void>;
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
      };
      const m = await Machine.create(config, conn);
      // `Machine` exposes only `name`, but every other call addresses machines by id, so
      // the id has to come back from a listing. Cold start only.
      const state = await m.state();
      const created = (await listRaw()).map(asMachine).find((row) => row.name === create.name);
      if (!created) throw new Error(`smol api: created machine ${create.name} did not appear in the listing`);
      handles.set(created.id, Promise.resolve(m));
      return { ...created, state };
    },

    async startMachine(id: string): Promise<void> {
      // `waitUntilReady` both starts a stopped machine and waits out a start already in
      // flight, which is the race the hand-rolled client had to poll around. It is needed
      // after `create` too: despite the SDK doc saying a cloud create returns ready, a
      // freshly created machine reports state "started" with ready() false.
      await (await handle(id)).waitUntilReady();
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
  };
}
