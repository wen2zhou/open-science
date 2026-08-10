---
decision_id: SUB-DEC-0007
title: Structured output 的 Attempt 归属与 rollback
status: accepted
affects_specs:
  - SUB-STRUCTURED-OUTPUT
compatibility: persistence-impact
supersedes: []
---

# Structured output 的 Attempt 归属与 rollback

## 背景与当前行为

当前 durable Attempt只保存状态、resolved agent、runtime segment identities、时间、`terminalMessageId`与cancel/error。文本 response从`terminalMessageId`指向的Conversation Graph agent Message投影，Artifact也通过Attempt/Message provenance读取。`collect`可用`{frame_id, attempt_id}`固定历史Attempt，因此structured output若只放在内存、Frame current state或最终文本中，就无法支持restart、historical collect与continuation后的稳定读取。

`SessionRuntimeContext.version === 1`中的`delegatedWork.records[].attempts[]`使用严格字段白名单。直接向Attempt object增加schema/value字段后，新reader可以兼容缺字段的旧数据，但发布前reader会把整个delegated runtime context视为非法；这会丢失child inventory/control/history，而不只是忽略S6字段。

Conversation Graph Message sanitizer当前重建已知字段并忽略未知字段，不会因未知Message metadata拒绝整个Session。若发布前版本打开并再次保存，它会丢弃不认识的S6 metadata，但仍保留文本、Artifact与delegated runtime context。这个差异决定了S6的rollback承诺。

## 决策

1. admitted schema snapshot、dialect identity、accepted structured value与validation acceptance evidence MUST durable绑定exact Attempt。Frame current state、Attempt数组位置、最终prose或provider临时状态都不得作为归属来源。
2. schema snapshot MUST 随initial child admission在同一atomic Session mutation中写入，并保持不可变。后续submit只能使用该durable snapshot；collect不得用升级后的validator重新解释或改写已经accepted的历史结果。
3. accepted submission MUST 通过独立的单次CAS mutation durable写入Attempt-owned Message evidence。该mutation MUST 同时重验Session、Frame、current Attempt、schema identity与writable状态；不得分成“先写value、后写validated标志”的可见中间态。
4. persistence表示 MUST 选择发布前Message reader可以安全忽略的additive metadata位置；S6 MUST NOT 为了schema/value直接扩展当前严格白名单的Attempt object，除非另有accepted migration/rollback decision替代本条。
5. terminal result projection MUST 从一个authenticated durable snapshot读取pinned Attempt的schema contract与accepted value。blocking delegate、bounded collect、重复selector、historical Attempt与Session reopen MUST 得到同一JSON语义；读取或关联失败时整批throw，不得伪装为running或unsatisfied。
6. restart前已accepted但尚未terminal的submission保持durable；restart recovery仍按现有`cancelled/runtime_interrupted`收口Attempt，并按`SUB-DEC-0006`投影已accepted value与terminal status。
7. 新reader MUST兼容完全缺失S6 metadata的旧Message与Attempt，不做`null`、空object、schema或value backfill。旧terminal result继续只包含原有文本、Artifact与terminal字段。
8. schema与value在进入persistence前 MUST 经过独立JSON-safe sanitizer和独立大小/节点/深度预算；不得只依赖Session runtime context共享的2,000-node、depth 20预算，也不得让单个坏payload使整个Session或delegated runtime context不可读。
9. 直接降级到发布前版本 MAY 打开Session并继续读取文本、Artifact与delegated Attempt历史；发布前版本不理解也不承诺保留S6 metadata。用户若在降级版本中保存Session，随后重新升级时 MAY 丢失schema、structured output与其validation evidence。
10. 因第9项，S6 rollout MUST 在文档中标明有损rollback边界，并在降级前建议保留Session备份。S6不交付downgrade migration、metadata恢复或跨版本双写；不得声称structured output在旧版本round-trip后仍可恢复。
11. Attempt-owned Message evidence MUST整体保存`attemptId`、dialect、validator profile identity、canonical schema digest、schema与可选accepted record。accepted record MUST在一次mutation中包含value与`acceptedAt`；不得把value和validated flag分开写。continuation没有显式schema时不创建该evidence。
12. S6 MUST保持`SESSION_FILE_VERSION`、`ConversationGraph.schemaVersion`与`SessionRuntimeContext.version`不变。Conversation Graph version bump会令发布前reader拒绝整个Graph；runtime version或Attempt字段扩展会扩大rollback影响，均不属于本阶段。

## 备选方案

- **扩展Attempt object并接受version-gated rollback**：归属直接，但旧reader会拒绝整个delegated runtime context，扩大数据恢复影响。
- **提升Session/runtime schema version**：边界清晰，但需要完整upgrade/downgrade策略，超过S6最小能力。
- **仅保存schema hash或仅保存value**：无法证明历史结果按哪个合同被接受，也无法可靠诊断或审计。
- **把structured output变成Artifact**：获得现有Artifact persistence，但改变ownership、finalization与caller shape，不符合S6“保留Artifact而非替代/伪装为Artifact”的目标。
- **terminal时才写value**：减少字段，但`submit_output` acknowledgment与crash之间会丢失已接受结果。

## 兼容与迁移

- 新版本读取旧Session：additive，无migration或backfill；缺字段即无structured-output contract。
- 新版本写入S6数据后由旧版本读取：文本、Artifact与delegated runtime context继续可读，S6 metadata不可见。
- 旧版本再次保存后的re-upgrade：S6 metadata可能丢失；备份是本阶段唯一恢复路径。
- `SESSION_FILE_VERSION`、Conversation Graph与runtime context schema version均不提升。

## Conformance 场景

1. 发布前old-data fixture在新reader中可读，无S6字段且不backfill。
2. schema随initial admission atomic写入；batch admission失败不留下schema metadata。
3. valid submission acknowledgment后立即crash，reopen仍可定位exact Attempt value。
4. continuation后historical handle返回旧Attempt structured result，current Attempt不串用旧schema/value。
5. 重复collect与重复selector返回同一JSON语义，不消费或移动ownership。
6. submission与terminal/stop并发时只接受一个合法CAS顺序，无partial validation state。
7. oversized、过深、non-finite或prototype-pollution payload被拒绝，Session其余数据仍可读。
8. 新版本写S6数据后，发布前reader仍可读取Session、Message、Artifact与delegated Attempt历史。
9. 发布前reader保存再re-upgrade时，测试明确证明S6 metadata可能丢失且其他核心数据保留。
10. 从降级前备份恢复可重新取得S6 metadata；恢复说明标注备份后变更会丢失。

## 后续影响

- 已用baseline `fc3f4151`真实reader临时fixture验证：未知Message metadata被忽略但Session、Graph与delegated runtime context保留；旧reader再次保存后只丢S6 metadata；Attempt未知字段则会丢整个runtime context。writer必须把该临时证据转为project-ownedold/new reader fixture。
- `session-record-adapter`、Session coordinator、in-memory records、sanitizer、projection与production-composed reopen/recollect均属于S6必需影响面。
- Renderer、Reviewer、conversation export与Provenance暂不展示或审计structured output；这是S6显式非目标和剩余审计风险，不得把durable存在等同于这些consumer已支持。
