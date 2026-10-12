# Compute 原生 Windows 验证报告

原始日志、结果 JSON、逐例 skip、精确命令/环境与诊断材料见 [raw-evidence.zip](raw-evidence.zip)，校验见 [raw-evidence.sha256](raw-evidence.sha256)。文中日志名相对于解压目录。归档 SHA256：`45970d9187db3023bc6c5c1f65d233c57579168153907cfd8da73c94282ea987`。归档仅含本次文本/JSON/脚本证据，无依赖目录、原生二进制或私钥；限定材料秘密模式扫描无命中。

日期：2026-10-12（UTC）。状态：验证已执行，仍有环境阻塞与未定位不稳定失败，不能声明全部通过或批准发布。

## 固定版本和环境

- 初始 HEAD：`387f1e3044845f187b3e4f958014d73c2842df5c`，分支 `codex/compute-release-hardening`，开始 tracked 干净。
- 修复基线：`7bd0e4c6395f2b6cc4ed896bb233641ead79d6d1`；macOS 代码基线：`f901f88a4d439258162f047a20012476749ce38f`。
- 初始 HEAD 相对 macOS 基线不仅新增文档，还修改密码 SSH 和 Slurm 认证夹具；不能继承此前认证。差异保存在 `post-macos-baseline.diff`。
- 本次修复：`34e8c794719832b9fd319b448602ca97f7253192`，仅给 `host-compute.integration.test.ts` 的 11 处请求补充 stub 的 `mcpRpcSocketPath`。未改变生产行为、断言、skip、超时或数据格式。
- Windows `10.0.26200`，原生 `win32/x64`；PowerShell 7.6.5；Node 24.19.0；npm 11.17.0；Git 2.45.1.windows.1；Python 3.12.7；Visual Studio Build Tools 18。
- Node：`C:/Users/zhouww/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe`。npm.cmd：`C:/Program Files/nodejs/npm.cmd`，其自身 Node 也是 24.19.0。
- Electron 43.7.5（真实 executable 输出，内嵌 Node 24.21.0）：本工作树 `node_modules/electron/dist/electron.exe`。
- OpenSSH_for_Windows_9.5p2 / LibreSSL 3.8.2，ssh/scp 来自 `C:/Windows/System32/OpenSSH`。
- 工作树：`D:/github/fearless82/open-science`；Compute、process-tree-native、safe-file-publisher-native 均解析至当前 `packages/`。
- 包测试保留自身 15 秒配置。host/consumer 启动前设置 `RUN_KERNEL=1`、`OPEN_SCIENCE_TEST_MAX_WORKERS=1`、`VITEST_WINDOWS_FULL_TEST=1`，显式单 worker、test/hook 60000ms，取消 `VITEST_PORTABLE_CI`。这是 README 规定的 Windows CI 策略，不是失败后加时。consumer 显式设置真实 Python 路径。
- 精确 argv、cwd、实际程序路径、SHA、开始/结束时间、退出码、相关环境见 `commands.jsonl`；补充环境见 `supplemental-environment.jsonl`。诊断修复后的未提交工作树运行不属于固定 SHA 认证，最终完整复验另列。

## 结果

| 范围                        | 发现/计划文件                    | 通过 | 失败 | 跳过     | 证据                                                                                        |
| --------------------------- | -------------------------------- | ---- | ---- | -------- | ------------------------------------------------------------------------------------------- |
| 首次 Compute 包             | 18/18                            | 434  | 0    | 45       | package-tests.log、package-results.json                                                     |
| 包隔离                      | diagnostics + Compute + consumer | 通过 | 0    | 包同上   | package-isolation-evidence/                                                                 |
| 初始 Node/Web/包类型        | 全部指定命令                     | 通过 | 0    | 0        | *types.log                                                                                  |
| 初次宿主（387f1e3）         | 62/62                            | 1012 | 15   | 14       | host-tests.log、host-results.json                                                           |
| 消费方（387f1e3）           | 95/95                            | 3238 | 0    | 1        | consumer-tests.log、consumer-results.json                                                   |
| 10 个 Windows 必须案例      | 10/10                            | 10   | 0    | 0        | reconciliation.json.windowsRequired                                                         |
| 初次影响规则                | 5/5                              | 240  | 3    | 0        | impact-tests.log                                                                            |
| 影响环境修复完整组          | 5/5                              | 243  | 0    | 0        | impact-tests-environment-fixed.log                                                          |
| 固定修复 SHA 宿主（34e8c7） | 62/62                            | 1026 | 1    | 14       | host-tests-fixed-sha.log、host-fixed-results.json                                           |
| 固定修复 SHA 类型/lint/格式 | 全部指定命令                     | 通过 | 0    | 0        | node-types-fixed-sha.log、web-types-fixed-sha.log、lint-fixed-sha.log、format-fixed-sha.log |
| 固定修复 SHA 影响           | 5/5                              | 243  | 0    | 0        | impact-selection-fixed-sha.log、impact-tests-fixed-sha.log                                  |
| Windows→Linux SSH 原版 7 项 | 未执行                           | —    | —    | 不作通过 | ssh-environment.txt                                                                         |

初始和最终 host 均核对 10 个 Windows 必须案例全部 passed；最终 host 核对见 reconciliation-fixed.json。157 个文件集合逐一规范化比较，62/95 无遗漏、无意外发现，两个清单不重叠。`skips-explained.json` 列出全部 60 个原有跳过的全名、文件、guard 与原因：包 Unix shell/process 45、host Unix/BSD 14、consumer Windows 不支持该 256GiB 稀疏文件夹具 1。没有新增跳过。真实 Python 标准库输出图测试执行通过。

包隔离从新临时目录独立安装声明依赖、build/types/tests/pack；consumer CJS/ESM 类型、私有入口拒绝、包解析边界、移除两个源码目录并 prune devDependencies 后运行全部通过。临时目录 `C:/Users/zhouww/AppData/Local/Temp/compute-isolation-FDM112` 的完整顶层日志/result 已复制，另有归档 SHA256 与复制回执。未复用 root node_modules 作为独立安装依赖。

## 失败、定位与修复

1. 安装首次成功，耗时约 15 分钟。前段长时间无输出来自旧 Windows node_modules 清理，根目录条目 316→300→170→44，有持续进展；不是依赖解析死锁。未终止或重试。postinstall 补丁、Prisma、Electron native rebuild 成功。记录 npm 11 allow-scripts / electron_mirror 警告，未用 ignore-scripts。三原生包加载检查成功。另有其他工作树安装进程，仅记录未干预。
2. host.compute 13 个 RPC 用例失败：基线 7bd0e4 与初始 387f1e3 的该文件逐字相同，属于已有夹具缺陷。Windows 默认监听 named pipe，但夹具只传 `http://localhost` endpoint，未传 socketPath，实际请求未到 stub。已有专门 pipe 案例通过。补齐 11 处后完整文件 15/15 通过；独立 high review 确认修复，不改为 TCP 或弱化断言。最终固定 SHA 完整宿主复验中该 15 项全部通过。
3. `compute-policy.test.ts` 文件符号链接创建 `EPERM`，发生在生产 API 调用前。单文件与独立 Node 探针重复确认，当前令牌无 `SeCreateSymbolicLinkPrivilege`。基线与初始 HEAD 的该文件也逐字相同，属于已有夹具的环境权限要求，不是本次回归（见 baseline-fixture-comparison.json）。这是环境权限阻塞；没有修改系统开发者模式、提升权限、增加 skip 或换成不同对象夹具，因此该案例仍未通过。
4. `compute-evidence-recovery.integration.test.ts` 有不稳定 receipt rename `EPERM`。初次 1 个案例失败，三文件诊断时另 2 个失败，rename 探针时再 1 个失败。源/目标是不同 inode、nlink=1、可写普通文件，identity/size/mtime 稳定，现有 7 次尝试耗尽。错误位于 prepared→allocated，早于该测试的故障注入。确认运行当前工作树 worker，排除旧 worker。简单硬链接发布/替换 100 次未复现；两次只观察 open/close 的诊断完整 8 例均通过，没有捕获 rename 错误。**这些通过不抹去早期失败，原因尚未定位，不能声明修复或归咎某个安全软件。最终固定 SHA 完整宿主复跑中该文件 8/8 通过，仍保留此未定位不稳定历史。** 独立 review 未发现 worker 自有句柄泄漏：相关 handle 均 finally close，runtime ownership 持有另一 SQLite 文件。未改变重试预算、权限、原子语义或生产代码。后续应在第一次失败保留原生错误码并针对该路径收集 handle/ProcMon 证据。
5. 初次影响检查直接 Node 启动缺 `npm_execpath`，且 PATH 上 `bash` 命中系统 WSL shim（无 `/bin/bash`），伴随清理 EPERM。仅对该命令设置现有 npm-cli.js 路径、将 Git Bash bin 放 PATH 首位，完整 5 文件 243/243 通过；没有更改个人配置或 CI 断言。最终固定 SHA 再跑 5 文件 243/243 通过。

## 重点行为与证据界限

- F1/F3、R1—R4：package 以及 host recovery/cancellation/lifecycle/owner 测试中的 portable 部分通过；`cancellation-persistence` 34 项和 `ambiguous-dispatch-recovery` 21 项全部实际执行，包括 running/exited/vanished 三条 SQLite 扩展链、两轮保留、权威取消、harvest 与删除。Unix-native shell 条件跳过不算 Windows 认证。
- F2：`ssh-runner.real-process.test.ts` 六项真实子进程全部执行，覆盖超过 1MiB 输出、批量协议尾部、timeout/abort/退出收敛；不是仅 mock 结果。
- F4：package poller/concurrency drain 与 host runtime drain/isolation portable 案例通过。
- F5：本地共享 scope/manifest 契约通过，真实 SSH、SCP 字节和严格两轮 process_vanished 的外部 7 项未执行，不从本地测试推导通过。Vault/Broker 重建不是完整进程重启。
- Windows askpass 1、提交证据恢复 1、文件原子发布 source Node 4 + packaged Electron/ASAR 4 均实际通过；包括读锁释放/持续占用、源与目标变更保护。另一组自然出现的 receipt EPERM 仍单列未解决。
- 本轮涉及含空格的 Node/Python/npm 路径，portable ssh/scp 参数及真实子进程测试；没有制作安装包或执行 GUI。

## 未覆盖范围、清理与结论

无现成测试 alias/开关，Docker CLI 虽存在但 Linux engine pipe 不可用；未读取个人 SSH 配置、未创建密钥/容器或访问生产集群。Windows→Linux SSH、Slurm、密码认证、额外 21 项故障注入、全量 Windows CI/GUI/保护模式均未验证。CodeGraph 不可用时使用 manifest 保守影响闭包；157 文件不是完整 CI，广泛传递 consumer 未全部执行。

所有测试顺序运行，保留首次失败、诊断与复验独立日志，禁止覆盖。测试自身 afterEach 清理其 mkdtemp；receipt 失败目录也由原测试清理，未为了取证修改固定轮测试。没有清理其他任务进程/工作树或用户 SSH 配置。证据位于 `.scratch/compute-windows-verification/20261012-061009`。

代码验证结束时 HEAD 为 34e8c794719832b9fd319b448602ca97f7253192，tracked 干净；报告落库后实际状态仅有本次 README/报告材料，见 git-end-after-report.txt。权限原始输出见 privileges.log。清理自建隔离目录的命令已校验路径与证据回执，但被自动审批审查以“blocked by policy”拒绝，未执行删除或绕过；该临时目录与已复制证据均保留，见 cleanup.json。

最终状态：确定的 named-pipe 夹具缺陷已修；symlink 权限阻塞和 receipt 不稳定历史仍必须保留，不能声明此 Windows 范围总体通过。未合并、未发布；最终提交/推送由主任务按用户授权完成。
