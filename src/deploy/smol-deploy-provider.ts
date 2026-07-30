import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import type { Deployment, DeploymentVersion } from "./deploy-store.ts";
import type { DeployEndpoint, DeployProvider } from "./deploy-provider.ts";
import { createSmolApi, type SmolApi, type SmolApiOptions, type SmolNetwork } from "../sandbox/smol-api.ts";
import { makeTar } from "../sandbox/tar.ts";
import { shq } from "../util/shell.ts";
import { sleep } from "../util/async.ts";
import { swallowAs } from "../util/errors.ts";

/**
 * Runs each deployed app as its own smol machine, so publishing needs no Docker daemon on
 * the host — the same reason the `smol` sandbox backend exists. The Docker provider shells
 * out to `docker run`, which on a Docker-less host fails with `spawn docker ENOENT`.
 *
 * The app is served from the machine's own public URL rather than proxied from a private
 * port, so anyone with the link can reach it.
 */

const APP_PORT = 8080;
const APP_DIR = "/app";
/** Big enough for an app bundle, small enough that a runaway upload fails fast. */
const MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024;

export interface SmolDeployProviderOptions extends Partial<SmolApiOptions> {
  apiKey?: string;
  image?: string;
  cpus?: number;
  memoryMb?: number;
  network?: SmolNetwork;
  api?: SmolApi;
  /** How long to wait for the app to answer on its port before giving up. */
  readyTimeoutMs?: number;
}

const machineName = (d: Deployment): string =>
  `qm-deploy-${d.id
    .slice(0, 12)
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")}`;

/** Collect a snapshot directory into tar entries, refusing anything implausibly large. */
async function collectSnapshot(dir: string): Promise<{ path: string; data: Uint8Array }[]> {
  const out: { path: string; data: Uint8Array }[] = [];
  let total = 0;
  const walk = async (cur: string): Promise<void> => {
    for (const entry of await readdir(cur, { withFileTypes: true })) {
      const abs = join(cur, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === ".git" || entry.name === "node_modules") continue;
        await walk(abs);
        continue;
      }
      if (!entry.isFile()) continue;
      const info = await stat(abs);
      total += info.size;
      if (total > MAX_SNAPSHOT_BYTES) {
        throw new Error(`smol deploy: snapshot exceeds ${MAX_SNAPSHOT_BYTES} bytes`);
      }
      out.push({ path: relative(dir, abs), data: new Uint8Array(await readFile(abs)) });
    }
  };
  await walk(dir);
  return out;
}

export function createSmolDeployProvider(opts: SmolDeployProviderOptions = {}): DeployProvider {
  const apiKey = opts.apiKey ?? "";
  if (!opts.api && !apiKey) throw new Error("DEPLOY_PROVIDER=smol requires SMOL_API_KEY");
  const api =
    opts.api ??
    createSmolApi({
      apiKey,
      ...(opts.baseUrl ? { baseUrl: opts.baseUrl } : {}),
      ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    });
  const image = opts.image ?? "docker.io/library/node:24-slim";
  const readyTimeoutMs = opts.readyTimeoutMs ?? 120_000;

  const exec = async (id: string, command: string, timeoutSec: number) => {
    const r = await api.exec(id, { command, timeoutSec });
    return {
      code: r.exitCode,
      stdout: Buffer.from(r.stdout).toString("utf8"),
      stderr: Buffer.from(r.stderr).toString("utf8"),
    };
  };

  /** Replace any existing machine for this deployment: a deploy is a fresh app, not a patch. */
  async function recreate(name: string): Promise<string> {
    const existing = (await api.listMachines()).find((m) => m.name === name);
    if (existing) await api.deleteMachine(existing.id).catch(swallowAs("smol-deploy: replace existing", undefined));
    const created = await api.createMachine({
      name,
      image,
      ports: [APP_PORT],
      // Readiness here means "the app port answers", which it cannot until we have uploaded
      // the app. Wait for the agent instead — see waitForAgent.
      waitForReady: false,
      ...(opts.cpus ? { cpus: opts.cpus } : {}),
      ...(opts.memoryMb ? { memoryMb: opts.memoryMb } : {}),
      ...(opts.network ? { network: opts.network } : {}),
    });
    // Start without waiting for readiness — the port cannot answer until the app is
    // installed, and the control plane reaps a machine that never becomes ready.
    await api.startMachine(created.id, { waitForReady: false });
    await waitForAgent(created.id);
    return created.id;
  }

  /**
   * Wait until the in-VM agent answers a command.
   *
   * This is the real precondition for uploading an app, and unlike machine "readiness" it
   * does not depend on the app already listening on the published port.
   */
  async function waitForAgent(id: string): Promise<void> {
    const deadline = Date.now() + readyTimeoutMs;
    let last = "";
    while (Date.now() < deadline) {
      try {
        const r = await exec(id, "echo agent-up", 30);
        if (r.code === 0) return;
        last = r.stderr.slice(0, 120);
      } catch (e) {
        last = e instanceof Error ? e.message : String(e);
      }
      await sleep(1000);
    }
    throw new Error(`smol deploy: machine ${id} agent never answered${last ? ` (${last})` : ""}`);
  }

  /** Poll the app's own URL until it answers, so a deploy does not report success early. */
  async function waitForApp(url: string): Promise<void> {
    const deadline = Date.now() + readyTimeoutMs;
    let last = "";
    while (Date.now() < deadline) {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(10_000), redirect: "manual" });
        // Any HTTP answer means the app is listening; its own status codes are its business.
        if (res.status > 0) return;
      } catch (e) {
        last = e instanceof Error ? e.message : String(e);
      }
      await sleep(1000);
    }
    throw new Error(`smol deploy: app did not answer at ${url} within ${readyTimeoutMs}ms${last ? ` (${last})` : ""}`);
  }

  return {
    profile: { managedScaleToZero: false },

    async apply(d: Deployment, version: DeploymentVersion): Promise<DeployEndpoint> {
      const name = machineName(d);
      const id = await recreate(name);

      const files = await collectSnapshot(version.snapshotDir);
      if (files.length) {
        const tar = await makeTar(files);
        const tmp = `${APP_DIR}/.deploy.tar`;
        const mk = await exec(id, `mkdir -p ${shq(APP_DIR)}`, 60);
        if (mk.code !== 0) throw new Error(`smol deploy: mkdir ${APP_DIR} failed: ${mk.stderr.slice(0, 200)}`);
        await api.writeFile(id, tmp, tar);
        const untar = await exec(id, `cd ${shq(APP_DIR)} && tar -xf ${shq(tmp)} && rm -f ${shq(tmp)}`, 180);
        if (untar.code !== 0) throw new Error(`smol deploy: unpack failed: ${untar.stderr.slice(0, 200)}`);
      }

      // Detached, and surviving the exec that launched it — otherwise the app dies with the
      // command's process group the moment `exec` returns.
      const envExports = Object.entries({ PORT: String(APP_PORT), ...(version.env ?? {}) })
        .map(([k, v]) => `export ${k}=${shq(v)}`)
        .join("; ");
      const launch = await exec(
        id,
        `cd ${shq(APP_DIR)} && ${envExports}; setsid nohup sh -c ${shq(version.entrypoint)} > /var/log/qm-app.log 2>&1 < /dev/null & echo started`,
        120,
      );
      if (launch.code !== 0) throw new Error(`smol deploy: entrypoint launch failed: ${launch.stderr.slice(0, 200)}`);

      // The app URL only answers anonymously once the machine is granted public access.
      const publicUrl = (await api.makePublic(id)) ?? (await api.getMachine(id))?.url;
      if (!publicUrl) throw new Error(`smol deploy: machine ${id} has no app URL`);
      await waitForApp(publicUrl);

      const u = new URL(publicUrl);
      return {
        host: u.hostname,
        port: u.port ? Number(u.port) : 443,
        tls: u.protocol === "https:",
        publicUrl,
        image,
      };
    },

    async destroy(d: Deployment): Promise<void> {
      const name = machineName(d);
      const existing = (await api.listMachines()).find((m) => m.name === name);
      if (existing) await api.deleteMachine(existing.id);
    },

    async resolveEndpoint(d: Deployment): Promise<DeployEndpoint | null> {
      const name = machineName(d);
      const existing = (await api.listMachines()).find((m) => m.name === name);
      if (!existing?.url) return null;
      const u = new URL(existing.url);
      return {
        host: u.hostname,
        port: u.port ? Number(u.port) : 443,
        tls: u.protocol === "https:",
        publicUrl: existing.url,
        image,
      };
    },
  };
}
