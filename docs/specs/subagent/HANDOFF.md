# Subagent 阶段 handoff

- 阶段：S6 Structured output
- Active spec：`docs/specs/subagent/structured-output.md`
- 决策状态：`accepted`
- 实现状态：`conformant`（accepted Interface/Adapter合同通过；完整desktop release gate被既有Renderer focus restoration阻塞）
- 分支 / 已验证代码 SHA：`codex/s6-structured-output-spec` / `0aaae702`
- Owner Module / Interface：`DurableDelegatedWork` / parent `delegate`、`collect`与child-only `submitOutput`

## 已交付

- 每个request可选`output_schema`；admission在capacity/workspace/durable child之前按Draft 2020-12 profile和独立预算整批校验。
- child通过dedicated delegated-notebook capability调用`host.submit_output(value)`；owner身份不取自body。valid first write、canonical-equal retry、different retry、late/no-schema/revoked语义由同一durable CAS边界负责。
- blocking `delegate`与`wait:false → collect`保留文本、Artifact并投影`structured_output`或`structured_output_unsatisfied`；running surface不泄露schema/value/error。
- initial Attempt的schema/value作为整体evidence保存在initiating Message，包含`attemptId`、dialect/profile、canonical digest、schema与可选`accepted { value, acceptedAt }`；Attempt严格白名单和所有schema version保持不变。
- Codex、Claude Code与OpenCode共享app-owned ACP/Notebook seam；Ajv 8.20移为production dependency。

## 条款与证据

- `STRUCT-001..003`：atomic request/schema admission -> `structured-output.test.ts`、`structured-output-owner.test.ts`。
- `STRUCT-004..009`：child-only auth、safe validation、idempotency、non-terminal submit、terminal race -> Owner与`delegated-lane-capability.test.ts`。
- `STRUCT-010..016`：running privacy、terminal coexistence/status、重复/historical collect、deadline/continuation/reopen -> Owner、`session-record-adapter.test.ts`与既有bounded collect tests。
- `STRUCT-017..019`：old data、pre-S6 save有损rollback、独立storage预算、corrupt evidence fail-closed -> `delegated-work-records.test.ts`、`pre-s6-session-reader.fixture.ts`、`session-persistence.test.ts`。
- `STRUCT-020`：`production-composition.test.ts`使用真实`createProductionDelegatedWorkFrameworks`及Codex、Claude Code、OpenCode production execution adapters；project-owned fake runtime/process只驱动provider边界，child经issued delegated-notebook RPC capability提交。desktop gate由真实OpenCode child经REPL调用`host.submit_output`，并覆盖terminal text、Artifact、structured result与重启读取。

## 最终验证结果

以下成功结果均在最后代码修复后运行；文档更新后又执行格式与diff检查：

- 最后修复后的Owner/validator/Adapter/persistence/Host/RPC/public ACP focused suite：92 files / 1469 tests passed。
- production framework composition与child RPC回归：2 files / 32 tests passed；三framework production adapter structured contract及async/reopen/rollback场景均通过。
- `RUN_KERNEL=1 npm test -- src/main/notebook/repl-loop.integration.test.ts`：39 passed。
- `npm run typecheck`：通过；S6 material files的focused ESLint通过。
- `npm run lint`：被未修改baseline文件`src/main/delegated-work/specialist-runtime-consumption.test.ts:54`的`explicit-function-return-type`错误阻塞；另有15个未修改baseline warnings。
- `npm run build:e2e`：main/preload/renderer production build完成（仅既有dynamic-import warning）。
- `npm test`：12485 passed、191 skipped、9 failed；失败全部来自未修改的Reviewer certification contract重复注册（5 files，`reviewScopes`预期2而实际4），S6未修改Reviewer路径。
- `npx playwright test e2e/subagent-release-gate.spec.ts`：S6 production-composed journey独立通过；完整文件预期为3 passed、1 failed，唯一失败是既有persisted-surface close后焦点未返回`summaryToggle`。该Renderer行为是S6明确非目标，因此不修复、不标`certified`。

## Review

- Standards：修复production auth改动误用`test` commit类型、Frame ID冒充Message ID、重复OpenCode fixture，以及弱化keyboard focus断言；最终复审无actionable finding。
- Spec：此前修复全局RPC bearer伪造child、corrupt/cross-Frame evidence fail-closed及独立pre-S6 behavioral snapshot。本轮补齐真实三framework production adapter + issued child capability contract与desktop OpenCode REPL journey，并按复审补强invalid后与accepted后仍running时的receipt/children/collect两字段隐私、initial accepted terminal→continuation→pinned historical recollect、continuation无schema、missing与rollback直接证据。
- 未发现timed delegate、continuation inheritance、provider JSON extraction、Renderer/Reviewer/export、Artifact ownership等scope creep。

## 兼容性、rollback与剩余风险

- 新reader读取旧Session时不backfill；无schema调用/result shape保持旧合同。
- 降级前必须备份Session。pre-S6 reader可保留文本、Artifact、Graph和delegated runtime context；旧版本再次保存会丢S6 Message metadata，重新升级不可恢复该metadata。
- Renderer、Reviewer、conversation export与Provenance仍不展示/审计structured output，属于明确非目标。
- 三framework Adapter conformance使用project-owned fake runtime/backend/process经过真实production adapters；desktop certification实际运行OpenCode ACP child。未在本gate启动外部Codex/Claude Code executable，版本升级仍须复用既有provider certification审计。
- transport会在method-level budget之前完整缓冲RPC body；跨RPC统一body cap仍是剩余DoS风险。
- S6已达到`conformant`；待独立Renderer阶段修复focus restoration并让完整desktop gate通过后才可升为`certified`。证据不包含也不声称S2 timed delegate。跨RPC统一body cap仍需独立阶段处理，不能反向改变本阶段validator合同。

## 下一 session 必读

- `docs/specs/subagent/structured-output.md`
- `docs/specs/subagent/decisions/0006-structured-output-interface.md`
- `docs/specs/subagent/decisions/0007-structured-output-persistence.md`
- `.codex/skills/subagent-stage-development/references/stage-gates.md`
