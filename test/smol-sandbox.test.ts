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
 * Stands in for the control plane. File transfer is a first-class API call, so the fake
 * backs it with a map instead of having to emulate the shell forms the backend once emitted.
 */
function fakeApi(): SmolApi & { calls: FakeCall[]; machines: Map<string, SmolMachine>; files: Map<string, Buffer> } {
  const machines = new Map<string, SmolMachine>();
  const files = new Map<string, Buffer>();
  const calls: FakeCall[] = [];
  let seq = 0;

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
    async exec(_id: string, _o: SmolExecOptions) {
      // Every command the backend still emits is run for effect only — mkdir, credential
      // links, read-only layer materialisation. File *content* no longer rides the shell.
      return { stdout: new Uint8Array(0), stderr: new Uint8Array(0), exitCode: 0 };
    },
    async readFile(_id: string, path: string) {
      const f = files.get(path);
      return f ? new Uint8Array(f) : null;
    },
    async writeFile(_id: string, path: string, data: Uint8Array) {
      files.set(path, Buffer.from(data));
    },
  };
}

const sandboxFor = (api: SmolApi) => createSmolSandbox(workspace, { api, homeDir: "/root" });

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

test("file round-trip preserves bytes, text and binary alike", async () => {
  const api = fakeApi();
  const sbx = sandboxFor(api);

  const h = await sbx.provision(rw("personal:files"));
  await sbx.writeFile(h, "notes/hello.txt", "hello world");
  assert.equal(await sbx.readFile(h, "notes/hello.txt"), "hello world");

  // Binary and non-UTF8 — the case a text-only transfer path would corrupt.
  const blob = new Uint8Array(1000);
  for (let i = 0; i < blob.length; i++) blob[i] = (i * 31) % 256;
  await sbx.writeFileBytes(h, "blob.bin", blob);
  const back = await sbx.readFileBytes(h, "blob.bin");
  assert.deepEqual(back && [...back], [...blob], "write/read must be byte-exact");
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
