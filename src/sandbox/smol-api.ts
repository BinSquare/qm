import { errMessage } from "../util/errors.ts";

/**
 * Minimal client for the smol machines control plane. Deliberately dependency-free
 * (plain `fetch`) so the sandbox backend does not pull an SDK whose version has to be
 * kept in lockstep with the fleet — the handful of routes used here are stable.
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
  stdin?: string;
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
}

export class SmolApiError extends Error {
  readonly status: number;
  constructor(status: number, path: string, body: string) {
    super(`smol api ${path} failed (${status}): ${body.slice(0, 300)}`);
    this.name = "SmolApiError";
    this.status = status;
  }
}

/**
 * The control plane serializes `network` as a tagged union on `mode`. `blocked` also
 * blocks the in-guest image pull, so it is only ever sent when explicitly requested.
 */
function networkBody(net: SmolNetwork | undefined): unknown {
  if (net?.blocked) return { mode: "blocked" };
  const hosts = net?.allowedHosts ?? [];
  const cidrs = net?.allowedCidrs ?? [];
  if (!hosts.length && !cidrs.length) return { mode: "open" };
  return { mode: "allowCidrs", hosts: [...hosts], cidrs: [...cidrs] };
}

const b64ToBytes = (s: string | undefined): Uint8Array =>
  s ? new Uint8Array(Buffer.from(s, "base64")) : new Uint8Array(0);

export function createSmolApi(opts: SmolApiOptions): SmolApi {
  const baseUrl = (opts.baseUrl ?? SMOL_DEFAULT_BASE_URL).replace(/\/+$/, "");
  const fetchImpl = opts.fetchImpl ?? fetch;

  async function call(
    method: string,
    path: string,
    body?: unknown,
    timeoutMs = 60_000,
    signal?: AbortSignal,
  ): Promise<{ status: number; text: string }> {
    const signals = [AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])];
    let res: Response;
    try {
      res = await fetchImpl(`${baseUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${opts.apiKey}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.any(signals),
      });
    } catch (e) {
      throw new Error(`smol api ${path} unreachable: ${errMessage(e)}`);
    }
    return { status: res.status, text: await res.text() };
  }

  async function callOk(
    method: string,
    path: string,
    body?: unknown,
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<string> {
    const r = await call(method, path, body, timeoutMs, signal);
    if (r.status < 200 || r.status >= 300) throw new SmolApiError(r.status, path, r.text);
    return r.text;
  }

  const asMachine = (m: Record<string, unknown>): SmolMachine => ({
    id: String(m.id ?? ""),
    name: typeof m.name === "string" ? m.name : null,
    state: String(m.state ?? "unknown"),
  });

  return {
    async listMachines(): Promise<SmolMachine[]> {
      const text = await callOk("GET", "/v1/machines");
      const parsed: unknown = JSON.parse(text);
      const rows = Array.isArray(parsed)
        ? parsed
        : ((parsed as { machines?: unknown[] }).machines ?? (parsed as { data?: unknown[] }).data ?? []);
      return (rows as Record<string, unknown>[]).map(asMachine);
    },

    async getMachine(id: string): Promise<SmolMachine | null> {
      const r = await call("GET", `/v1/machines/${encodeURIComponent(id)}`);
      if (r.status === 404) return null;
      if (r.status < 200 || r.status >= 300) throw new SmolApiError(r.status, `/v1/machines/${id}`, r.text);
      return asMachine(JSON.parse(r.text) as Record<string, unknown>);
    },

    async createMachine(create: SmolCreateOptions): Promise<SmolMachine> {
      const text = await callOk(
        "POST",
        "/v1/machines",
        {
          name: create.name,
          source: { type: "image", reference: create.image },
          network: networkBody(create.network),
          // Sizing is nested under `resources`; sending cpus/memoryMb at the top level is
          // silently ignored and the machine comes up with fleet defaults instead.
          ...(create.cpus || create.memoryMb
            ? {
                resources: {
                  ...(create.cpus ? { cpus: create.cpus } : {}),
                  ...(create.memoryMb ? { memoryMb: create.memoryMb } : {}),
                },
              }
            : {}),
        },
        180_000,
      );
      return asMachine(JSON.parse(text) as Record<string, unknown>);
    },

    async startMachine(id: string): Promise<void> {
      await callOk("POST", `/v1/machines/${encodeURIComponent(id)}/start`, {}, 180_000);
    },

    async stopMachine(id: string): Promise<void> {
      await callOk("POST", `/v1/machines/${encodeURIComponent(id)}/stop`, {}, 120_000);
    },

    async deleteMachine(id: string): Promise<void> {
      const r = await call("DELETE", `/v1/machines/${encodeURIComponent(id)}`, undefined, 120_000);
      if (r.status === 404) return;
      if (r.status < 200 || r.status >= 300) throw new SmolApiError(r.status, `/v1/machines/${id}`, r.text);
    },

    async exec(id: string, execOpts: SmolExecOptions): Promise<SmolExecResult> {
      const text = await callOk(
        "POST",
        `/v1/machines/${encodeURIComponent(id)}/exec`,
        {
          command: execOpts.command,
          timeoutSeconds: execOpts.timeoutSec,
          ...(execOpts.stdin === undefined ? {} : { stdin: execOpts.stdin }),
        },
        (execOpts.timeoutSec + 30) * 1000,
        execOpts.signal,
      );
      const j = JSON.parse(text) as {
        exitCode?: number;
        stdoutB64?: string;
        stderrB64?: string;
        stdout?: string;
        stderr?: string;
      };
      // `stdout`/`stderr` are lossy and capped; the b64 fields are byte-exact. Fall back
      // only when the fleet omitted them (older nodes), where truncation is possible.
      return {
        stdout:
          j.stdoutB64 === undefined ? new Uint8Array(Buffer.from(j.stdout ?? "", "utf8")) : b64ToBytes(j.stdoutB64),
        stderr:
          j.stderrB64 === undefined ? new Uint8Array(Buffer.from(j.stderr ?? "", "utf8")) : b64ToBytes(j.stderrB64),
        exitCode: j.exitCode ?? 0,
      };
    },
  };
}
