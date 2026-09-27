// A local stand-in for the smol cloud machine API, backed by the `smolvm` CLI,
// so QM's smolmachines provider can run against real local microVMs:
//
//   node scripts/smolvm-local-api.ts            # listens on 127.0.0.1:8787
//   SMOLMACHINES_BASE_URL=http://127.0.0.1:8787 SMOLMACHINES_TOKEN=local ...
//
// It implements only the calls the provider makes: machines (list, create,
// get, start, delete), exec, files, and checkpoint capture and restore.
// Machine ids are machine names.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const SMOLVM = process.env.SMOLVM ?? join(homedir(), ".smolvm/smolvm");
const PORT = Number(process.env.PORT ?? 8787);
const STORE = process.env.CHECKPOINT_STORE ?? join(homedir(), ".cache/smolvm-local-api/checkpoints");
mkdirSync(STORE, { recursive: true });

function smolvm(args: string[], input?: Buffer) {
  const r = spawnSync(SMOLVM, args, { input, maxBuffer: 256 * 1024 * 1024 });
  return { code: r.status ?? -1, stdout: r.stdout ?? Buffer.alloc(0), stderr: r.stderr ?? Buffer.alloc(0) };
}

function list(): Array<{ name: string; state: string }> {
  const r = smolvm(["machine", "ls", "--json"]);
  const rows = JSON.parse(r.stdout.toString() || "[]");
  return (Array.isArray(rows) ? rows : rows.machines ?? []).map((m: any) => ({ name: m.name, state: m.state }));
}

function info(name: string) {
  const m = list().find((x) => x.name === name);
  if (!m) return null;
  const running = m.state === "running";
  return { id: name, name, state: running ? "running" : m.state, ready: running, network: { mode: "open" } };
}

async function body(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

function json(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(value));
}

function text(res: ServerResponse, status: number, message: string) {
  res.writeHead(status, { "content-type": "text/plain" });
  res.end(message);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://local");
  const method = req.method ?? "GET";
  const path = url.pathname;
  try {
    if (path === "/v1/machines" && method === "GET") return json(res, 200, list().map((m) => info(m.name)));

    if (path === "/v1/machines" && method === "POST") {
      const b = JSON.parse((await body(req)).toString() || "{}");
      if (list().some((m) => m.name === b.name)) return text(res, 409, "name taken");
      const args = ["machine", "create", "--name", b.name, "--image", b.source?.reference ?? "ubuntu:24.04", "--net"];
      if (b.resources?.cpus) args.push("--cpus", String(b.resources.cpus));
      if (b.resources?.memoryMb) args.push("--mem", String(b.resources.memoryMb));
      const r = smolvm([...args, "--", "sleep", "infinity"]);
      if (r.code !== 0) return text(res, 500, r.stderr.toString());
      return json(res, 201, info(b.name));
    }

    const capture = /^\/v1\/machines\/([^/]+)\/checkpoints$/.exec(path);
    if (capture && method === "POST") {
      const name = decodeURIComponent(capture[1]!);
      const id = `ckpt-${name}-${Date.now()}`;
      const r = smolvm(["machine", "checkpoint", "-n", name, "--store", STORE, "-o", join(STORE, `${id}.smolcheckpoint`)]);
      if (r.code !== 0) return text(res, 500, r.stderr.toString());
      return json(res, 201, { id, machineId: name, status: "available" });
    }

    const restore = /^\/v1\/checkpoints\/([^/]+)\/restore$/.exec(path);
    if (restore && method === "POST") {
      const id = decodeURIComponent(restore[1]!);
      const b = JSON.parse((await body(req)).toString() || "{}");
      if (list().some((m) => m.name === b.name)) return text(res, 409, "name taken");
      const r = smolvm(["machine", "create", "--name", b.name, "--from", join(STORE, `${id}.smolcheckpoint`)]);
      if (r.code !== 0) return text(res, 500, r.stderr.toString());
      return json(res, 201, info(b.name));
    }

    const files = /^\/v1\/machines\/([^/]+)\/files(\/.+)$/.exec(path);
    if (files) {
      const name = decodeURIComponent(files[1]!);
      const abs = files[2]!.split("/").map(decodeURIComponent).join("/");
      const dir = mkdtempSync(join(tmpdir(), "smolvm-local-api-"));
      try {
        const local = join(dir, "f");
        if (method === "PUT") {
          writeFileSync(local, await body(req));
          smolvm(["machine", "exec", "--name", name, "--", "sh", "-c", `mkdir -p "$(dirname '${abs}')"`]);
          const r = smolvm(["machine", "cp", local, `${name}:${abs}`]);
          return r.code === 0 ? json(res, 200, {}) : text(res, 500, r.stderr.toString());
        }
        const exists = smolvm(["machine", "exec", "--name", name, "--", "test", "-f", abs]);
        if (exists.code !== 0) return text(res, 404, "file not found");
        const r = smolvm(["machine", "cp", `${name}:${abs}`, local]);
        if (r.code !== 0) return text(res, 500, r.stderr.toString());
        res.writeHead(200, { "content-type": "application/octet-stream" });
        return res.end(readFileSync(local));
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }

    const sub = /^\/v1\/machines\/([^/]+)(?:\/(exec|start|stop))?$/.exec(path);
    if (sub) {
      const name = decodeURIComponent(sub[1]!);
      const current = info(name);
      if (!current) return text(res, 404, "machine not found");
      if (sub[2] === "exec") {
        if (current.state !== "running") return text(res, 409, "machine is stopped");
        const b = JSON.parse((await body(req)).toString() || "{}");
        const argv: string[] = Array.isArray(b.command) ? b.command : ["sh", "-c", b.command ?? ""];
        const r = smolvm(["machine", "exec", "--name", name, "--", ...argv]);
        return json(res, 200, {
          stdout: r.stdout.toString(),
          stderr: r.stderr.toString(),
          exitCode: r.code,
          stdoutB64: r.stdout.toString("base64"),
          stderrB64: r.stderr.toString("base64"),
        });
      }
      if (sub[2] === "start") {
        // Branchable: guest RAM that `machine checkpoint` can capture live.
        if (current.state !== "running") smolvm(["machine", "start", "--name", name, "--branchable"]);
        return json(res, 200, info(name));
      }
      if (sub[2] === "stop") {
        smolvm(["machine", "stop", "--name", name]);
        return json(res, 200, info(name));
      }
      if (method === "GET") return json(res, 200, current);
      if (method === "DELETE") {
        smolvm(["machine", "delete", "--name", name, "-f"]);
        res.writeHead(204);
        return res.end();
      }
    }
    return text(res, 404, "not found");
  } catch (e) {
    return text(res, 500, String(e));
  }
});

server.listen(PORT, "127.0.0.1", () => console.log(`smolvm local API on http://127.0.0.1:${PORT}`));
