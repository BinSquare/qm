import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSmolDeployProvider } from "../src/deploy/smol-deploy-provider.ts";
import type { SmolApi } from "../src/sandbox/smol-api.ts";
import type { Deployment, DeploymentVersion } from "../src/deploy/deploy-store.ts";
import { scopeId } from "../src/types.ts";

const enc = (s: string) => new TextEncoder().encode(s);

/** A fake node whose port never answers, so apply() fails fast after recording createMachine. */
function fakeApi(rec: { image?: string }, appLog: string): SmolApi {
  return {
    listMachines: async () => [],
    getMachine: async (id: string) => ({ id, name: "m", state: "started", url: "http://127.0.0.1:1/" }) as never,
    createMachine: async (opts: { name: string; image?: string }) => {
      rec.image = opts.image;
      return { id: "m1", name: opts.name, state: "started" } as never;
    },
    startMachine: async () => {},
    deleteMachine: async () => {},
    exec: async (_id: string, o: { command: string }) => ({
      exitCode: 0,
      stdout: o.command.includes("qm-app.log") ? enc(appLog) : enc("agent-up"),
      stderr: enc(""),
    }),
    writeFile: async () => {},
    makePublic: async () => "http://127.0.0.1:1/",
  } as unknown as SmolApi;
}

const deployment = (): Deployment => ({
  id: "d1",
  ownerScopeId: scopeId("personal", "U1"),
  createdBy: "U1",
  name: "app",
  currentVersion: 1,
  status: "stopped",
  endpoint: null,
  versions: [],
});

function version(over: Partial<DeploymentVersion>): DeploymentVersion {
  const dir = mkdtempSync(join(tmpdir(), "smol-img-"));
  writeFileSync(join(dir, "index.html"), "<h1>hi</h1>");
  return { version: 1, createdAt: 0, entrypoint: "node serve.js", snapshotDir: dir, ...over };
}

test("the app's declared image is what createMachine boots — not the provider default", async () => {
  const rec: { image?: string } = {};
  const provider = createSmolDeployProvider({
    api: fakeApi(rec, "sh: 1: python3: not found\n"),
    image: "docker.io/library/node:24-slim",
    readyTimeoutMs: 50,
  });
  await assert.rejects(provider.apply(deployment(), version({ image: "python:3.12-slim" })));
  assert.equal(rec.image, "python:3.12-slim");
});

test("with no declared image the provider default is used", async () => {
  const rec: { image?: string } = {};
  const provider = createSmolDeployProvider({
    api: fakeApi(rec, ""),
    image: "docker.io/library/node:24-slim",
    readyTimeoutMs: 50,
  });
  await assert.rejects(provider.apply(deployment(), version({})));
  assert.equal(rec.image, "docker.io/library/node:24-slim");
});

test("a port that never answers surfaces the entrypoint's own app-log output, not a blank timeout", async () => {
  const provider = createSmolDeployProvider({
    api: fakeApi({}, "sh: 1: python3: not found\n"),
    readyTimeoutMs: 50,
  });
  await assert.rejects(provider.apply(deployment(), version({ entrypoint: "python3 -m http.server $PORT" })), (e: unknown) =>
    /python3: not found/.test(e instanceof Error ? e.message : String(e)),
  );
});
