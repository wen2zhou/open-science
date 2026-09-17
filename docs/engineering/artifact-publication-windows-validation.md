# 给 Windows Codex：Open Science Artifact 发布实测指南

日期：2026-09-17。协调者：发出本文的 orchestrator。

## 0. 任务与当前状态

请验证 Artifact 发布修复在真实 Windows Open Science 上的行为，收集可复核证据。你负责执行和记录；orchestrator 负责实现、提供候选、分析失败和最终判定。

**这是 Main 统一运行持久化实现的验证指南，不是上线批准。** 当前变更在 `codex/artifact-publication-main-owner` 分支。使用与本文一同交付的 Git bundle / 候选清单固定代码；不能用旧 PR #2691 或任意最新 main 代替。尚未完成的验收项见 `artifact-publication-main-owner.md`。

**不得抢占用户屏幕焦点。** 在用户正在工作的桌面上，不启动应用 E2E 或交互实测。现有 fixture 的 `windowMode: hidden` 只限制窗口展示，并不证明整个应用生命周期不会激活应用。GUI 场景在独立 Windows 测试账户 / VM / 专用测试桌面执行；非 GUI 检查可以先做。未经验证，不通过启动后切回原应用来冒充“不改变焦点”。

| 字段                                 | 待交接值                                                                                              |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| 候选完整 Git SHA                     | 使用随 bundle 交付的 candidate.json 中的 commit；运行 git rev-parse HEAD 核对                         |
| 候选分支/PR                          | codex/artifact-publication-main-owner；未自动合并或发布                                               |
| 安装包/可执行文件、SHA256 与构建来源 | 待提供；源码验证也要记录构建 SHA                                                                      |
| 对照 baseline SHA/版本               | ee1d37700c7841759053b9a48cd71366b816264d / 0.30.2                                                     |
| 新增并发/恢复测试命令与故障注入阶段  | 下方定向测试；crash suite 新增 activated-unattached 阶段                                              |
| 历史案例脱敏 fixture/校验工具        | runtime-authority.test.ts 的 a/ab/abc 回归；原始 run029/run030 不随 bundle 分发，尚不能当作历史全覆盖 |
| 性能预算和固定样本                   | 未锁定，性能验收保持 BLOCKED；不得依据候选结果事后放宽阈值                                            |

收到未填完整文档时，记录缺项并完成不依赖候选的准备。最终验收保持 BLOCKED，不能将未知项当作通过。

### 固定候选（PowerShell）

将 `candidate.json`、`artifact-publication-main-owner.bundle` 和本文放在同一交接目录。在已有 Open Science 仓库中执行以下步骤；bundle 以表中 baseline 为前置提交，需要本地已包含该提交。若提示缺少 prerequisite，先从仓库正常获取该 baseline，不能跳过校验。

```powershell
$handoff = 'C:\实际交接目录'
$candidate = Get-Content -Raw (Join-Path $handoff 'candidate.json') | ConvertFrom-Json
$bundle = Join-Path $handoff 'artifact-publication-main-owner.bundle'
if ((Get-FileHash -Algorithm SHA256 -LiteralPath $bundle).Hash.ToLowerInvariant() -ne $candidate.bundleSha256) { throw 'Bundle checksum mismatch' }
git bundle verify $bundle
if ($LASTEXITCODE -ne 0) { throw 'Bundle verification failed' }
git fetch $bundle refs/heads/codex/artifact-publication-main-owner
if ($LASTEXITCODE -ne 0) { throw 'Candidate fetch failed' }
$checkout = Join-Path (Split-Path (Get-Location).Path -Parent) ('open-science-artifact-validation-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
git worktree add --detach $checkout $candidate.commit
if ($LASTEXITCODE -ne 0) { throw 'Candidate checkout failed' }
Set-Location $checkout
if ((git rev-parse HEAD) -ne $candidate.commit) { throw 'Candidate SHA mismatch' }
```

## 1. 数据与构建隔离

- 使用独立测试目录及测试项目。不要在用户真实科研项目上执行崩溃、损坏、删除或迁移测试。
- 不运行仓库的 reset/uninstall 清理脚本，不覆盖 run029/run030 原始证据，不手工改 revision/owner/Branch 使保存通过。
- 记录 Windows 版本、Node/npm、CPU/内存、文件系统、Open Science 版本、模型/运行框架、候选 SHA、EXE SHA256、配置根和数据根。
- 对打包应用，优先使用独立 Windows 测试账户/VM。`OPEN_SCIENCE_STORAGE_ROOT` 和 `OPEN_SCIENCE_USER_DATA` 的普通覆盖是开发构建专用；不能假定它们隔离安装版。打包 E2E 交给仓库 fixture 管理隔离。
- 不改 HOME/USERPROFILE。不把 API key、auth.json、带 token 的 Web URL、全量环境变量放进证据包。
- 新测试 profile 通过正常设置完成登录/模型配置。需要用户登录时记录所需操作；不复制真实 profile 的凭据库来省略设置。

### 源码 DEV 隔离方式（PowerShell）

在已固定候选 SHA 的独立 checkout 中执行；不要 reset 用户已有工作树。以下目录为本次测试专用：

```powershell
$validationRoot = Join-Path $env:LOCALAPPDATA ('OpenScienceArtifactValidation-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Path $validationRoot | Out-Null
$env:OPEN_SCIENCE_STORAGE_ROOT = Join-Path $validationRoot 'storage'
$env:OPEN_SCIENCE_E2E_STORAGE_ROOT = $env:OPEN_SCIENCE_STORAGE_ROOT
$env:OPEN_SCIENCE_USER_DATA = Join-Path $validationRoot 'electron-profile'
$env:OPEN_SCIENCE_ALLOW_MULTI_INSTANCE = '1'
# 选择已确认未占用的端口；44130 是本指南的默认值。
$env:OPEN_SCIENCE_WEB_PORT = '44130'
New-Item -ItemType Directory -Force -Path $env:OPEN_SCIENCE_STORAGE_ROOT, $env:OPEN_SCIENCE_USER_DATA | Out-Null
git rev-parse HEAD
git status --short
node --version
npm --version
# 仅在独立测试桌面启动，避免改变用户当前桌面的焦点。
npm run dev
```

`OPEN_SCIENCE_E2E_STORAGE_ROOT` 同时把默认数据父目录指向测试根；它用于隔离，不能配置 fake provider 来替代真实模型用例。启动后实际核对设置中的数据路径、进程命令行和应用身份；路径不在测试目录则停止测试。CLI 通过明确 config root 连接同一实例，避免自动发现到用户生产实例。

打包版实测必须另外记录 EXE 完整路径和 `Get-FileHash -Algorithm SHA256 -LiteralPath <实际EXE路径>`；DEV 通过不代替候选安装版通过。

## 2. 自动测试准备与现有基线

使用仓库 CI 对应的 Node 22（详见候选 checkout 的 workflow），在独立 checkout 安装依赖：

```powershell
node scripts/ci/npm-ci.mjs
if ($LASTEXITCODE -ne 0) { throw 'Dependency setup failed' }
npm run typecheck
if ($LASTEXITCODE -ne 0) { throw 'Typecheck failed' }
npx vitest run src/main/session-persistence/runtime-session-owner.test.ts src/main/session-persistence/runtime-authority.test.ts src/shared/runtime-session-projection.test.ts src/shared/session-conversation-command.test.ts src/renderer/src/lib/session-persistence/session-persistence.test.ts src/renderer/src/lib/acp/workspace-events.test.ts src/main/tasks/task-runner.test.ts src/main/session-persistence/artifact-finalization-recovery.integration.test.ts src/main/artifacts/artifact-save-crash.integration.test.ts
if ($LASTEXITCODE -ne 0) { throw 'Publication regression tests failed' }
npm run build:e2e
if ($LASTEXITCODE -ne 0) { throw 'Electron build failed' }
npx playwright install chromium --only-shell
if ($LASTEXITCODE -ne 0) { throw 'Browser setup failed' }
npx playwright test e2e/certification/artifact-provenance.spec.ts e2e/session-fork.spec.ts e2e/session-client-consistency.spec.ts --workers=1 --retries=0
if ($LASTEXITCODE -ne 0) { throw 'Electron regression tests failed' }
```

上面包括本次新增的真实 Main + renderer 保存链路测试，以及连续两轮 Artifact 生成和重启的 Electron 验证。应用 E2E 只在上述隔离桌面执行。若候选重命名测试，由 orchestrator 更新映射，不静默跳过。记录每条命令、退出码和输出；使用 runner 提供的报告/trace，失败原始记录必须保留。以上基线不是新增根治契约的完整验收，必须再运行交接表中新增的定向测试。

已有 Electron fixture 有 fake-agent 场景，这类结果只标记为自动化验证；下一节必须用真实运行。

## 3. 真实模型小样本

每轮使用唯一 case ID，如 `W2-03`，新 Session 或明确记录被续跑的 Session。先不启用自动审核，随后单独验证审核链路。使用用户已配置且可用的模型，不擅自修改全局 provider 或授权策略。

基础提示词（替换 CASE_ID）：

> 这是 Open Science 文件发布验收 CASE_ID。请在 Notebook 中执行实际计算：对 [2,4,6] 求平均数，并生成 mean.txt（UTF-8、无 BOM，严格包含字符 4 和一个 LF 换行）；生成 values.csv（内容为 value、2、4、6 四行，LF 换行，末尾也有换行）；生成 manifest.json（记录 caseId=CASE_ID、count=3、mean=4）。请把三个文件作为 Artifact 发布，并在最终回复说明实际执行和发布结果。不要联网或安装包。

另一轮同名版本提示：在同一个 Session 中，对 [4,6,8] 执行同样流程，更新同名文件，mean.txt 必须为 `6\n`。验证新旧 Version 均保留各自原字节，不把主动新一轮生成误判为重复发布。

通过正常 UI 审批合法执行请求。模型未遵循样本字节要求时，记录为生成/样本问题，不能默默修文件后报告发布通过；同时检查是否发生独立发布错误。

### Case 表

| ID  | 操作                                                                               | 最少轮数 | 核心断言                                                                   |
| --- | ---------------------------------------------------------------------------------- | -------- | -------------------------------------------------------------------------- |
| W1  | 原生桌面创建 Session 并执行基础样本                                                | 3        | 一组完整产物，正文不重复，预览/下载正确                                    |
| W2  | CLI/Task 发起，立即在原生桌面打开其 Session；持续观察，切换另一个 Session 再回来   | 10       | 不出现保存/发布冲突；完整文字与三个文件；Task 和 Session 的终态一致        |
| W3  | 后台 Task 运行，全程不打开其 Session，结束后再打开                                 | 3        | 没有 renderer 参与也能完成发布                                             |
| W4  | 两个不同 Session 同时运行，桌面轮流观察                                            | 3 组     | 不串 owner、不相互阻断、不丢输出；不绕过同一 Session 的活动运行准入        |
| W5  | 同一 Session 发布基础样本后再生成同名新版本；结束后立即跟进一轮                    | 3        | 旧 Version 不变，新 Version 正确，旧运行不复活                             |
| W6  | 长一点的执行中正常取消，等应用确认停止后续跑；保存取消前已有产物证据               | 3        | 已提交文件保留；迟到事件不污染下一轮；不要求取消的运行凭空产出尚未生成文件 |
| W7  | 启用项目/Session 的现有自动审核流程，发布基础样本；另做一次原生 Plan 批准流程      | 各 1     | 审核消费已发布 Version；批准后正常继续；pending 不冒充 ready               |
| W8  | 通过正常委派功能让子智能体生成基础样本，父对话观察结果                             | 3        | 子 Frame/Branch/Attempt 归属正确，父会话能访问允许暴露的产物，无重复       |
| W9  | 使用已有分支会话，在产品允许的时机切换观察分支；若运行中不允许则验证拒绝和终态切换 | 3        | 文件仍属于执行绑定的分支；不通过改 JSON 强行制造 UI 不支持的操作           |
| W10 | 完成 W2/W5 后正常关闭并重新启动相同隔离 profile                                    | 各 1     | 文件、checksum、Version/owner 保持一致，无遗留 activeRun                   |

一轮包含模型多个合法回复时，不要求“只有一条 assistant message”；要求同一 provider event 不重复归属、同一 stream 不被主进程和桌面分别制造重复消息。

若功能因环境/权限/框架不可用，标记 BLOCKED 并说明；不把 W8 换成普通文件生成后算通过。支持多个运行框架时，默认框架完成全表；其余受影响框架至少执行 W1/W2/W3/W5，具体由候选交接表锁定。

### CLI 入口（先核对同 checkout 的 packages/open-science/CLI.md）

源代码 checkout 的公共入口为 `node packages/open-science/cli.mjs`。以下命令中的值必须来自实际 UI 或命令回执，不能编造身份：

```powershell
# 在第二个终端，将此变量设置为第一终端打印/核对过的测试配置根。
$env:OPEN_SCIENCE_CONFIG_ROOT = '<实际测试配置根绝对路径>'
node packages/open-science/cli.mjs doctor --json
node packages/open-science/cli.mjs project create 'Artifact Windows Validation' --json
node packages/open-science/cli.mjs run --project '<实际project-id>' --prompt-file '<UTF-8提示词文件绝对路径>' --json
node packages/open-science/cli.mjs run status '<返回的run-id>' --json
node packages/open-science/cli.mjs session status '<返回的session-id>' --json
node packages/open-science/cli.mjs artifacts list '<返回的session-id>' --json
node packages/open-science/cli.mjs artifacts download '<实际artifact-id>' --output '<测试目录中的下载路径>' --json
```

不带 `--wait` 的 run 返回准入回执，适合 W2 立即打开观察。run 返回的 id 与 sessionId 分开记录，不把 process runId 当作 Task runId。等待客户端超时不等于运行已取消；先查 status，不能重发同一任务试图“修复”结果未知。

## 4. 受控中断、刷新失败与数据库故障

必须执行，但不要用随机杀进程来冒充精确阶段覆盖。

由 orchestrator 在候选中提供可观测阶段及测试 harness，Windows Codex 执行以下边界的真实存储/子进程测试：

1. durable owner 建立前与建立后。
2. Version finalize 后、兼容文件发布前/后。
3. 多文件仅部分完成后。
4. 文件发布成功后、消息附着/索引完成前。
5. 提交成功但回执尚未送达。
6. reconcile 返回已发布后，Session reload/预览刷新失败。
7. 发布链路数据库超时或慢 I/O；观察结果、恢复同一操作。

每个阶段至少进行三次独立重启/恢复，保存阶段证据、操作身份、已完成文件和恢复后结果。断言 Version 不重复、checksum 不变、不重跑 Notebook/模型、pending 不误报成功。精确故障注入用自动化测试；另补一次真实应用隔离进程被强制终止后的重启体验，记录实际命中的阶段，未命中的阶段不算覆盖。

只有核对可执行文件、PID、进程命令行与隔离路径都匹配本次测试实例后，才能终止该实例。不要使用按进程名批量 Stop-Process、不要强杀生产实例，也不要任意破坏 SQLite 文件/用户权限来制造失败。没有可确认的阶段或隔离身份时将该用例列为 BLOCKED。

数据/证明恢复不到的情况应正确保留待处理并解释原因；不能通过重跑模型、改 owner 或删除 pending 记录让验收通过。

## 5. 历史样本与大 Session

- run029/run030 只使用 orchestrator 提供的脱敏 fixture 或离线副本，原始包保持只读。
- 验证旧 marker、已发布未关联、非活动 Branch、只读导入和删除 tombstone。历史无效 owner 不能要求盲目“修好”；预期结果由 fixture 的已知证据决定。
- 大 Session 用固定生成数据复现历史消息/附件规模，按交接预算比较 baseline 与候选，记录发布时间、排队耗时、内存趋势、事务持续时间及排空状态。
- 搜到 P2028 不能直接归因于此次发布；关联 session/run/operation 与时间线。无法关联就保留“原因未知”，交 orchestrator 分析。

## 6. 每轮证据与总报告

建议目录：

```text
artifact-validation-<candidate-sha>-windows/
  environment.md
  manifest.json
  summary.md
  automated/                 # 命令、退出码、报告、trace
  cases/W2-01/
    steps.md                # UTC时间、实际操作、预期/实际
    identities.json         # project/session/task/attempt/frame/branch/message/version，缺失标明
    before.json
    after.json              # 使用受支持读取/离线一致副本，不能写生产库
    artifacts.json
    checksums.json
    screenshots/
    logs/                   # 相关时间窗口与源行号，不一次加载大日志
  failures/
```

对下载文件执行 `Get-FileHash -Algorithm SHA256 -LiteralPath <实际路径>`。核对 mean.txt 的实际字节为 `34 0A`（第二轮 `36 0A`），CSV/JSON 按样本要求核对；下载 hash 与对应 Version 的 checksum 比较，不能只拍预览截图。

内部图的 owner 可达性、event 重复归属、Version 精确集合由 orchestrator 提供的只读检查工具验证；工具未提供且无法从受支持接口验证时标记 BLOCKED，不凭屏幕推断。不要为方便导出任意凭据表。

首次失败先记录身份、时间窗口、状态与截图，再执行恢复步骤。恢复成功不抹掉首次失败；同时记录“首次结果”和“恢复结果”。大日志先统计大小，再按关键词及时间窗口提取；保留可追溯原文件，不把整份日志塞进模型上下文。

分享前脱敏凭据和无关用户内容，保留任务相关身份、版本与必要路径。压缩证据目录，不压缩整个 app profile、node_modules 或凭据库。

总报告必须包含：

- 精确候选身份、真实安装版还是 DEV、实际模型/框架。
- 每个 Case 的 PASS / FAIL / BLOCKED / NOT RUN；轮数、首次失败、恢复结果。
- 所有发布/保存错误及 P2028 的关联证据；不因最终出现文件就忽略错误。
- 是否有重复回复、缺文件、checksum 变化、owner 错误、旧 run 复活、下轮污染。
- 当前无法证明的结论及原因。

请回传证据包和 summary.md。orchestrator 复核前不要宣布整体根治、不要合并 PR 或发布版本；这份任务仅授权测试隔离候选。
