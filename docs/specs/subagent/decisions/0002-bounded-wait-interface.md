---
decision_id: SUB-DEC-0002
title: Delegated Wait 的 timeout 与 observation Interface
status: accepted
affects_specs:
  - SUB-DELEGATED-WAIT
  - SUB-DELEGATE-WAIT
compatibility: behavior-change
supersedes: []
---

# Delegated Wait 的 timeout 与 observation Interface

## 背景与当前行为

当前 `host.collect(frame_ids)` 没有 timeout，只有全部目标 child 进入终态后才返回；省略参数意味着可能无限等待。`host.delegate(request, options)` 只有 `wait?: boolean`：`wait:false` 返回 `kind:"receipts"`，省略或 `wait:true` 则无限等待并返回 `kind:"results"`。

这会让慢 child 或等待权限的 child 长时间占用 Main Agent 的控制 REPL。补充参考产品提供有限等待，但其 positional timeout、默认值、状态词和 bare return shape 不是本项目既有契约，不能直接复制。

## 决策

1. Host SDK 统一使用 options object 中的 `timeout_seconds`：

   ```js
   await host.collect(selectors, { timeout_seconds: 30 })
   await host.delegate(request, { timeout_seconds: 30 })
   ```

2. `timeout_seconds` MUST 是 finite number，范围为 `0..1800` 秒。非法类型、`NaN`、Infinity、负数或超过上限 MUST 在产生可观察副作用前拒绝，不得截断。
3. `host.collect` 省略 `timeout_seconds` 时 MUST 使用 30 秒默认值。这是对当前无限等待默认的行为变更。
4. `host.delegate` 省略 `timeout_seconds` 时 MUST 保持当前 all-settled 无限等待；显式 timeout 才启用 bounded wait。
5. `host.delegate(request, { timeout_seconds })` MUST 隐含 `wait:true`。`wait:false` 与 `timeout_seconds` 同时出现 MUST 在 admission 前拒绝。
6. `timeout_seconds:0` MUST 表示不等待：完成授权、selector 固定或 atomic admission 后读取一次 durable observation。
7. bounded wait 的完成条件为 all-settled-or-deadline：全部目标 Attempts 终态时可提前返回，否则在 deadline 后基于一次最终 durable snapshot 返回。
8. timeout 只约束等待 child 终态的阶段，不是整个 Host 调用的硬实时 SLA；最终 snapshot、Artifact 投影和 RPC 序列化 MAY 产生必要尾部开销。
9. `host.collect` MUST 保持 bare array 顶层 shape，并把元素扩为 terminal result 或最小 running observation。
10. 显式 timed `host.delegate` MUST 始终返回：

    ```js
    { kind: "observations", children: [/* terminal result | running observation */] }
    ```

    即使全部 child 提前终态也不得改回 `kind:"results"`。该 wrapper 不增加 `deadline_expired`、`waited_seconds` 等计时元数据。

11. 无 timeout 的 `kind:"results"` 继续表示全部 children 已终态；`wait:false` 的 `kind:"receipts"` 继续表示 admission receipts。
12. timeout 到期只结束本次 Delegated Wait，MUST NOT stop、cancel、terminalize、fence 或修改任何 Attempt。

## 备选方案

- 保持 `collect` 省略 timeout 时无限等待：兼容性最好，但不能消除本阶段要解决的默认挂起风险。
- 使用 positional timeout 或毫秒字段：与现有 Host options 形状或 `timeout_seconds` 约定不一致。
- timed `delegate` 在全部终态时返回 `results`、有 running 时返回 `observations`：让 discriminator 受完成竞态影响。
- 把 running 加入现有 `results`：破坏“results 全终态”的既有 terminal meaning。
- 对超大 timeout 做 clamp：隐藏 caller 错误，且实际等待与请求不一致。

## 兼容与迁移

- 无 persistence migration；waiter 和 deadline 不持久化。
- `collect` 顶层仍为 array，但省略 timeout 的默认和元素 union 改变。Host contract、Help、local RPC、REPL mapper 与消费者 MUST 原子更新。
- running observation MUST NOT 伪造 `artifacts_created` 等 terminal-only 字段。
- rollback 可继续读取所有旧 durable Session；但会恢复无限 `collect`、拒绝新 options/selector，发布时不得混用不兼容的 Host mapper 与 Main Module。

## Conformance 场景

1. 省略 `collect.timeout_seconds`，30 秒后返回部分 observation，running child 未收到 cancel。
2. 显式 `0` 只读取一次 snapshot；显式 `1800` 被接受；越界或非 finite 值在 side effect 前拒绝。
3. 所有目标在 deadline 前终态时提前返回。
4. deadline 与 terminal commit 竞态以最终单一 snapshot 为准。
5. timed `delegate` 无论提前完成或到期都返回 `kind:"observations"`。
6. `wait:false + timeout_seconds` 整批拒绝且不 admission child。
7. timeout 后 child 完成，新的 `collect` 返回 durable terminal result。

## 后续影响

- 更新 `delegated-wait.md`、`delegate-wait.md`、Host machine-readable contract、`host.help` 与 REPL 示例。
- S3 可以扩展 lifecycle observation，但不得改变本决策的 timeout、终态或不取消语义。
- Attempt Deadline 是独立产品维度，不得复用 `timeout_seconds`。
