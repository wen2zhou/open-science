# Main 统一运行持久化与 Artifact 发布

日期：2026-09-17。基线：`ee1d37700c7841759053b9a48cd71366b816264d`。
分支：`codex/artifact-publication-main-owner`。这是实现及验收记录，不是发布许可。

## 目标与职责

Main 持久化运行消息、工具活动、运行终态、文件归属和发布结果。桌面即时展示流式内容，但不能用整个 Session 快照覆盖 Main 的运行图。正常流式进度差异不能导致文件发布失败。

- `RuntimeSessionOwner` 在 provider dispatch 前等待 durable prompt 及 Main ownership；事件按会话批量提交，终态等待持久化完成。
- shared projector 保持稳定 Message 身份、多 stream、固定 Frame / Branch / Runtime Segment、图片和工具活动、usage 与终态。
- Artifact 发布先提交确定的 owner Message 和 claim 标记，再完成不可变 Version 发布，最后附着最终描述符。向 renderer 发布的文件事件带 `publicationOwner: main`，renderer 不再重复 finalize / save。
- Task 从最新 Main 权威读取结果，不再创建另一个 aggregate owner；Task journal witness 通过当前会话 lane 提交。恢复和失败也使用窄命令，不能写回旧图。
- renderer 用户动作提交稳定 ID 的 append / fork / branch selection / runtime segment / start-run 命令。Main 用当前图验证前置条件；偏好设置使用明确字段；旧通知按 revision 拒绝。
- 自动审查有显式 `runtimeTranscriptReviewOwner`：普通桌面运行由 renderer 消费 Main 终态触发，Task 由 TaskRunner 触发，二者不重复执行。

## 提交与失败语义

Session JSON 是持久化权威；SQLite catalog、Files 索引和通知是后续投影。已知 JSON 提交后的 catalog 失败有明确 `SessionProjectionAfterCommitError`，运行和 Task 路径消费其中的 committed receipt，不重跑 provider。

Artifact 的数据库 finalization、兼容文件发布和 activation 分开记录。部分成功、未知附着结果保留 exact Run / Message / Version 身份。复用 claim 必须匹配同一 execution、Run 和文件描述符集合。子智能体在文件已发布但附着回执不确定时，也不能声称文件操作回滚。

沿用已有发布 marker 和恢复程序，不新增数据库 schema，不删除或猜测修复历史数据，不提高数据库事务 timeout，不关闭 revision、只读、删除或 artifact binding 校验。

## 主要回归证据

- `runtime-authority.test.ts`：a / ab / abc 迟到快照、显式偏好、下一轮 Task、JSON 已提交后 catalog/index/通知失败、旧 Task 不覆盖新运行、流式失败终态、上传 lifecycle 检查。
- `runtime-session-owner.test.ts`：批量提交、保留失败事件、精确发布回执、重复/冲突 claim、取消后继续、元数据持久化失败后继续排空同一次 provider 执行、内存留存约束。
- `runtime-session-projection.test.ts` 与 `session-conversation-command.test.ts`：分支/Frame、文件集合、图片上限、同轮多消息、工具/usage、命令重放与冲突。
- renderer `session-persistence.test.ts` 使用真实 Main state owner 和真实 ordered persistence lane：第一轮 Main Artifact 完成后，定时保存与第二轮显式保存重叠，命令获确认且队列排空，文件和 provenance 保留。
- `artifact-save-crash.integration.test.ts` 使用真实进程强制退出，新增文件已激活但未附着的恢复边界。
- `projection.test.ts` 使用真实 SQLite + 文件系统验证 JSON 提交后 catalog 失败及重启重建。

### 本机验证记录

环境：macOS，Node v23.11.0；依赖使用现有工作区安装。Windows 应使用仓库 CI 的 Node 版本并重新安装本平台依赖。

候选基线是已获取的 `origin/main`（`ee1d37700`）。失败对照使用原始工作区（最终核对 `23e34b6fac6069c939344a1e9b9c96c48cbea092`，落后候选基线 5 个提交），不等同于另建并冻结在 `ee1d37700` 的完整 baseline 环境；两者仍共享已有 native 依赖。

- `npm run typecheck`：通过（Main、sandbox、renderer）。
- 所有变更 TypeScript 文件 ESLint：通过；`git diff --check`：通过。
- `npm run build:e2e`：通过；仅构建，没有启动应用。
- `npm run check:web-api-map`：通过。
- 架构项目：31 个文件、215 项通过，包括新模块所有权及传递消费者登记。
- Windows 指南所列发布契约定向测试：9 个文件、472 项通过，含真实存储和进程崩溃恢复。
- 模块登记审计 + Session 包删除/桌面/服务复测：4 个文件中 3 个通过；171 项通过、3 个导入用例 15 秒超时。已提交错误类型的回归通过，3 个超时用例单独复核全部通过（20.25 秒），但整组在并行负载下的失败仍保留，不宣称全量稳定。
- 最后修正的运行权威 + renderer 通知回归：2 个文件、129 项通过。迟到终态通知不能触发旧运行的自动审查。
- `npm test` 全量：2033 个文件，1980 通过、13 失败、40 跳过；39614 项，38872 通过、50 失败、692 跳过。该轮包含随后已修正的模块登记和已提交错误类型断言，**不是最终全绿记录**。
- 全量失败复核：release mirror 的 Node 目录删除错误、network sandbox 共享临时目录无 receipt 的失败在原始工作区与候选均复现；原生 content removal / Literature cleanup 等 4 个文件中的全部 19 个失败用例，在两者的完整对应套件中逐一复现。Session package 删除和桌面草稿的代表失败在两者单独运行均通过，保留全量负载下不稳定的限制。
- Conda integration 因环境渠道缺少 `r-biocmanager` / `r-ggplot2` 失败，未通过改生产代码或跳过断言掩盖。

完整最终复测结果随候选清单交付。早期运行包含并行编辑中的失败，不能用早期通过数量替代最终验证。

## 尚未关闭的上线验收

| 项目                                              | 当前结论                                                                                            |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Main / renderer / Task 自动回归、类型、lint、构建 | 定向回归、类型、lint、构建通过；全量存在上述失败，以候选清单复测结果为准                            |
| Electron 连续两轮 + 重启                          | 早期构建第一轮生成成功，第二轮在准入前等待；已新增通过的非 GUI 跨模块回归，但完整 Electron 必须重测 |
| 不抢占屏幕焦点                                    | 已停止本机应用 E2E；仅允许在专用测试桌面进行 GUI 验证，不能假定 hidden window 等于不激活应用        |
| Windows 真机 / 安装包                             | 待按配套 runbook 执行并回传证据                                                                     |
| P2028 的实际触发原因                              | 现有日志不足以归因为此次 revision 竞争；没有通过增加 timeout 隐藏问题。仍是未关闭的上线风险         |
| 性能与长期隔离 A15                                | 有事件批处理、留存上限回归；尚无锁定预算的基线/候选测量，不能宣称性能验收通过                       |
| 原始历史 run029/run030                            | 有对应类型的最小回归；不宣称原始大案例及所有历史异常已全部恢复                                      |
| 降级                                              | 未验证旧二进制安全降级；测试使用独立 profile 和升级前备份，不在生产数据上试降级                     |

配套：[Windows 验证指南](artifact-publication-windows-validation.md)。上述未验收项全部复核前，不宣称“彻底根治已上线可用”。
