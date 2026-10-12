# Windows Codex 验证交接：Compute 发布前修复

## 任务与固定版本

请在**原生 Windows** 上验证 `codex/compute-release-hardening`，输出中文结果和原始日志。WSL 内的 Linux Node 运行不算 Windows 验证。先完成验证；若发现缺陷，保留原始失败、定位并修复，再对新的固定提交复验。不要通过增加 skip、削弱断言或临时扩大超时使结果变绿。不要合并或发布；后续推送修复由任务发起者的授权决定。

- 目标仓库：`https://github.com/wen2zhou/open-science`；原机器 remote 名为 `dev`。
- 分支：`codex/compute-release-hardening`。
- 已验证代码提交：`f901f88a4d439258162f047a20012476749ce38f`。
- 修复基线：`7bd0e4c6395f2b6cc4ed896bb233641ead79d6d1`。
- 分支后续提交除本目录文档/清单，还修改了 Slurm 与密码 SSH 认证夹具。记录拉取时的完整 HEAD；先检查代码提交到 HEAD 的 diff，不能把以后增加的代码修改当成已在 macOS 验证。
- [2026-10-12 原生 Windows 执行报告](windows-2026-10-12/REPORT.md)：修复了已有 host.compute 夹具漏传 named-pipe 地址的问题；最终宿主仍有符号链接权限阻塞，并保留未定位 receipt 替换不稳定失败记录，不是全绿或发布认证。

可以在新的目录拉取，避免覆盖 Windows 机器上的既有工作：

```powershell
git clone --origin dev --branch codex/compute-release-hardening --single-branch https://github.com/wen2zhou/open-science.git open-science-compute-windows
Set-Location open-science-compute-windows
git status --short
git rev-parse HEAD
git diff --stat f901f88a4d439258162f047a20012476749ce38f HEAD
```

已有 checkout 则先检查未提交修改和远程地址，再 fetch/switch；不要 reset 或覆盖其他工作。

## 已修复内容与已有证据

| 问题                          | 最终行为                                                                                                                   |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| F1：准备失败后仍启动          | mkdir/cd/脚本写入/chmod 必须成功后才启动；只有明确启动前失败能写 `dispatch_failed`。启动后 PID 写入/回传丢失保持持久恢复。 |
| F2：输出超过 1 MiB 被截断执行 | SSH 使用流式 spawn；每流有界捕获，截断日志不终止远端命令；退出、stdin、timeout/abort、TERM/KILL 和无 close 硬边界保留。    |
| F3：缺失父目录阻止安全删除    | 仅确定未启动且无待处理证据时允许安全幂等删除；handle、模糊启动、权限/路径不明和未确认 Slurm 仍保守。                       |
| F4：pause 未排空其他主机      | 已启动 provider Promise 全部 settle 后 tick 才结束，保留后台任务/harvest 排空。                                            |
| F5：真实 SSH 夹具作用域错误   | 提交、poller、取消等共享 execution scope；真实 manifest/SCP 和严格两轮 process_vanished 断言恢复。                         |

独立审核还修复了 R1 多轮/历史目录恢复丢失追踪、R2 不确定取消误确认、R3 权威取消完成后旧标记阻止删除、R4 SQLite 夹具在 Windows 上误用本机路径及无条件 sh。没有数据库迁移、新业务状态、新 handle 格式或 package→main 耦合。

[已有结果摘要](baseline-results.json)：macOS 包 479、宿主 1031、附加契约 3239、影响检查 243、真实 Linux SSH 7+21 项通过；宿主另有 10 项既有 Windows 条件跳过。独立审核无未处理发现。此前 SSH 容器及密钥已经清理，不能继续使用原机器的临时 alias/config。原始报告在原机器本地归档；本交接不依赖那些绝对路径，Windows 必须生成自己的证据。

## Windows 准备

1. 读取仓库 `AGENTS.md`、`CONTRIBUTING.md`、`packages/compute/README.md` 和 `packages/compute/TESTING.md`。
2. 使用原生 Windows Node 24、PowerShell 7、Git，以及仓库原生模块所需的 Python / Visual Studio C++ 构建工具。记录 Windows 版本、架构、Node/npm/PowerShell、Electron 和 OpenSSH 版本及实际路径。
3. 按仓库 CI 的 `node scripts/ci/npm-ci.mjs` 安装，不复用 macOS 的 node_modules、dist 或原生二进制，不使用 `--ignore-scripts` 绕过安装。
4. 检查 Prisma、Electron 和本工作树原生模块。此前 macOS 补齐过缺失的 `process-tree-native`、`safe-file-publisher-native` 构建产物；若 Windows 也缺失，记录环境失败后用包现有 install 脚本修复，不改测试。
5. 普通 Windows 开发不要求自行编译整套 Notebook runtime。若扩大到保护模式/全量 Windows CI，按 `.github/actions/windows-notebook-runtime/action.yml` 和 `packages/notebook-network-sandbox/vendor/windows-runtime/README.md` 准备匹配版本的资源；缺资源不能记成该范围通过。

在仓库根目录用 PowerShell 7 初始化日志。以下是交接命令示例，尚未在 Windows 执行；执行者应保留实际 argv、环境与返回码。

```powershell
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
$handoffDir = Join-Path (Get-Location) 'docs/verification/compute-release-hardening'
$evidenceDir = Join-Path (Get-Location) '.scratch/compute-windows-verification'
New-Item -ItemType Directory -Force $evidenceDir | Out-Null
$candidateSha = (git rev-parse HEAD).Trim()
$candidateSha | Set-Content (Join-Path $evidenceDir 'candidate-sha.txt')

function Invoke-LoggedNative {
  param([string]$Label, [string]$Program, [string[]]$Arguments)
  & $Program @Arguments 2>&1 | Tee-Object -FilePath (Join-Path $evidenceDir "$Label.log")
  $exitCode = $LASTEXITCODE
  @{ label = $Label; program = $Program; arguments = $Arguments; exitCode = $exitCode; sha = $candidateSha } |
    ConvertTo-Json -Depth 5 -Compress | Add-Content (Join-Path $evidenceDir 'commands.jsonl')
  if ($exitCode -ne 0) { throw "$Label failed with exit code $exitCode" }
}

Invoke-LoggedNative 'install' 'node' @('scripts/ci/npm-ci.mjs')
Invoke-LoggedNative 'build-packages' 'npm.cmd' @('run', 'build:packages')
Invoke-LoggedNative 'prisma-check' 'node' @('scripts/check-prisma-client.mjs')
Invoke-LoggedNative 'native-resolution' 'node' @('-e', "for (const p of ['@aipoch/compute/node','@aipoch/process-tree-native','@aipoch/safe-file-publisher-native']) { console.log(p, require.resolve(p)); require(p) }")
```

若需补齐原生模块，使用 `npm --prefix packages/process-tree-native run install` 或 `npm --prefix packages/safe-file-publisher-native run install`，记录构建及实际加载路径。不要忽略失败继续给出总体绿色结论。不要在日志中打印私钥或认证内容。

## 必须执行的验证

按下面各组**顺序**执行。数据库、包隔离、类型检查与真实 SSH 不并发，避免磁盘/CPU 竞争；同一轮保持 tracked 文件和受测产物不变。

### 1. 包、类型与独立消费

```powershell
Invoke-LoggedNative 'build-compute' 'npm.cmd' @('run', 'build:compute')
Invoke-LoggedNative 'package-types' 'npm.cmd' @('--prefix', 'packages/compute', 'run', 'typecheck')
Invoke-LoggedNative 'package-tests' 'npm.cmd' @('--prefix', 'packages/compute', 'test')
Invoke-LoggedNative 'package-isolation' 'npm.cmd' @('run', 'check:compute-package')
Invoke-LoggedNative 'node-types' 'npm.cmd' @('run', 'typecheck:node:compiled')
Invoke-LoggedNative 'web-types' 'npm.cmd' @('run', 'typecheck:web:compiled')
```

包测试保持自身配置和 15 秒预算。Unix shell 用例在 Windows 上已有合法 skip，不要求伪造 Unix 能力；逐项记录并与代码里的平台条件对应。特别确认 `ssh-runner.real-process.test.ts` 的大输出、末尾批量协议、timeout/abort 真实子进程全部执行，而不只是 mock 返回。

`check:compute-package` 必须保留声明依赖独立安装、CJS/ESM 类型入口、移除源码/devDependencies 后运行与私有入口限制。将命令打印的临时隔离目录证据复制到本次结果目录后再清理。

### 2. 62 个宿主文件和 95 个消费方文件

[host-tests.json](host-tests.json) 与 [consumer-tests.json](consumer-tests.json) 是两个不重叠的精确清单，全部路径相对仓库根目录。Windows 主测试沿用仓库 `.github/workflows/windows-full-test.yml` **已有**的单 worker、60 秒 test/hook 策略；这是启动前选定的平台策略，不是在失败后临时加时。记录它与先前 macOS 默认预算的区别，不修改仓库中的超时或平台 guard。

```powershell
$env:RUN_KERNEL = '1'
$env:OPEN_SCIENCE_TEST_MAX_WORKERS = '1'
$env:VITEST_WINDOWS_FULL_TEST = '1'
Remove-Item Env:VITEST_PORTABLE_CI -ErrorAction SilentlyContinue

foreach ($group in @(
  @{ Name = 'host'; List = 'host-tests.json' },
  @{ Name = 'consumer'; List = 'consumer-tests.json' }
)) {
  $files = @(Get-Content (Join-Path $handoffDir $group.List) -Raw | ConvertFrom-Json)
  $testArguments = @(
    'node_modules/vitest/vitest.mjs', 'run',
    '--project', 'default', '--project', 'process',
    '--project', 'architecture', '--project', 'database',
    '--maxWorkers=1', '--testTimeout=60000', '--hookTimeout=60000'
  ) + $files + @(
    '--reporter=default', '--reporter=json',
    "--outputFile.json=$(Join-Path $evidenceDir ($group.Name + '-results.json'))"
  )
  Invoke-LoggedNative ($group.Name + '-tests') 'node' $testArguments
}
```

直接运行本地 Vitest Node 入口，避免长文件清单经过 `cmd.exe`。不要省略 database 项目，否则会漏掉 Session package 文件。核对 JSON 中实际发现的规范化文件路径与两份清单完全一致：分别 62、95 文件，无遗漏/意外发现，不能仅凭退出码判断。不要要求 Windows 通过数量等于 macOS；平台用例会变化，但每个跳过都必须解释。

`RUN_KERNEL=1` 的真实 host.compute Node 测试不依赖 Python/R 环境。附加组中可选 Python 标准库输出测试若有可用 Python，应按 `src/main/notebook/repl-loop.integration.test.ts` 设置 `OPEN_SCIENCE_TEST_PYTHON` 为真实解释器路径；没有环境则如实列未验证，不把 skip 计为通过。

### 3. Windows 必须补齐的重点

- [windows-required-cases.json](windows-required-cases.json) 列出此前 macOS 跳过的 **10 个确切案例**：broker Windows askpass 1、Compute 提交证据恢复 1、文件证据原子发布 8。原生 Windows 上应实际执行，不能仍然 skip。文件发布测试自行构造 source Node 和 packaged Electron/ASAR 夹具，不需要先制作安装包，但必须有真实 Electron 可执行文件。
- `cancellation-persistence.integration.test.ts` 的 running/exited/vanished 三条扩展路径必须完整执行：未知目录两轮保持 active 与标记；owner 失败保留行/屏障；权威取消后清标记；后续 harvest 状态和 owner 实际 SQLite 删除。Windows fixture 的远端路径为 POSIX；仅本机 sh 增强被协议夹具替代，不能整个场景跳过。
- `ambiguous-dispatch-recovery.integration.test.ts`、取消 claim/CAS、宿主删除/Session policy、Notebook Compute/文件证据与 IPC/renderer 消费方均在清单内。
- 验证 Windows 文件锁、路径分隔符/含空格路径、ssh/scp 路径与子进程退出语义。平台问题需区分测试夹具、缺失依赖、已有基线缺陷和本次生产回归；修代码后重新固定 SHA。

### 4. 影响规则、格式与新增失败

在实际 Windows HEAD 上运行：

```powershell
Invoke-LoggedNative 'impact-selection' 'node' @('scripts/ci/module-test-impact.mjs', 'affected', '--base', '7bd0e4c6395f2b6cc4ed896bb233641ead79d6d1', '--head', $candidateSha, '--explain')
Invoke-LoggedNative 'impact-tests' 'node' @(
  'node_modules/vitest/vitest.mjs', 'run', '--project', 'default',
  'scripts/ci/check-module-ownership.test.ts', 'scripts/ci/module-test-impact.test.ts',
  'scripts/ci/validate-module-impact.test.ts', 'scripts/ci/package-test-impact.test.ts',
  'scripts/ci/package-host-test-impact.test.ts'
)
```

Windows 实测补充：上面的直接 Node 入口不会自动设置 `npm_execpath`，影响测试中的真实 npm 子命令需要它；`bash` 还可能命中系统 WSL shim。运行影响测试前，在当前 PowerShell 进程中将 `npm_execpath` 指向已安装 npm 的 `node_modules/npm/bin/npm-cli.js`，并把已安装 Git for Windows 的 `bin` 目录放到 `PATH` 首位。先用 `Get-Command bash` 核对为 Git Bash，记录实际路径；不要修改个人配置、使用缺少 `/bin/bash` 的 WSL shim，或把这些环境失败当成测试通过。此次具体值及修复前后完整日志见 Windows 报告。
沿用仓库规则对实际改动运行 lint/格式检查；若修复 renderer 文案，遵守八语言 i18n 及 guard。保守影响闭包在此前还包含 447 个未跑的广泛传递 consumer，本交接的 157 文件清单不等价于全仓 CI。完整 Windows/GUI 门禁仍以项目规则为准。

遇到失败先保留日志，再诊断。仅补齐忽略的环境产物时，记录来源并在同 SHA 重跑失败所属完整组；代码修复则记录新提交并重跑受影响门禁。不要用旧候选、单案例复跑或没有发现文件的空运行覆盖失败组。不要无限重试抹掉不稳定结果。

## Windows → Linux 真实 SSH 与范围外认证

上述本机验证不能替代 Windows OpenSSH 客户端对真实 Linux 的认证。若机器已有可用隔离 Linux SSH 环境，再按 `packages/compute/TESTING.md` 从 Windows 显式运行原版 7 项：

```powershell
$env:RUN_COMPUTE_JOBS = '1'
$env:RUN_COMPUTE_CANCELLATION = '1'
# 替换成已验证的隔离测试 SSH alias；不要填写生产集群。
$env:COMPUTE_TEST_SSH_ALIAS = '<isolated-linux-alias>'
Invoke-LoggedNative 'windows-real-ssh' 'node' @(
  'node_modules/vitest/vitest.mjs', 'run', '--project', 'process',
  'src/main/compute/compute-jobs.integration.test.ts',
  'src/main/compute/cancellation.real-ssh.integration.test.ts'
)
```

保留这 7 项的原始逐例 timeout，实际检查成功、exit 3、timeout、严格两轮 process_vanished、manifest/SCP 字节、两项取消及无关进程保留。Windows 客户端需要可用 ssh/scp 与私有配置适配，不要把 Linux shell wrapper 原样当成 Windows 可执行文件。缺环境明确报告“Windows→Linux SSH 未验证”，不能把 gated skip 当成认证。

macOS 上完成过的额外 21 项故障注入是既有证据，不自动成为 Windows 证据；若扩展复现，覆盖准备失败/3 MiB 输出、模糊启动跨重启、历史路径、取消未知目录和无 PID 正常退出后收集删除。真实 Slurm、密码 SSH、完整安装/GUI 验证同样必须有各自环境与日志，不能从上述测试推导通过。

## 交付与完成条件

将 [WINDOWS-REPORT.template.md](WINDOWS-REPORT.template.md) 复制到本次 evidence 目录填成中文报告，并保留 JSON / 原始日志。至少包含：

1. 实际 HEAD、基线、所有修复提交、开始/结束 Git 状态；确认包/native 来自当前工作树。
2. Windows/工具链/认证方式、精确命令/环境/预算、每组通过/失败/跳过数量；157 文件发现核对、10 个 Windows 案例是否实际执行。
3. 初次失败与后续修复/完整复跑，代码问题和环境问题分别说明。
4. 包隔离、类型、影响检查、F1—F5 与 R1—R4 的 Windows 结论；真实 SSH 与未覆盖范围单独列出。
5. 只清理自己创建的测试进程、目录、容器和密钥，保留证据及工作树；不改个人 SSH 配置，不清理其他任务资源。

只有执行完成且无未处理相关失败时，才能声明对应 Windows 范围通过。环境阻塞应报告确切阻塞和已完成范围，不自动改成通过，也不等价于批准正式发布。
