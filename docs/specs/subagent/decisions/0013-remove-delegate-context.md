---
decision_id: SUB-DEC-0013
title: 删除 host.delegate context 并由 task 承载完整文本说明
status: accepted
affects_specs:
  - SUB-DELEGATION-INPUTS
compatibility: breaking
supersedes: []
---

# 删除 `host.delegate context` 并由 `task` 承载完整文本说明

## 背景与当前行为

`host.delegate()`当前同时接受`task`与可选`context`。两者都由同一Main Agent以自由文本提供；`context`只有非空校验、逐层透传和独立持久化，没有独立的权限、来源、redaction、token budget、UI或Provenance语义。durable child Message已经把两者合并为可见文本，但共享ACP默认prompt忽略`context`，导致持久化记录与provider实际输入不一致。

相比之下，`inputs`声明不可变Upload Version或Artifact Version，参与作用域校验、admission、durable记录和Frame workspace物化，不能由`task`中的普通文本或路径替代。

## 决策

1. `host.delegate()` request删除`context`。`task`是Subagent完整、自包含的文本说明，调用方必须把目标、背景、约束和交付要求写入`task`。
2. 本次删除不提供兼容期、alias、自动拼接、双写或旧调用支持。request或batch任一项出现`context`时，整次调用必须在capacity reservation、workspace准备和durable mutation前以可修正错误拒绝；不得静默忽略。
3. 新写入的delegated Message和runtime context不得保存独立`delegatedContext`或等价字段。旧数据兼容、回填和migration不属于本决策承诺。
4. `inputs`继续作为可选结构化资源字段，只接受当前Project/Session中可解析的不可变Upload Version或Artifact Version identity，并保持既有顺序、admission、持久化和workspace语义。
5. 非空`inputs`物化后，Subagent每个新Attempt的首个provider prompt必须提示从相对目录`./inputs/`读取只读副本。提示不得暴露绝对workspace路径或内部Version identity；同一Attempt内后续父消息不得重复该提示。

## 备选方案

- 保留并修复`context`：能维持既有shape，但为一个没有独立产品行为的浅字段继续承担validation、persistence和prompt组合成本。
- 把`inputs`也写入`task`：无法提供Version identity、Project/Session scope校验、受管内容解析或workspace物化，拒绝。
- 将`inputs`改名为`attachments`或`input_files`：只有在全产品形成统一Project File绑定Interface时才有收益，本阶段不做无行为收益的改名。

## 兼容与迁移

- caller shape为breaking change；没有deprecation window。
- 不新增SQLite、Prisma或Session schema migration，不回写旧Session。
- rollback会重新暴露`context`并移除`inputs`提示，属于行为回退，不承诺无损兼容。

## Conformance 场景

1. single或batch request出现`context`时整批pre-admission拒绝，且无Frame、Attempt、workspace或capacity副作用。
2. 只含`task`的request保持既有provider prompt和结果行为。
3. 非空`inputs`继续通过immutable Version校验并物化到`./inputs/`，provider首个prompt包含相对路径提示。
4. `inputs + output_schema`同时存在时，两项runtime指令均保留，structured-output指令仍位于prompt末尾。
5. Codex、Claude Code与OpenCode production Adapter获得相同的公共提示语义，prompt不含绝对cwd或Version identity。

## 后续影响

- 更新Host contract、Help、RPC/admission、durable types、Session persistence和测试，删除`context`。
- 用一个公共ACP prompt composer负责`task`、`inputs`提示和structured-output指令，不在provider Adapter中重复实现。
- 不宣称`inputs`是Permission Grant、强安全sandbox或自动Artifact provenance。
