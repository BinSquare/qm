# The smol machines agent-computer backend

`SANDBOX_BACKEND=smol` runs each scope's computer as a [smol machine](https://smolmachines.com) —
a hardware-isolated microVM — instead of a local Docker container.

The motivation is operational rather than architectural: the `local` backend needs a Docker
daemon on the same host as the core, which rules out running QM anywhere without one. The
`smol` backend needs only an API key and outbound HTTPS, so the core can run on a plain
Node host, a container without a mounted socket, or inside another microVM.

## How it maps

| QM concept        | smol equivalent                                    |
| ----------------- | -------------------------------------------------- |
| scope's computer  | one machine named `qm-sbx-<slug>`                    |
| `execute` tool    | `POST /v1/machines/:id/exec`                        |
| parked computer   | machine `stopped` — its disk persists               |
| destroyed computer| machine deleted                                     |
| scratch computer  | machine named `qm-scratch-<slug>`, deleted on teardown |
| egress policy     | machine network allow-list                          |

Persistence is `resident_disk`: teardown stops the machine rather than deleting it, so
tools the agent installed are still there on the next turn. `destroy: true` deletes it.

There is no in-guest daemon. The `local` backend runs an HTTP exec daemon inside the
container and talks to it over a published port; here the control plane already exposes
exec, so file reads and writes are ordinary shell commands (`base64 -d`, `tail -c`) whose
payloads ride the documented byte-exact `stdoutB64` / `stdin` fields. Transfers are chunked
(`TRANSFER_CHUNK_BYTES`, 3 MiB of raw content per exec) so a large file does not need one
oversized frame.

## Configuration

| Variable                     | Meaning                                                     |
| ---------------------------- | ----------------------------------------------------------- |
| `SANDBOX_BACKEND=smol`       | select this backend                                          |
| `SMOL_API_KEY`               | **required** — control-plane API key                         |
| `SMOL_API_URL`               | override the control plane (default `https://api.smolmachines.com`) |
| `SMOL_SANDBOX_IMAGE`         | image for each computer (default `docker.io/library/debian:12-slim`) |
| `SMOL_SANDBOX_CPUS`          | vCPUs per computer                                           |
| `SMOL_SANDBOX_MEMORY_MB`     | memory per computer                                          |
| `SMOL_SANDBOX_ALLOWED_HOSTS` | comma-separated egress allow-list; unset means unrestricted  |
| `SMOL_SANDBOX_RUNTIMES`      | comma-separated runtimes the image ships                     |
| `SMOL_SANDBOX_TOOLS`         | comma-separated tools the image ships                        |

## Choosing an image

The default `debian:12-slim` boots and executes commands but ships almost nothing — no
git, no python, no gh. The agent plans around `profile.spec`, so pointing the backend at a
richer image without also setting `SMOL_SANDBOX_RUNTIMES` / `SMOL_SANDBOX_TOOLS` leaves it
believing the computer is bare, and advertising tools an image does not have is worse: the
agent will confidently plan around them and fail mid-task.

For parity with the `local` backend, build this repo's sandbox image once from
`fly/Dockerfile` (Node 24, Python 3, git, gh, curl, jq, the CLI harnesses), push it to a
registry the fleet can pull, and point the backend at it:

```
SMOL_SANDBOX_IMAGE=registry.example.com/qm-sandbox:latest
SMOL_SANDBOX_RUNTIMES="Node 24,Python 3 (venv on PATH)"
SMOL_SANDBOX_TOOLS="git,curl,wget,jq,unzip,gnupg,python3,gh"
```

That build needs Docker, but only once and only on the machine doing the build — not on
the host running the core, which is the constraint this backend exists to remove.

## Egress

`SMOL_SANDBOX_ALLOWED_HOSTS` is applied at machine creation and enforced by the fleet, so
the profile reports `egressEnforcement: "domain"`. Left unset, machines get unrestricted
outbound access and the profile honestly reports `"none"` — the same posture as `local`.
The allow-list is fixed at creation time; changing it takes effect for computers created
afterwards, not for ones that already exist.
