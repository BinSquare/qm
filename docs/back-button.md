# Back button: rewind an agent computer (smolmachines)

Every QM scope has its own computer. With the smolmachines sandbox provider, that
computer now has a back button: save a restore point of the whole machine (disks,
RAM and running processes), and put the machine back to any restore point later.

```ts
const point = await sandbox.checkpointComputer!(scopeId, "before-refactor");
// ... a turn goes wrong ...
const { undo } = await sandbox.rewindComputer!(scopeId, point.id);
await sandbox.listComputerCheckpoints!(scopeId); // newest first
await sandbox.rewindComputer!(scopeId, undo.id);  // undo the rewind
```

- `checkpointComputer(scope, label?)` saves the scope's machine and records a
  restore point.
- `rewindComputer(scope, id-or-label)` checkpoints the current machine first, then
  replaces the machine with the restore point under the same name. The rewind is
  therefore undoable. An unknown restore point fails without touching the machine.
- `listComputerCheckpoints(scope)` returns restore points, newest first.
- `checkpointEachTurn: true` (a provider option) leaves a restore point after every
  turn that changed the computer, so any turn can be undone. Turns that change nothing,
  monitor polls and the process reaper add none.

## Turning it on

Set these in the deployment's `.env` next to `SANDBOX_BACKEND=smolmachines`:

| Variable | Effect |
|---|---|
| `SMOLMACHINES_CHECKPOINTABLE=true` | Create scope computers checkpointable (Smol Cloud fixes this at create) and offer the back button to agents |
| `SMOLMACHINES_CHECKPOINT_EACH_TURN=true` | Also leave a restore point at the end of every turn that changed the computer (implies checkpointable) |

Computers that already exist were created without checkpointing; destroy them (or let
them be recreated) to get the back button on them.

## What agents see

With either setting on, the `sandbox` tool gains three actions for the turn's own
computer:

- `checkpoint`, with an optional `checkpoint` label: saves a restore point.
- `checkpoints`: lists restore points, newest first.
- `rewind`, with `checkpoint` set to the restore point's id or label: puts the computer
  back to that point. The reply names the restore point that undoes the rewind.

Other backends, and deployments without the settings, see no change to the tool.

The methods are optional on the `Sandbox` interface, so other providers can add them.
All of them run under the provider's per-scope lifecycle lock. This goes further than
home snapshots, which restore files under `/root` only: a rewind also brings back the
processes that were running.

## Validate it yourself

Requirements: Node 24 (QM's engine), and for the live check a Linux host with KVM or
a Mac with Apple Silicon.

### 1. Unit tests (no VM, about 30 s)

```sh
git clone -b back-button https://github.com/BinSquare/qm && cd qm
npm ci
node --experimental-test-module-mocks --test test/smolmachines-sandbox.test.ts
npx tsc --noEmit
```

Expect `# pass 39  # fail 0`. The three back-button tests are:

- `the back button: rewind puts the whole computer back to a restore point, and the rewind can be undone`
- `rewinding to an unknown restore point fails without touching the computer`
- `checkpointEachTurn leaves a restore point after every turn that changed the computer`

These run against QM's fake smol cloud API (`test/support/fake-smolmachines.ts`),
which now implements checkpoint capture and restore.

### 2. Live, on real local microVMs (about 15 s after the first image pull)

Install smolmachines and start a local stand-in for the smol cloud machine API. It
serves only the calls the provider makes, each backed by the `smolvm` CLI:

```sh
curl -sSL https://smolmachines.com/install.sh | bash
node scripts/smolvm-local-api.ts          # leave running: http://127.0.0.1:8787
```

In a second terminal:

```sh
SMOLMACHINES_BASE_URL=http://127.0.0.1:8787 SMOLMACHINES_TOKEN=local \
  node scripts/back-button-live.ts
```

The script:

1. provisions a scope's computer;
2. writes a project and starts a background process;
3. saves a restore point;
4. wrecks the project (a bad turn);
5. rewinds;
6. undoes the rewind.

Expected:

```
PASS  the bad turn wrecked the project
PASS  back button restores the project  (v1 works)
PASS  and removes what the bad turn made
PASS  a process running at the checkpoint is running again  (running)
PASS  restore points listed newest first  (before-rewind-…, before-refactor)
PASS  the rewind itself can be undone
ALL PASSED
```

It deletes its machine at the end. Restore points stay in
`~/.cache/smolvm-local-api/checkpoints`; delete that directory to reclaim the space.

### 3. Live, on smol cloud

Point the same script at the real API with a current key:

```sh
SMOLMACHINES_TOKEN=<smol cloud api key> node scripts/back-button-live.ts
```

This path uses the control plane's `POST /v1/machines/{id}/checkpoints` and
`POST /v1/checkpoints/{id}/restore`. It passed all six checks on Smol Cloud:

- a checkpoint takes about 10 s;
- a rewind takes about 19 s, including the checkpoint that makes it undoable.
