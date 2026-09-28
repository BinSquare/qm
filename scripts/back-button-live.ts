// Live check of the smolmachines back button against real smol cloud.
//   SMOLMACHINES_TOKEN=... node scripts/back-button-live.ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSmolmachinesSandbox } from "../src/sandbox/smolmachines-sandbox.ts";
import { createLocalWorkspaceStore } from "../src/workspace/workspace-store.ts";
import { scopeId } from "../src/types.ts";

const token = process.env.SMOLMACHINES_TOKEN;
if (!token) throw new Error("set SMOLMACHINES_TOKEN");
const sandbox = createSmolmachinesSandbox(createLocalWorkspaceStore(mkdtempSync(join(tmpdir(), "qm-live-"))), {
  token,
  ...(process.env.SMOLMACHINES_BASE_URL ? { baseUrl: process.env.SMOLMACHINES_BASE_URL } : {}),
  namePrefix: `qmlive${Date.now() % 100000}`,
  image: process.env.SMOLMACHINES_IMAGE ?? "ubuntu:24.04",
  cpus: 2,
  memoryMb: 2048,
  checkpointable: true,
});
const scope = scopeId("personal", "back-button");
const layers = [{ scopeId: scope, mountPath: "/", mode: "rw" as const }];
const t = (label: string, t0: number) => console.log(`  ${label}: ${((performance.now() - t0) / 1000).toFixed(1)} s`);
let failures = 0;
const check = (label: string, ok: boolean, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
};

try {
  let t0 = performance.now();
  const h = await sandbox.provision(layers);
  t("provision", t0);
  await sandbox.run(h, "mkdir -p project && echo 'v1 works' > project/app.txt && (sleep 100000 &) ");
  t0 = performance.now();
  const good = await sandbox.checkpointComputer!(scope, "before-refactor");
  t("checkpoint", t0);
  await sandbox.run(h, "rm -rf project && echo broken > oops.txt");
  check("the bad turn wrecked the project", (await sandbox.readFile(h, "project/app.txt")) === null);

  t0 = performance.now();
  const { undo } = await sandbox.rewindComputer!(scope, good.id);
  t("rewind (checkpoint current + restore)", t0);
  const h2 = await sandbox.provision(layers);
  const app = (await sandbox.readFile(h2, "project/app.txt"))?.trim();
  check("back button restores the project", app === "v1 works", app ?? "missing");
  check("and removes what the bad turn made", (await sandbox.readFile(h2, "oops.txt")) === null);
  const proc = await sandbox.run(h2, "pgrep -f 'sleep 100000' >/dev/null && echo running || echo gone");
  check("a process running at the checkpoint is running again", proc.stdout.trim() === "running", proc.stdout.trim());

  const points = await sandbox.listComputerCheckpoints!(scope);
  check("restore points listed newest first", points[0]?.label === undo.label && points[1]?.label === "before-refactor", points.map((p) => p.label).join(", "));

  await sandbox.rewindComputer!(scope, undo.id);
  const h3 = await sandbox.provision(layers);
  check("the rewind itself can be undone", (await sandbox.readFile(h3, "oops.txt"))?.trim() === "broken");
} finally {
  await sandbox.destroyScope?.(scope).catch((e) => console.error("cleanup:", e));
}
console.log(failures === 0 ? "ALL PASSED" : `${failures} FAILED`);
process.exit(failures ? 1 : 0);
