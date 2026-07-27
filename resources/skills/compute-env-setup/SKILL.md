---
name: compute-env-setup
description: Provision and validate reusable remote compute environments (conda/venv, modules, or Apptainer) on Direct SSH or Slurm hosts, then register them so ordinary jobs can name them. Load when the user asks to install, repair, or re-validate a remote environment.
license: Apache-2.0
---

This skill covers the **environment provisioning** workflow: installing and validating a reusable
remote software stack and registering it in the environment registry so ordinary scientific jobs can
name it by `environment`. It is a SEPARATE operation from `submit_job`, with its own approval card and
grant scope.

**Everything here runs on the control-plane REPL kernel** (`repl_execute`, JavaScript) — the same
kernel that hosts `host.compute`. The python/r data kernels have no `host.compute`. Do NOT copy
Python-only `pip install` / `conda create` examples from elsewhere into the remote command; this skill
drives installation through the JavaScript `host.compute` API so approvals, audit and harvest stay
consistent.

## Provisioning vs. science jobs — do not mix

| Concern | Ordinary science job (`submit_job`) | Environment provisioning |
|---------|-------------------------------------|--------------------------|
| Approval operation | `submit_job` | `environment_provisioning` |
| Grant scope | named job, named `ready` environment | THIS build/validation plan only |
| Can name an env? | only a `ready` environment | creates/re-validates the env |
| Runs where | resolved driver (direct/slurm) | witnesses run where the stack must be usable |

You CANNOT disguise provisioning as a `submit_job`. The submit path resolves only `ready`
environments and never builds one. Installing packages, downloading weights, or validating an
environment must go through the provisioning approval, not a "quick job".

## Where `host.compute` runs

`host.compute` lives ONLY on the control-plane REPL kernel. Run every example with `repl_execute`
(JavaScript). The `python`/`r` data kernels have NO `host.compute`; calling it from a python/r cell
fails with `host.compute is undefined`.

## Step 0 — confirm the host and what already exists

```javascript
// List registered hosts and pick the session-active one.
const activeHosts = await host.compute.list_compute()
const providerId = activeHosts[0]   // e.g. 'ssh:biowulf'

// Read the host knowledge doc — Resources skeleton = first contact; populated sections = trust them.
const info = await host.compute.details(providerId, { mode: 'read' })

// List already-registered environments for this provider (status: draft|building|validating|ready|failed|stale).
const envs = await host.compute.environments_list(providerId)
print(envs.map((e) => ({ name: e.name, status: e.status, resolution: e.resolutionKind })))
```

Only a `ready` environment can be named by an ordinary job. `building`/`validating`/`failed`/`stale`
rows must be provisioned or re-validated first.

## Step 1 — decide the resolution shape

The resolution is the machine-readable activation contract the registry stores and the submit path
injects as a deterministic preamble. Choose ONE:

- **conda**: `{ kind: 'conda', envName: 'ml', activation: 'conda activate ml' }`
- **venv**: `{ kind: 'venv', prefix: '/scratch/me/venvs/ml', activation: 'source /scratch/me/venvs/ml/bin/activate' }`
- **module**: `{ kind: 'module', modules: ['cuda/12.2', 'cudnn/8.9'] }`
- **apptainer**: `{ kind: 'apptainer', image: '/scratch/images/ml.sif', binds: ['/scratch/data:/data'] }`

Never parse the human-readable `detailsDoc` to build a command — it is documentation only.

## Step 2 — probe the real install conditions (read-only)

Use `call_command` (short, approval-gated) to discover what is actually available on the host before
writing the install plan. Record findings in the host knowledge doc.

```javascript
const c = host.compute.create(providerId)
// One batched probe: module system + conda + scheduler + GPU.
const probe = await c.call_command(
  'echo "== modules =="; module avail 2>&1 | head -40; ' +
  'echo "== conda =="; which conda && conda --version; ' +
  'echo "== scheduler =="; which sbatch squeue sacct 2>/dev/null; ' +
  'echo "== gpu =="; nvidia-smi -L 2>/dev/null | head',
  'Probe install conditions for environment setup'
)
await host.compute.details(providerId, {
  mode: 'append',
  text: `\n## Env setup probe ${new Date().toISOString()}\n\`\`\`\n${probe.stdout}\n\`\`\``
})
```

## Step 3 — build the install plan and request the provisioning approval

Author a portable `spec` (what you intend) + the `resolution` (how it activates), then call the
provisioning entry point. The approval card shows: provider, environment name, build/validation script
summaries, resources, cache/weight paths, and known egress domains. Authorize ONCE for this plan.

```javascript
// A Direct-SSH conda env with a model cache.
const plan = await host.compute.environment_provision({
  provider_id: providerId,
  name: 'ml-torch',
  driver: 'direct',                 // or 'slurm' when the witness must run on a compute node
  spec: {
    runtime: 'conda',
    packages: ['pytorch::pytorch', 'numpy', 'pandas'],
    variables: {},
    weights: [{ name: 'resnet50', uri: 'hf:resnet50' }],
    cachePath: '/scratch/cache/torch',
    smokeChecks: [
      { command: 'python -c "import torch; print(torch.__version__)"', kind: 'import' }
    ]
  },
  resolution: { kind: 'conda', envName: 'ml-torch', activation: 'conda activate ml-torch' },
  build_script_summary: 'conda create -y -n ml-torch pytorch numpy pandas -c pytorch',
  validation_script_summary: 'python -c "import torch; print(torch.__version__)"',
  resources: { cpusPerTask: 4, memoryMib: 8192 },   // or { gpus: 1, partition: 'gpu' } for Slurm
  egress_domains: ['conda.anaconda.org', 'huggingface.co']
})
// plan → { environment_id, status: 'building'|'validating'|'ready'|'failed', validation }
```

The approval is its own operation (`environment_provisioning`); a grant here does NOT authorize
ordinary jobs, and an ordinary-job grant does NOT authorize provisioning.

### Witness rules (the validation must prove usability, not just import)

- **Direct SSH**: at minimum activate the environment and run a CLI/import smoke witness.
- **Slurm GPU**: the GPU witness MUST run on a compute node. A login-node import is insufficient —
  pass `driver: 'slurm'` with `resources.gpus` so the witness is submitted as a one-shot compute job.
- **Weight-bearing**: if `spec.cachePath` or `spec.weights` are set, the witness reads the configured
  cache path (proves layout + completion markers), not just `import torch`.

The recorded evidence captures spec hash, driver, resource shape, exact command, exit code,
stdout/stderr summary, timestamp and result — open it to diagnose a failure.

## Step 4 — handle the outcome

```javascript
// Read the registered environment + its validation evidence.
const env = await host.compute.environment_get(plan.environment_id)
print({ status: env.status, validation: env.validation })
```

- **ready** → the environment is immediately usable by an ordinary `submit_job`.
- **failed** → the registry keeps the diagnostics (command, exit code, stderr summary). Do NOT mark it
  ready yourself. Fix the plan and re-provision; a spec change auto-stales a previously ready row.
- **stale** → spec/resolution/cache path changed since the last ready validation; re-provision.

A failed validation NEVER flips the row to ready. Repair and re-run; the registry records every
terminal validation.

## Step 5 — use the ready environment from an ordinary job

Once `status === 'ready'`, name the environment on `submit_job`. The submit path injects the resolved
preamble into the job script; you do NOT repeat the activation commands.

```javascript
const c = host.compute.create(providerId)
const job = await c.submit_job(
  'Train with the provisioned ml-torch env',
  'python train.py --epochs 10',
  { environment: 'ml-torch', timeout_seconds: 3600 }
)
print(job.job_id)   // end the cell — the app runs the poller + harvest + analysis turn
```

Naming a non-ready environment fails before approval with `environment_not_ready`; it never triggers
SSH.

## Direct SSH install command selection

For Direct SSH, choose the lightest path the host already supports (do not invent a builder):

- conda present → `conda create -y -n <env> <pkgs>` then `conda activate <env>`.
- no conda, python present → `python -m venv <prefix>` then `source <prefix>/bin/activate; pip install <pkgs>`.
- environment modules already provide the stack → `{ kind: 'module', modules: [...] }` — no install needed.

Download weights/cache from the data-transfer/login location the host knowledge doc identifies, then
point `spec.cachePath` at the shared location the job will read. Slurm compute nodes are no-egress by
default; never assume a compute node can reach the internet.

## Slurm GPU install command selection

For Slurm, the GPU witness runs on a compute node. Install on the login/data-transfer node (where
egress is permitted) into a shared filesystem path the compute node mounts; then validate on the
compute node:

```javascript
const plan = await host.compute.environment_provision({
  provider_id: providerId,
  name: 'cuda-torch',
  driver: 'slurm',
  spec: {
    runtime: 'module',
    packages: [],
    variables: {},
    weights: [],
    cachePath: '/shared/cache/torch',
    smokeChecks: [{ command: 'nvidia-smi && python -c "import torch; print(torch.cuda.is_available())"', kind: 'gpu' }]
  },
  resolution: { kind: 'module', modules: ['cuda/12.2', 'cudnn/8.9'] },
  build_script_summary: 'module load cuda/12.2 cudnn/8.9; pip install --target /shared/pyPkgs torch',
  validation_script_summary: 'nvidia-smi && python -c "import torch; print(torch.cuda.is_available())"',
  resources: { gpus: 1, partition: 'gpu', timeLimitSeconds: 1800 },
  egress_domains: ['pypi.org']
})
```

## What to record in the knowledge doc

The knowledge doc is the only state that survives across sessions. For environments, record:
- Resolution that worked, tagged `verified <date>`; user-provided resolutions tagged `per user <date>`.
- The shared cache/weight path and where downloads were performed (login vs. compute).
- Egress facts: which nodes can reach the internet, which are isolated.
- Gotchas (purge windows, account requirements, module version conflicts).

Do NOT record secrets, per-job state, or transient errors.
