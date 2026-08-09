---
decision_id: SUB-DEC-0001
title: 省略 profile 时的 Subagent 默认身份
status: accepted
affects_specs:
  - SUB-IDENTITY-RESOLUTION
compatibility: behavior-change
supersedes: []
---

# 省略 `profile` 时的 Subagent 默认身份

## 背景与当前行为

当前 `host.delegate()` 的 `profile` 是可选字段。显式值可以是 Specialist stable ID 或唯一的精确公开名称；`DelegatedWorkAdmissionPolicy` 在 durable admission 前把它解析成 `{ profileId, revision, displayName }` snapshot。省略 `profile` 时，当前实现不读取父 Agent Frame 的身份，直接选择 Main Agent。

这使绑定 Specialist 的 root Agent Frame 无法通过省略重复选择来表达“把工作交给与我相同的 Specialist”。系统已经由 ACP runtime 向 app-owned Notebook RPC server 注册当前 Session runtime 的 Specialist stable ID，但该可信身份尚未进入 delegated-work admission context。Agent 控制的 RPC body 不具备身份权威。

## 决策

1. root Main Agent 调用 `host.delegate()` 时，省略 `profile` MUST 继承发起该受信任 Host invocation 的父 runtime 身份：父 runtime 为 Main Agent 时选择 Main Agent；父 runtime 为 Specialist 时使用该 Specialist 的 stable ID。
2. “继承 Specialist”定义为省略项隐式使用父 runtime 的 Specialist stable ID。child MUST 在 admission 时通过现有 stable-ID resolver 生成自己的 `{ profileId, revision, displayName }` snapshot；本决策不承诺复制父 runtime 启动时的旧 revision、展示名、instructions、Skills 或 Connectors snapshot。
3. 父 runtime 身份 MUST 来自 app-owned capability 或同等可信 context，MUST NOT 接受 Agent 控制的 RPC 参数作为身份来源。一个 batch MUST 在解析各 task 前固定一次父 runtime 身份。
4. 显式 `profile` MUST 保持最高优先级，并继续使用现有 stable ID / 唯一精确公开名称解析语义。显式项与省略项可以出现在同一 batch。
5. 继承的 stable ID若在 admission 时 unknown、disabled、setup-pending 或其他不可运行，整批 MUST 在 capacity reservation、workspace准备和 durable mutation前按现有 Specialist admission error失败；MUST NOT 静默回退到 Main Agent。
6. 本决策只改变 initial Attempt 的省略默认。terminal continuation MUST 保持按 previous Attempt identity继续：previous Main仍为Main，previous Specialist按其stable ID重新解析。
7. 本阶段不新增“显式选择 Main Agent”的 `profile` sentinel。绑定 Specialist 的父 runtime 如需 Main child，必须等待后续独立 decision 与 Interface扩展；不得把潜在 Specialist public name保留为 Main sentinel。

## 备选方案

### 始终默认 Main Agent

保持完全兼容，但无法交付 S4 用户场景，且要求 Specialist root 对每个同身份 child 重复传入自己的 profile。

### 复制父 runtime 的完整 Specialist snapshot

可以冻结与父 runtime 完全相同的 revision和能力，但当前 Agent Frame、Runtime Segment及Host capability都没有完整 snapshot；这会扩大持久化、handoff与provider runtime合同，不适合 S4 最小阶段。

### 从 durable Session binding读取默认

实现较短，但 Session binding可能已切换，而发起Host invocation的Agent Session仍属于旧runtime。它不能证明父Agent Frame身份，会在handoff/switch竞态中继承错误Specialist。

### 保留一个字符串作为 Main Agent sentinel

会改变 caller shape，并可能与现有或未来 Specialist stable ID / public name冲突。该选择需要独立 accepted decision。

## 兼容与迁移

- 这是调用行为变更：父 runtime为Specialist时，旧版省略`profile`得到Main Agent，新版得到父Specialist；父为Main及所有显式`profile`调用保持不变。
- Host request/response shape不变，不新增持久化字段或schema version。
- 历史Attempt不回填、不重解释。新继承Attempt写入现有`resolvedAgent`shape，旧reader可按普通Specialist历史读取。
- 无数据migration。代码rollback只让未来省略调用恢复Main默认；已经持久化的Specialist Attempt及其Frame/runtime label仍可读取。

## Conformance 场景

1. 受信任父runtime为Main，单个及batch省略`profile`均解析为Main，且不调用Specialist resolver。
2. 受信任父runtime为Specialist，省略`profile`按其stable ID解析；持久化、Host result、runtime input及重启投影使用child admission snapshot。
3. 同batch的省略项共享一次固定的父identity；显式项覆盖默认；结果保持请求顺序。
4. inherited或explicit Specialist任一不可用时，整批无reservation、无workspace准备、无durable child。
5. Agent在RPC body伪造父Specialist不能改变app-owned identity；runtime handoff/switch后的新Host invocation使用新注册identity。
6. terminal continuation沿用previous Attempt identity，不重新继承当时的父runtime。

## 后续影响

- 更新 `identity-resolution.md`、Host SDK contract/help、local RPC trusted caller context及production composition。
- 用production-composed release gate证明 Specialist root省略`profile`的真实委派、durable snapshot、runtime消费与重启后投影。
- 若未来需要显式 Main child、父完整能力snapshot或nested delegation，必须另行接受产品decision。
