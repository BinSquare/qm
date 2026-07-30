import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSmolSandbox, smolMachineName } from "../src/sandbox/smol-sandbox.ts";
import type { SmolApi, SmolCreateOptions, SmolExecOptions, SmolMachine } from "../src/sandbox/smol-api.ts";
import { createLocalWorkspaceStore } from "../src/workspace/workspace-store.ts";
import type { ScopeId } from "../src/types.ts";

const workspace = createLocalWorkspaceStore(mkdtempSync(join(tmpdir(), "smol-sbx-")));
const rw = (id: string) => [{ scopeId: id as ScopeId, mountPath: "", mode: "rw" as const }];

interface FakeCall {
  op: string;
  arg?: string;
}

/**
 * Stands in for the control plane. `exec` understands only the handful of shell forms the
 * backend emits, which is what makes the chunked read/write paths verifiable without a VM.
 */
function fakeApi(): SmolApi & { calls: FakeCall[]; machines: Map<string, SmolMachine>; files: Map<string, Buffer> } {
  const machines = new Map<string, SmolMachine>();
  const files = new Map<string, Buffer>();
  const calls: FakeCall[] = [];
  let seq = 0;

  const unq = (s: string): string => s.replace(/^'|'$/g, "").replace(/'\\''/g, "'");

  return {
    calls,
    machines,
    files,
    async listMachines() {
      calls.push({ op: "list" });
      return [...machines.values()];
    },
    async getMachine(id) {
      return machines.get(id) ?? null;
    },
    async createMachine(o: SmolCreateOptions) {
      calls.push({ op: "create", arg: o.name });
      const m: SmolMachine = { id: `mach-${++seq}`, name: o.name, state: "started" };
      machines.set(m.id, m);
      return m;
    },
    async startMachine(id) {
      calls.push({ op: "start", arg: id });
      const m = machines.get(id);
      if (m) m.state = "started";
    },
    async stopMachine(id) {
      calls.push({ op: "stop", arg: id });
      const m = machines.get(id);
      if (m) m.state = "stopped";
    },
    async deleteMachine(id) {
      calls.push({ op: "delete", arg: id });
      machines.delete(id);
    },
    async exec(_id, o: SmolExecOptions) {
      const ok = (out: Buffer | string = "") => ({
        stdout: new Uint8Array(Buffer.isBuffer(out) ? out : Buffer.from(out)),
        stderr: new Uint8Array(0),
        exitCode: 0,
      });
      const cmd = o.command;

      let m = /^: > (.+)$/.exec(cmd);
      if (m) {
        files.set(unq(m[1]!), Buffer.alloc(0));
        return ok();
      }
      m = /^base64 -d >> (.+)$/.exec(cmd);
      if (m) {
        const p = unq(m[1]!);
        files.set(p, Buffer.concat([files.get(p) ?? Buffer.alloc(0), Buffer.from(o.stdin ?? "", "base64")]));
        return ok();
      }
      m = /^\[ -f (.+?) \] \|\| exit 66; stat -c %s (.+)$/.exec(cmd);
      if (m) {
        const f = files.get(unq(m[1]!));
        if (!f) return { stdout: new Uint8Array(0), stderr: new Uint8Array(0), exitCode: 66 };
        return ok(`${f.length}\n`);
      }
      m = /^tail -c \+(\d+) (.+?) \| head -c (\d+)$/.exec(cmd);
      if (m) {
        const f = files.get(unq(m[2]!)) ?? Buffer.alloc(0);
        const start = Number(m[1]) - 1;
        return ok(f.subarray(start, start + Number(m[3])));
      }
      // mkdir / provision prep / anything else the backend runs for effect only
      return ok();
    },
  };
}

const sandboxFor = (api: SmolApi, chunk = 8) =>
  createSmolSandbox(workspace, { api, transferChunkBytes: chunk, homeDir: "/root" });

test("provision creates a machine named for the scope, then reuses it", async () => {
  const api = fakeApi();
  const sbx = sandboxFor(api);

  const h1 = await sbx.provision(rw("personal:alice"));
  assert.equal(api.machines.get(h1.id)?.name, smolMachineName("personal:alice"));
  assert.equal(h1.coldStart, true);
  assert.equal(api.calls.filter((c) => c.op === "create").length, 1);

  await sbx.teardown(h1, { keepWarm: true });
  const h2 = await sbx.provision(rw("personal:alice"));
  assert.equal(h2.id, h1.id, "same scope must land on the same machine");
  assert.equal(h2.coldStart, false);
  assert.equal(api.calls.filter((c) => c.op === "create").length, 1, "must not create a second machine");
});

test("distinct scopes get distinct machines", async () => {
  const api = fakeApi();
  const sbx = sandboxFor(api);
  const a = await sbx.provision(rw("personal:alice"));
  const b = await sbx.provision(rw("personal:bob"));
  assert.notEqual(a.id, b.id);
});

test("teardown parks by default, destroys on request, and keepWarm does neither", async () => {
  const api = fakeApi();
  const sbx = sandboxFor(api);

  const parked = await sbx.provision(rw("personal:park"));
  await sbx.teardown(parked);
  assert.equal(api.machines.get(parked.id)?.state, "stopped", "default teardown must stop, not delete");

  const warm = await sbx.provision(rw("personal:warm"));
  api.calls.length = 0;
  await sbx.teardown(warm, { keepWarm: true });
  assert.deepEqual(
    api.calls.filter((c) => c.op === "stop" || c.op === "delete"),
    [],
    "keepWarm must leave the machine running",
  );

  const doomed = await sbx.provision(rw("personal:doomed"));
  await sbx.teardown(doomed, { destroy: true });
  assert.equal(api.machines.has(doomed.id), false, "destroy must delete the machine");
});

test("file round-trip survives chunking and preserves bytes", async () => {
  const api = fakeApi();
  const sbx = sandboxFor(api, 8); // tiny chunk so a small payload still spans many execs

  const h = await sbx.provision(rw("personal:files"));
  await sbx.writeFile(h, "notes/hello.txt", "hello world");
  assert.equal(await sbx.readFile(h, "notes/hello.txt"), "hello world");

  // Binary, non-UTF8, and larger than several chunks.
  const blob = new Uint8Array(1000);
  for (let i = 0; i < blob.length; i++) blob[i] = (i * 31) % 256;
  await sbx.writeFileBytes(h, "blob.bin", blob);
  const back = await sbx.readFileBytes(h, "blob.bin");
  assert.deepEqual(back && [...back], [...blob], "chunked write/read must be byte-exact");
});

test("empty file writes and reads back as empty, not missing", async () => {
  const api = fakeApi();
  const sbx = sandboxFor(api);
  const h = await sbx.provision(rw("personal:empty"));
  await sbx.writeFileBytes(h, "zero.bin", new Uint8Array(0));
  const back = await sbx.readFileBytes(h, "zero.bin");
  assert.notEqual(back, null, "an empty file must not read back as missing");
  assert.equal(back?.length, 0);
});

test("reading a missing file yields null", async () => {
  const api = fakeApi();
  const sbx = sandboxFor(api);
  const h = await sbx.provision(rw("personal:missing"));
  assert.equal(await sbx.readFile(h, "nope.txt"), null);
});

test("profile reports the microVM substrate and resident disk", async () => {
  const api = fakeApi();
  const sbx = sandboxFor(api);
  assert.equal(sbx.profile.backend, "smol-machines");
  assert.equal(sbx.profile.writablePersistence, "resident_disk");
  assert.equal(sbx.profile.processSessions, true);
  assert.equal(sbx.profile.egressEnforcement, "none");
});

test("an allow-list turns on domain egress enforcement", () => {
  const sbx = createSmolSandbox(workspace, {
    api: fakeApi(),
    network: { allowedHosts: ["api.anthropic.com"] },
  });
  assert.equal(sbx.profile.egressEnforcement, "domain");
});

test("constructing without an api key or client is refused", () => {
  assert.throws(() => createSmolSandbox(workspace), /SMOL_API_KEY/);
});
