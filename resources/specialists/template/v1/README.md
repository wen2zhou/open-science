# Open Science Specialist 贡献模板

本 ZIP 是一个待填写的 Specialist 包骨架。请替换 `manifest.json` 中的 `<specialist-id>`，并填写 `specialist.json` 的 `name`。完成前出现这两个占位字段 diagnostics 是预期行为；除此之外，模板自身应能被 Package Core 正常解析。

## 包结构

ZIP 根目录必须包含 `manifest.json` 和 `specialist.json`。本模板还包含这一份中英文 `README.md`。一个 ZIP 只包含一个 Specialist；不要增加其他顶层文件。需要随包提供的 Skill 必须放在 `skills/<skill-id>/`，但本空模板不附带示例 Skill。

## Manifest 字段与依赖

- `schema_version`、`exported_with_app_version` 和 `requires_app` 由应用生成；通常不要修改。
- `id` 使用小写字母、数字和连字符，且安装后不可变。
- `version` 使用 SemVer；模板默认从 `0.1.0` 开始。
- `skills.required` 仅引用目标环境中必须已有的非 builtin Skill，并声明 `id` 与 `version_range`。
- `skills.builtin` 仅引用应用自带 Skill，并声明 `id`、`app_version` 与兼容标识；不要复制 builtin 内容。
- `skills.bundled` 声明 ZIP 中实际携带的 Skill，并给出 `id`、精确 `version` 与 `skills/<skill-id>` 路径。
- 所有 Skill 依赖在 v1 都是必需的。缺失或版本不兼容会阻止安装。

## Specialist 与 Connector

`specialist.json` 保存显示信息、system prompt 和 capability 规则；不要在这里重复 manifest 的 Specialist ID 或版本。Connector 只保留稳定 ID 和 tool rules。包内绝不能包含 Connector server 配置、token、凭证、permission grant 或其他 secret。目标应用缺少 Connector 时会警告但不会阻止安装；缺少 required Skill 会阻止安装。

## 安全与大小限制

- ZIP 压缩大小最多 50 MB；解压后总大小最多 200 MB。
- 最多 2,000 个文件；单个文件最多 25 MB。
- 禁止绝对路径、`..` 路径穿越、反斜线逃逸、symlink、hardlink、重复规范化路径、非法压缩方法和异常压缩比。
- Preview/验证绝不执行贡献者脚本、测试或模型调用。脚本内容会产生安全提示。

## 打包、预览与验证

在包含这三个根文件的目录中创建普通 ZIP，例如 `zip -r my-specialist.zip manifest.json specialist.json README.md skills/`（没有 bundled Skill 时省略 `skills/`）。不要把外层工作目录一起压入多层目录。然后在 Open Science 的 Settings → Capabilities → Specialists 中选择 Add specialist → Import ZIP → Choose ZIP。检查 preview 中的身份、兼容范围、依赖、安全限制和全部 diagnostics；修复所有 errors 后再安装。常见问题包括无效 ID、非 SemVer 版本、缺失 required Skill、builtin 兼容不匹配、Connector unavailable warning、未知顶层文件和不安全 archive path。

---

# Open Science Specialist contribution template

This ZIP is an unfinished Specialist package skeleton. Replace `<specialist-id>` in `manifest.json` and fill in `name` in `specialist.json`. Diagnostics for those two placeholders are expected until then; the template itself should otherwise parse cleanly through Package Core.

## Package layout

The ZIP root must contain `manifest.json` and `specialist.json`. This template also contains this single bilingual `README.md`. One ZIP contains one Specialist; do not add other top-level files. Skills shipped with the package belong under `skills/<skill-id>/`, but this empty template includes no example Skill.

## Manifest fields and dependencies

- The application generates `schema_version`, `exported_with_app_version`, and `requires_app`; normally leave them unchanged.
- `id` uses lowercase letters, digits, and hyphens and is immutable after installation.
- `version` is SemVer; the template starts at `0.1.0`.
- `skills.required` references non-builtin Skills that must already exist at the destination and declares `id` plus `version_range`.
- `skills.builtin` references application-provided Skills and declares `id`, `app_version`, and a compatibility identifier; never copy builtin content.
- `skills.bundled` declares Skills actually present in the ZIP with `id`, an exact `version`, and a `skills/<skill-id>` path.
- Every Skill dependency is required in v1. Missing or incompatible versions block installation.

## Specialist and Connector rules

`specialist.json` contains presentation data, the system prompt, and capability rules; do not repeat the manifest Specialist ID or version. Connectors retain only stable IDs and tool rules. A package must never contain Connector server configuration, tokens, credentials, permission grants, or other secrets. An unavailable Connector produces a warning without blocking installation; a missing required Skill blocks installation.

## Security and size limits

- Maximum compressed ZIP size: 50 MB; maximum total uncompressed size: 200 MB.
- Maximum file count: 2,000; maximum single-file size: 25 MB.
- Absolute paths, `..` traversal, backslash escapes, symlinks, hardlinks, duplicate normalized paths, unsupported compression, and suspicious compression ratios are rejected.
- Preview and validation never execute contributor scripts, tests, or model calls. Script content is reported with a security warning.

## Packaging, preview, and validation

Create an ordinary ZIP from the directory containing these root files, for example `zip -r my-specialist.zip manifest.json specialist.json README.md skills/` (omit `skills/` when nothing is bundled). Do not wrap the package in multiple directory levels. In Open Science, open Settings → Capabilities → Specialists and choose Add specialist → Import ZIP → Choose ZIP. Review identity, compatibility, dependencies, safety limits, and every diagnostic in the preview; resolve all errors before installing. Common diagnostics cover invalid IDs, non-SemVer versions, missing required Skills, incompatible builtin Skills, unavailable Connector warnings, unknown top-level files, and unsafe archive paths.
