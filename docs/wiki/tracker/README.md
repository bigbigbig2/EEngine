# Markdown Tracker 约定

需要把方向拆成实施工作时使用：

```text
docs/wiki/tracker/<feature>/
├─ PRD.md
└─ issues/
   ├─ 01-事项.md
   └─ 02-事项.md
```

Issue 顶部字段：

```text
Status: needs-triage | ready-for-agent | in-progress | blocked | done | wontfix
Owner: optional
Depends-On: optional
ADR: optional
```

Issue 必须包含问题证据、范围、非范围、接口/ABI、验收、benchmark/验证和 Comments。完成时更新状态、实现摘要和实际验证；同一 feature 全部完成后删除过期任务或移动到 `tracker/archive/`。
