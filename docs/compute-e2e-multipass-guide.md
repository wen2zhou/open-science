# 用本地 Multipass 集群跑通 Slurm e2e 门禁

目标：把 `src/main/compute/slurm-e2e.test.ts` 从"默认跳过、从未验证"变成一次真实 PASS，
用你自己机器上的单节点 Slurm 虚机完成。产出的证据记录到
`docs/compute-release-checklist.md`（那里是权威发布记录）。

门禁完全由环境变量驱动，主机信息不入库；它打印的判决行只报告变量"是否设置"，不含主机名
和分区名，可以安全贴进发布记录。

## 0. 门禁到底覆盖什么

七个用例，全部走真实链路 `ComputeService` → `SlurmDriver` → `sbatch`，并由真实的
`JobPoller` 状态机轮询：

| # | 用例 | 前提 |
| --- | --- | --- |
| 1 | CPU 成功 + harvest 回传 | CPU 分区 |
| 2 | GPU 计算节点见证 | `SLURM_TEST_GPU_PARTITION`（未设则单独跳过） |
| 3 | 非零退出 → `failed` 且带 exit code | CPU 分区 |
| 4 | 用户取消 → `cancelled`（容忍调度器抢先到达其他终态） | CPU 分区 |
| 5 | 超墙钟（请求 30s，`sleep 600`）→ `timeout` 或 `failed` | CPU 分区 |
| 6 | 重启恢复：新建 poller 从持久化 handle 接续 | CPU 分区 |
| 7 | ready 环境 cache 见证：计算节点读取配置的 cache 路径 | CPU 分区 + 可写的 `SLURM_TEST_WORKDIR_ROOT` |

只有用例 2 需要 GPU。Multipass 上没有 GPU，它会单独跳过——这不算失败，但意味着 GPU 路径
仍然未验证，发布时要如实记录。

每个通过的用例会打印 `[slurm-e2e] PASS <case> host=... partition=... job=...`，这些行就是
你要贴进 checklist 的证据。

## 1. 准备虚机

单节点"集群"（同一台机器既是控制节点又是计算节点）足以跑完七个用例。关键是主机名要能稳定
解析，且 `slurmctld` 与 `slurmd` 对它的认知一致。

```bash
multipass shell hpc-dev
```

在虚机内：

```bash
sudo apt-get update
sudo apt-get install -y slurm-wlm munge python3-numpy
hostname   # 记下这个值，下面 slurm.conf 要用
```

写 `/etc/slurm/slurm.conf`（把 `hpc-dev` 换成上面 `hostname` 的实际输出）：

```conf
ClusterName=hpcdev
SlurmctldHost=hpc-dev
ProctrackType=proctrack/linuxproc
TaskPlugin=task/none
SelectType=select/cons_tres
SelectTypeParameters=CR_CPU_Memory
SchedulerType=sched/backfill

SlurmUser=slurm
StateSaveLocation=/var/spool/slurmctld
SlurmdSpoolDir=/var/spool/slurmd
SlurmctldPidFile=/run/slurmctld.pid
SlurmdPidFile=/run/slurmd.pid

# 会计存到 flat file 即可；门禁只依赖 sacct 能查到终态，不需要 slurmdbd
AccountingStorageType=accounting_storage/none
JobAcctGatherType=jobacct_gather/linux

# 用例 5 要验证超墙钟被杀。KillWait 给小一点，测试不用等太久
KillWait=10

NodeName=hpc-dev CPUs=2 RealMemory=1800 State=UNKNOWN
PartitionName=cpu Nodes=ALL Default=YES MaxTime=00:10:00 State=UP
```

`CPUs` 和 `RealMemory` 要 **不超过** 虚机实际配置，否则节点会被标成 `INVAL` 而作业永远排队。
用 `nproc` 和 `free -m` 查实际值，`RealMemory` 留些余量。

启动：

```bash
sudo mkdir -p /var/spool/slurmctld /var/spool/slurmd
sudo chown slurm:slurm /var/spool/slurmctld
sudo systemctl enable --now munge slurmctld slurmd
sinfo   # 期望看到 cpu 分区、STATE=idle
```

节点若是 `drain` 或 `down`，用 `sudo scontrol update nodename=hpc-dev state=resume` 拉回来，
并看 `sudo journalctl -u slurmd -n 50` 找原因（最常见就是 CPUs/RealMemory 配超了）。

## 2. 配置免密 SSH

门禁通过 `resolveSshTarget(alias)` 解析主机，**只认 ssh alias，不接受 IP**。所以必须在
`~/.ssh/config` 里配好。

```bash
multipass info hpc-dev | grep IPv4          # 取 IP
multipass exec hpc-dev -- whoami            # 取用户名，通常是 ubuntu
```

宿主机 `~/.ssh/config` 追加：

```
Host hpc-dev
  HostName <上面拿到的 IP>
  User ubuntu
  IdentityFile ~/.ssh/id_ed25519
  StrictHostKeyChecking accept-new
  ConnectTimeout 10
```

把公钥装进虚机（Multipass 默认不认你的个人密钥）：

```bash
ssh-keygen -t ed25519 -C hpc-dev -f ~/.ssh/id_ed25519   # 已有则跳过
multipass exec hpc-dev -- bash -c "mkdir -p ~/.ssh && chmod 700 ~/.ssh"
cat ~/.ssh/id_ed25519.pub | multipass exec hpc-dev -- \
  bash -c "cat >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys"
```

三条验收，全部通过才继续：

```bash
ssh hpc-dev true                      # 免密登录，不提示输入
ssh hpc-dev sbatch --version          # 调度器可用
ssh hpc-dev 'sinfo -h -o "%P %a %D"'  # 分区存在且 up
```

第二条要留意：门禁的 `dispatch` 用的是**非登录 shell**（`loginShell: false`），所以
`sbatch` 必须在默认 `PATH` 里就能找到。如果它只在 `~/.bashrc` 里被 PATH 追加，这里能过但
门禁会失败。用 `ssh hpc-dev 'command -v sbatch'` 确认路径是 `/usr/bin/sbatch` 这类系统路径。

## 3. 跑门禁

虚机 IP 每次重启可能变。跑之前先 `multipass info hpc-dev` 核对 `~/.ssh/config`。

两种传参方式都行。命令行前缀（一次性）：

```bash
SLURM_TEST_HOST=hpc-dev SLURM_TEST_PARTITION=cpu \
  npx vitest run src/main/compute/slurm-e2e.test.ts
```

或写进仓库根的 `.env`（已 gitignore，`test/setup-dotenv.ts` 会加载）：

```
SLURM_TEST_HOST=hpc-dev
SLURM_TEST_PARTITION=cpu
```

注意 `.env` 的值只在该 key **尚未存在**于 `process.env` 时才生效。如果你 shell 里
`export SLURM_TEST_HOST=` 成了空串，它会盖住 `.env` 的值导致整套 skip。

`SLURM_TEST_ACCOUNT` 在上面的 `slurm.conf`（`AccountingStorageType=none`）下留空，让集群用
默认账户。`SLURM_TEST_GPU_PARTITION` 同样留空，用例 2 单独跳过。
`SLURM_TEST_WORKDIR_ROOT` 默认 `~/.openscience/e2e`，一般不用改。

单个用例超时是 360 秒，七个用例串行，整套预计几分钟——用例 5 要真的等到墙钟被杀。

## 4. 判读结果

每次运行恰好打印一行判决：

```bash
npx vitest run src/main/compute/slurm-e2e.test.ts --reporter=verbose 2>&1 \
  | grep '\[slurm-e2e\] GATE='
```

| 判决 | 含义 |
| --- | --- |
| `GATE=ENABLED reason=configured host=<set> partition=<set>` | 真机路径确实跑了 |
| `GATE=SKIPPED reason=missing-config` | 什么都没验证，`SLURM_TEST_HOST`/`PARTITION` 没生效 |
| `GATE=FAILED reason=missing-config required=1` | armed 了但配置缺失，会硬失败并点名缺哪个变量 |

**发布前必须 arm 保险栓**，让配置缺失变成硬失败而不是静默跳过：

```bash
REQUIRE_SLURM_GATE=1 SLURM_TEST_HOST=hpc-dev SLURM_TEST_PARTITION=cpu \
  npx vitest run src/main/compute/slurm-e2e.test.ts
```

`REQUIRE_SLURM_GATE` 只认 `1|true|yes|on`；空串、`0`、`false` 一律视为未设置，所以 `.env`
模板里的空值不会误装弹。

要记一次 `Slurm gate: PASS`，需要凑齐：一行 `GATE=ENABLED ... required=1`，加上七条
`PASS <case>` 行（GPU 那条若跳过，如实记为 SKIP 并说明未覆盖）。

## 5. 清理约定

门禁的 `afterAll` **只**删自己创建的 per-job workdir，绝不碰共享 cache、镜像、权重或别人的
作业。清理失败只告警不算失败。

跑崩之后残留的目录，手工清：

```bash
ssh hpc-dev 'ls -la ~/.openscience/e2e'
ssh hpc-dev 'rm -rf ~/.openscience/e2e'      # 确认过内容再执行
ssh hpc-dev 'squeue -u $(whoami)'            # 有残留作业就 scancel
```

## 6. 排错

| 现象 | 原因 |
| --- | --- |
| 整套 skip，`GATE=SKIPPED` | 变量没进 vitest 进程。`.env` 里的值只在 key 尚未存在于环境时才生效（`test/setup-dotenv.ts:35`），若 shell 里已 `export` 了空串会盖住它 |
| `host_unreachable` | 虚机重启后 IP 变了，`~/.ssh/config` 里的 `HostName` 过期 |
| 作业永远 `PENDING` | `sinfo` 看分区状态；多半是 `slurm.conf` 里 CPUs/RealMemory 超过虚机实际值 |
| `dispatch_failed`，手动 ssh 却正常 | `sbatch` 不在非登录 shell 的 PATH 里，见第 2 节末尾 |
| 用例 5 卡住不终结 | 它请求 30s 墙钟跑 `sleep 600`，靠调度器杀。`KillWait` 过大或 `slurmd` 未真正接管进程（`ProctrackType` 配错）会让它拖到超时 |
| 用例 1 成功但 harvest 为空 | `SLURM_TEST_WORKDIR_ROOT` 不可写，或家目录配额满 |

## 7. 这套门禁**仍然**覆盖不到的

跑通了也别当成全绿，以下路径依然是空白，发布记录里要如实写：

- **GPU 计算节点见证**（用例 2）：Multipass 无 GPU，只能靠真实 GPU 集群。
- **完整 provisioning 在计算节点上的执行**：用例 7 只验证"读 cache 路径"这个运行时契约；
  真正的 conda build → validate → witness 全流程仅有单元测试覆盖，从未在真机跑过。
- **真实网络中断恢复**：用例 6 只是进程内新建 poller，不是 SSH 断连数分钟后再恢复。
- **sacct 会计延迟的真实窗口**：假集群里验证过"squeue 和 sacct 都查不到时保持非终态"，
  真集群的延迟边界未测。
- **多节点 / 抢占 / QOS 限额**：单节点虚机结构上无法覆盖。
