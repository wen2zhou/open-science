# Test ownership

The following original suites move their existing assertions and fixtures into `src/` here:

| Original `src/main/compute/` suite | Package behavior retained                                                  |
| ---------------------------------- | -------------------------------------------------------------------------- |
| `compute-environment.test.ts`      | Environment-name validation, source paths and shell application            |
| `harvest-classifier.test.ts`       | Glob policy, size limits, exclusions, manifest classification              |
| `remote-job-handle.test.ts`        | Direct/Slurm handle validation and historical workdir compatibility        |
| `remote-job-process.test.ts`       | Process ownership and bounded termination shell protocol                   |
| `job-poll-output.test.ts`          | Nonce markers, incomplete/truncated output and per-job parsing             |
| `slurm-driver-boundaries.test.ts`  | Scheduler id/script/directive validation and shell injection guards        |
| `dispatch-tracker.test.ts`         | Overlapping leases and draining                                            |
| `concurrency-manager.test.ts`      | Admission, promotion, capacity and durable policy decision matrix          |
| `job-deletion-owner.test.ts`       | Stop-before-remove, orphan barriers and cleanup ownership matrix           |
| `ssh-runner.test.ts`               | SSH config, alias/path validation, byte caps, signals and transport errors |
| `scp-runner.test.ts`               | SCP arguments, streaming budgets, process termination and temporary output |

Mixed suites are split by their assertions:

| Original suite / cases                                       | Package destination                                                                                                                                                 | Host assertions retained                                                                                                      |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `job-dispatcher.test.ts`                                     | Same-named package suite: launcher shell execution, staging, protocol, dispatch CAS/error classification and tracker races                                          | Same-named host suite: published evidence survives DB failure; `$DATA` input resolution after storage relocation              |
| `job-poller.test.ts`                                         | Same-named package suite: recovery/status/timeout/harvest/queue/protocol and sub-batch matrices                                                                     | Same-named host suite: five notification claim/projection/deduplication scenarios and password adapter breaker across batches |
| `compute-host-profile-owner.test.ts` / `parseProbeOutput`    | `probe.test.ts`: all nine parser scenarios                                                                                                                          | All real host probe/persistence/pinned-scratch/details/concurrency operations                                                 |
| `compute-service.architecture.test.ts` / lifecycle ownership | `lifecycle-boundary.test.ts`: same intent inventory, CAS ownership and sole lifecycle writers, with private package controllers added to the construction allowlist | Host facade, startup/shutdown, Session policy, IPC and module-registration contracts                                          |

`compute-job-cancellation-owner.integration.test.ts` becomes the host
`cancellation-persistence.integration.test.ts`: it still verifies every original durable cancellation
claim, encrypted SQLite persistence and recovery assertion against the public package factories.
The former host implementation no longer exists.

`compute-job-lifecycle.test.ts` stays in the host: its cases exercise a real migrated SQLite repository
and atomic persistence. Package dispatcher, poller, queue and deletion tests independently exercise
those transition decisions with package-local inputs. `execution.test.ts` additionally verifies scope
isolation and the submission/poller handoff after removal of the global singleton.

All other original Compute suites remain host-owned. In particular, the recovery regression suite
mixes durable cancellation claims, real SQLite, harvest publication and Session authority; it is not
an algorithm matrix that can be moved wholesale. Real SSH/Slurm/password, broker credentials,
file-evidence recovery, project/session deletion and Notebook RPC flows remain integration evidence.
No test is removed or disabled to satisfy the extraction. Unused duplicated helper declarations from
split files are removed; each original assertion remains at its assigned owner. Inline fake data belongs
to its suite; writable shell fixtures use unique temporary directories. No host fixture tree is copied
into the package. Package tests import internal test subjects only within the package itself.

## Impact direction

| Changed location                                      | Required tests                                                     | Excluded unchanged package tests                                   |
| ----------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------ |
| Host Compute implementation                           | Host owner, contracts and actual downstream integration            | All upstream Compute and Diagnostics units                         |
| Compute implementation or fixture                     | Compute's own suites and reachable host contracts/integration      | Diagnostics and unrelated sibling packages                         |
| Compute public exports/domain contracts               | Compute plus caller type checks and reachable behavioral contracts | Unrelated sibling packages                                         |
| Diagnostics implementation                            | Diagnostics and dependent Compute, plus host consumers             | Unrelated packages unless a shared/unknown input requires fallback |
| Lockfile, root build/test config or unknown ownership | Conservative CI fallback                                           | None assumed                                                       |

The module manifest owns each source, test, fixture and package configuration exactly once. Host
modules never register Compute unit tests as consumer evidence. Source-reading architecture tests
have explicit runtime-consumer edges, alongside the existing askpass resource edges. Selection tests
assert real package/module direction and Vitest discovery, including a trusted baseline registry that
predates Compute. Building a dependency does not select its unit suite.

This extraction changes root metadata, the lockfile and CI configuration, so its PR can require full CI.
Local validation uses targeted package, host, contract, architecture and selection suites; it does not
claim the full repository regression result.

## 真实 Direct SSH 认证

在隔离 Linux SSH 环境显式运行五项 Job 场景及两项取消场景（需要 Bash、GNU coreutils
`timeout`、`setsid`、Python 3 和 `/proc`）：

```sh
npm run build:packages
RUN_COMPUTE_JOBS=1 RUN_COMPUTE_CANCELLATION=1 COMPUTE_TEST_SSH_ALIAS=compute-test \
  npx vitest run --project process src/main/compute/compute-jobs.integration.test.ts \
  src/main/compute/cancellation.real-ssh.integration.test.ts
```

别名必须可通过 OpenSSH 解析。为避免修改个人 SSH 配置，可以将可执行的 `ssh`、`scp`
包装脚本置于 `PATH` 首位；脚本执行系统工具，加入 `-F /absolute/path/to/private-config`，
最后原样传递 `"$@"`。私有配置可指定回环端口、一次性密钥和专用 known-hosts 文件。
共享夹具使用生产 connection broker 和传输实现，不创建桌面应用的个人 multiplexing 目录。

Job 夹具为同一数据库创建一个 execution scope，在可观测的连接获取 gate 处暂停 dispatch，
并通过轮询验证任务仍为 submitted。输入证据冻结在临时 storage root 中，以 `$DATA` manifest
持久化，经生产 SCP 上传、远端读取，并下载进行精确字节断言。进程消失场景先观察 running，
再停止并杀死 launcher 及其 session，确认不存在 `exit_code`，随后分别检查第一轮和第二轮
轮询以及持久化 error/exit 字段。取消夹具的 dispatch、poller、reaper 也共享同一 scope。
测试只清理自身唯一任务目录和进程；环境所有者还须删除测试容器及临时密钥。

认证记录必须包含受测提交、两个显式开关、别名、工具链、原始输出及清理结果。外部环境缺失
导致的 skip 不算认证通过。`--project process` 限定运行项目，保留原七项场景和原超时预算。
