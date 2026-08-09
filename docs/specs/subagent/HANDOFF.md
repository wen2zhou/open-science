# Subagent 阶段 handoff

阶段：S2 Bounded `delegate` wait
Active spec：`docs/specs/subagent/delegate-wait.md`
决策状态：`accepted`
实现状态：`conformant`（candidate为包含本文档的紧随提交）
分支 / candidate：`feat/subagent-delegation` / S4基线`c503a521`；最终集成parent为`0d2deb0a`
Owner Module 与 Interface：`DurableDelegatedWork` / `delegate`

## 已交付

- S1 `SUB-DELEGATED-WAIT`已达到`accepted + certified`，提供bounded collect、stable observations、Attempt selectors与active-branch read authorization。
- S2 `DELEGATE-001..020`已实现：timed delegate、launch-established、跨Turn control、permission fail-closed、Turn fence、attempt-pinned branch Stop、Renderer Send/Stop并存及mouse/Enter gate。
- 新Attempt durable写入initiating Turn；old terminal data兼容读取；首次S2 schema写入前保留immutable `*.json.pre-s2-backup`。

## 明确非目标

- S3 lifecycle taxonomy、durable Scheduler、nested delegation、Specialist继承、model routing、structured output与running child跨app restart恢复。

## 已接受与开放决策

- 已接受：`SUB-DEC-0002`、`SUB-DEC-0003`与S1合同。
- 已接受：`SUB-DEC-0004`、采用version-gated rollback的`SUB-DEC-0005`，以及S2 `DELEGATE-001..020` stable合同。
- 开放：无。

## 兼容性与持久化

- 现有 caller 行为：`delegate`只有`wait?: boolean`；无timeout保持all-settled `results`，`wait:false`返回`receipts`。
- Migration / 旧数据行为：当前 persisted Attempt没有initiating Turn字段，sanitizer为严格字段白名单。直接扩展Attempt object可能令发布前reader拒绝整个delegated-work runtime context。
- Rollback：含S2新数据的Session不支持直接降级。降级必须恢复升级前备份，并接受备份之后Session变更丢失；S2不新增downgrade migration。

## 已修改热点

- delegated-work Owner Module、Runtime Coordinator、production composition、Host/REPL、Session persistence、Renderer与release-gate fixture均已接通；writer lease在candidate提交后释放。

## 验证

- `DELEGATE-001..020`的Interface、Adapter、Coordinator、Host/REPL、persistence与Renderer回归：15个targeted test files，`344 passed / 30 skipped`。
- production composition回归覆盖pre-work admission fence、Turn Cancel收口、inactive branch Stop不误杀、partial failure保留成功/可重试，以及permission与Send gate。
- `npm run typecheck`通过；`npm run lint`仅剩未修改基线`specialist-runtime-consumption.test.ts:54`的return-type error及15条既有warning；S2变更文件focused ESLint为0 error。
- 最后material edit后的`npm test`为`12477 passed / 191 skipped / 9 failed`；9项均是`reviewScopes`在`c503a521`即存在、且可由unchanged certification-contract单测独立复现。并发资源造成的`mcp-server`与`ProjectFilesView`两个timeout随后单独复跑`2 passed / 119 skipped`。
- `npm run build:e2e`通过；`npx playwright test e2e/subagent-release-gate.spec.ts`为`4 passed`，覆盖真实production-composed timed两Turn、Turn Cancel、delegated permission、Send/Stop并存、keyboard/focus与重启后durable surface。
- 双轴`$code-review`由两个`gpt-5.6-sol` medium只读reviewer完成。Standards发现的重复helper/state machine与证据缺口、Spec发现的inactive permission gate、Turn Cancel收口、backup schema检测、Stop aggregate error均已修复；两轴follow-up均为Pass。
- Consumer / platform：纳入Node、Web、Host/REPL、persistence、Renderer与本地Electron desktop，因为S2跨越这些seams；不纳入真实provider、跨平台packaging与restart后恢复running child，因为不属于S2合同。
- Candidate tree：S2验证基于S4 commit `c503a521`，并保留随后集成的workspace修复`0d2deb0a`；candidate为包含本文档的紧随提交。

## 剩余风险

- 当前标`conformant`而非`certified`：Playwright尚未自然覆盖inactive-branch Stop与partial-failure desktop journey；不得用unit fake或production-composition单测替代这两条release gate。
- 完整lint仍有上述未修改基线error，完整test仍有9项S4引入的review projection基线失败；本S2不扩scope修改S4 projection语义。
- 方案B rollback会丢失`.pre-s2-backup`之后的Session变更，且没有downgrade migration。
- 未覆盖跨平台package lane；本阶段不承诺running child跨app restart恢复。

## 下一项最小任务

- 在不增加测试专用生产接口的前提下，为inactive-branch Stop与partial-failure增加真实desktop-composed journey；通过后才把S2提升为`certified`。

## 下一 session 必读

- `docs/specs/subagent/delegate-wait.md`
- `docs/specs/subagent/decisions/0004-turn-scoped-cancellation.md`
- `docs/specs/subagent/decisions/0005-attempt-turn-link-rollback.md`
- `.codex/skills/subagent-stage-development/references/stage-gates.md`
- `src/main/delegated-work/durable-delegated-work.ts`
- `src/main/delegated-work/delegated-work-read-model.ts`
- `src/main/acp/runtime-coordinator.ts`
- `src/renderer/src/pages/workspace/ConversationPanel.tsx`
