---
decision_id: SUB-DEC-0014
title: Host SDK Help 采用扁平字段说明与错误驱动纠正
status: accepted
affects_specs:
  - SUB-HOST-SDK-DISCOVERY
  - SUB-HOST-SDK-PROGRESSIVE-HELP
compatibility: behavior-change
supersedes: []
---

# Host SDK Help 采用扁平字段说明与错误驱动纠正

## 背景与当前行为

基线`b06862c8`上，`host.help('delegate')`一次返回完整request/options schema、三种return union、14条constraints、4个examples与errors。minified JSON为10,120字符、约2,043个cl100k tokens；其中`request`与`returns`合计5,929字符。结果超过Notebook MCP的8,000字符单项inline budget，正式Agent-facing响应会省略正文。

把合同拆成多个Help section只能缩短单次响应，Agent仍可能逐项读取而增加累计上下文。完全移除参数与返回说明也不可取：Agent需要知道字段名、用途和结果含义才能可靠调用。问题不在于存在字段说明，而在于当前Help把用于runtime验证的完整嵌套Schema、重复分支和罕见错误全部投影进Agent上下文。

## 决策

1. `host.help()`继续只提供八个公开Subagent operation的catalog；不得新增`.request`、`.returns`、`.errors`或`.full`等section topics。
2. 每个operation topic MUST保留`request`、`options`与`returns`，但它们 MUST是扁平字段说明而不是JSON Schema或完整validation tree。
3. 每个输入字段说明 MUST只包含`name`、简短`type`、`required`和一句`description`；仅在适用时增加`default`或`range`。相同字段不得因single/array调用形式重复。
4. 每个返回字段说明 MUST只包含`name`、简短`type`、是否始终存在或`when`条件，以及一句`description`。共享child字段只定义一次，不得在每个result variant内复制。
5. `host.help('delegate')` MUST说明：
   - request接受一个object或non-empty object array；字段为required `task`、`name`，optional `profile`、`inputs`、`output_schema`；`context`已由`SUB-DEC-0013`删除，不得再发布；
   - options字段为`wait`和`timeout_seconds`；
   - return discriminator为`kind = receipts | observations | results`，并分别说明触发条件和允许的child status；
   - child字段说明覆盖当前公开返回字段，但`Artifact Version metadata`、structured output JSON和error内部实现不得递归展开。
6. `delegate` guide MUST单次覆盖普通Main工作流：single/batch、async、bounded wait，以及异步后的`children`、`collect`、`stop_child`最小调用形状。完成普通delegation不得要求查询其他Help topic。
7. Help MUST NOT列出exhaustive errors。Caller-correctable Host错误 MUST在调用时标识operation、失败字段或目标、违反的约束、允许值或范围，以及修正/重试动作。临时不可用必须说明是否可稍后重试；authorization失败不得泄漏其他identity。
8. Notebook静态导航 MUST告知Agent不要预取catalog全部topics。首次delegation MAY查询一次concise `delegate` guide；其他topic只在准备调用相应非普通流程operation且现有说明不足时查询。
9. 按`JSON.stringify(result)`计量，`host.help('delegate')` MUST不超过3,200字符，其他Subagent operation topic MUST不超过3,600字符，catalog MUST不超过2,500字符。正式REPL→Notebook MCP路径 MUST完整返回正文，无truncation或omission marker。
10. 本决策 MUST NOT改变八个Host operation的调用/成功结果shape、authorization、batch atomicity、Attempt/Frame语义、provisioning或持久化数据。完整runtime contract继续由parser、Owner和project-owned tests拥有。

## 备选方案

- 完整Schema拆成多个section：单项更短，但鼓励Agent枚举文档树，累计token成本更高。
- Compact Schema：仍包含required arrays、properties tree和variant nesting，结构开销大于字段说明。
- 提高MCP inline budget：解决可达性，不解决固定上下文成本。
- 完全移除参数/返回信息：token最少，但Agent需要猜测字段和result flow。
- 把合同复制到system prompt：每个Turn固定付费且容易与runtime漂移。

## 兼容与迁移

- `host.help(query)`调用shape、catalog和八个operation ids不变。
- `request`、`options`、`returns`顶层字段保留，nested内容从exhaustive schema改为flat field descriptions，属于behavior-change。依赖`oneOf/properties/required`树生成SDK的caller不再受支持；目标consumer是执行任务的Agent。
- 精确runtime合同继续保留在`delegate-contract.ts`、Owner validation与contract tests中。若未来需要公开Schema introspection，应建立独立Interface。
- 无migration、backfill、schema version或Session rewrite。Rollback只恢复旧Help正文。

## Conformance 场景

1. Main只读取`help('delegate')`即可构造当前single/batch request，并确认`context`不存在。
2. request/options/returns均为扁平字段说明；同一request或child字段只出现一次。
3. returns列出三种kind、触发条件、status集合和全部公开child字段，但不递归展开opaque payload。
4. invalid field、timeout冲突、unauthorized target及临时不可用在真实调用时给出修正或重试动作。
5. prompt不要求预取全部topics；所有topics满足字符预算并经真实MCP完整返回。
6. Help精简后runtime parser、accepted result union、Owner authorization与durable regression不变。

## 后续影响

- S13深化现有`HostSdkHelpRegistry`，不新增Help section registry或Domain Module。
- S9的exhaustive Help投影由本决策和S13替代；operation目录、role-aware availability与production child capability合同继续有效。
- 审计八个公开operation的caller-correctable错误文本；只补充内容，不改变error envelope或authorization。
