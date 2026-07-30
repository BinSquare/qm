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
function fakeApi(): SmolApi & {
  calls: FakeCall[];
  machines: Map<string, SmolMachine>;
  files: Map<string, Buffer>;
  execFiles: Map<string, Buffer>;
} {
  const machines = new Map<string, SmolMachine>();
  const files = new Map<string, Buffer>();
  // Files only `exec` can see — the real backend's exec-private /tmp.
  const execFiles = new Map<string, Buffer>();
  const calls: FakeCall[] = [];
  let seq = 0;

  return {
    calls,
    machines,
    files,
    execFiles,
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
    async exec(_id: string, o: SmolExecOptions) {
      // The real backend gives `exec` and the file API SEPARATE /tmp filesystems, so model
      // that: exec writes land in `execFiles`, which `readFile` cannot see. Only the
      // staging copy through the shared overlay bridges them.
      const ok = { stdout: new Uint8Array(0), stderr: new Uint8Array(0), exitCode: 0 };
      const cp = /^\[ -f '(.+?)' \] \|\| exit 66; cp '(.+?)' '(.+?)'$/.exec(o.command);
      if (cp) {
        const src = execFiles.get(cp[1]!) ?? files.get(cp[1]!);
        if (!src) return { ...ok, exitCode: 66 };
        files.set(cp[3]!, Buffer.from(src));
        return ok;
      }
      const wrote = /^exec-write (.+?) (.*)$/.exec(o.command);
      if (wrote) execFiles.set(wrote[1]!, Buffer.from(wrote[2]!));
      return ok;
    },
    async readFile(_id: string, path: string) {
      const f = files.get(path);
      return f ? new Uint8Array(f) : null;
    },
    async writeFile(_id: string, path: string, data: Uint8Array) {
      files.set(path, Buffer.from(data));
    },
    async makePublic(id: string) {
      calls.push({ op: "public", arg: id });
      const m = machines.get(id);
      if (m) m.url = `https://${m.name ?? id}.apps.example.com`;
      return m?.url ?? null;
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

test("a parked machine is STARTED again on the next provision, not just waited on", async () => {
  const api = fakeApi();
  const sbx = sandboxFor(api);

  const first = await sbx.provision(rw("personal:resume"));
  await sbx.teardown(first); // default teardown parks it
  assert.equal(api.machines.get(first.id)?.state, "stopped");

  api.calls.length = 0;
  const again = await sbx.provision(rw("personal:resume"));
  assert.equal(again.id, first.id, "must reuse the parked machine");
  assert.equal(api.machines.get(first.id)?.state, "started", "the parked machine must be running again");
  assert.ok(
    api.calls.some((c) => c.op === "start" && c.arg === first.id),
    "resume must issue a start — waiting alone strands a stopped machine forever",
  );
  // And it must still be usable, which is the symptom a caller actually sees.
  assert.equal((await sbx.run(again, "true")).code, 0);
});

test("read-back reaches a file only exec can see, by staging it through the shared overlay", async () => {
  // exec and the file API do NOT share /tmp. The backup path tars into exec's /tmp and then
  // reads it back through the file API; a plain readFile returns null there, which the
  // caller reports as "read-back failed". Staging through the shared overlay bridges it.
  const api = fakeApi();
  const sbx = sandboxFor(api);
  const h = await sbx.provision(rw("personal:readback"));

  api.execFiles.set("/tmp/agent-computer-backup.abc123", Buffer.from("tar-bytes-only-exec-can-see"));
  const back = await sbx.readFileBytes({ ...h, rootDir: "" }, "/tmp/agent-computer-backup.abc123");
  assert.notEqual(back, null, "a file only exec can see must still read back, not vanish");
  assert.equal(back && Buffer.from(back).toString(), "tar-bytes-only-exec-can-see");
});
