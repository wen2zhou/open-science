# 共享 Spec

本目录保存可进入版本控制、供多个 Codex 开发 session 共同使用的契约。

## 事实来源

- `CONTEXT.md` 维护项目术语和统一语言。
- Feature spec 维护规范性行为、兼容性和 conformance 场景。
- 代码、测试和 Git evidence 证明实现状态，但不能覆盖已接受的产品决策；发现不一致时必须显式记录。

## 文档语言

新建或更新的 feature spec、decision、实现证据和 handoff 使用简体中文。稳定条款 ID、代码标识符、类型名、命令以及 `MUST`、`SHOULD`、`MAY` 可以保留英文，以维持与代码和测试的可追踪性。

## Spec 状态

每份 feature spec 分别记录两种状态：

- 决策状态：`exploratory`、`proposed`、`accepted` 或 `superseded`。
- 实现状态：`not-started`、`partial`、`conformant` 或 `certified`。

只有 `accepted + conformant` 的行为才是共享实现契约。`certified` 还要求通过该功能的 production-composed release gate。

## Subagent 开发

Subagent 能力应以可独立验收的纵向阶段分别定义和交付。尤其是省略 `profile` 时继承父 Specialist，属于新的产品行为，而不是对当前 Main Agent 默认行为的修正。

Subagent 的轻量任务索引位于 [`subagent/README.md`](subagent/README.md)。具体产品行为只写入对应 feature spec 或 decision，不在任务索引中展开。
