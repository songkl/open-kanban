---
name: do-kanban
description: Use the kanban MCP tools to pick and execute a pending task end-to-end
---

# Kanban Do Skill

Use the kanban MCP tools to pick and execute a pending task end-to-end:

## Steps

1. **获取/确认任务** — 检查用户是否提供了 taskID：
   - 如果提供了 taskID，直接调用 `mcp__kanban__complete_task` 进行抢锁，任务将自动流转到下一列
   - 如果未提供，调用 `mcp__kanban__list_my_tasks` 获取当前Agent负责的任务。如果获取不到，调用 `mcp__kanban__list_tasks` 并传入 `status: "todo"` 获取所有待办任务。如果没有待办任务，告知用户并停止

2. **选择任务（自动按优先级）** — 如果步骤1未使用 taskID，按以下规则自动选择任务，无需人工参与：
   - 首先按优先级排序：high > medium > low
   - 如果多个任务优先级相同，选择 ID 最小的任务（最早创建的任务）
   - 告知用户已自动选择的任务标题和优先级
   - 然后调用 `mcp__kanban__complete_task` 进行抢锁，任务将自动流转到下一列

3. **读取任务详情** — 调用 `mcp__kanban__get_task` 获取完整任务描述，仔细阅读并理解需要完成的工作内容。

4. **获取列说明** — 调用 `mcp__kanban__list_columns` 获取当前列的信息，查看列的描述（description 字段）。如果列有描述，按描述中的要求执行；如果没有描述，则按任务描述执行。

5. **执行任务** — 根据列描述（如有）或任务描述完整地执行工作：编写代码、修改文件、调试问题等。认真完成任务要求的所有内容。如果列描述中的要求与任务描述冲突，优先遵循列描述的指示。

6. **添加完成评论** — 调用 `mcp__kanban__add_comment` 为任务添加评论，总结：
   - 完成了哪些工作
   - 修改了哪些文件（如有）
   - 需要审核的要点

7. **完成任务并流转** — 调用 `mcp__kanban__list_columns` 获取所有列信息，判断当前列状态名是否包含"中"或"ing"（如"进行中"、"doing"等表示正在执行的状态）。如果包含，调用 `mcp__kanban__complete_task` 将任务流转到下一列。如果不包含，说明任务已在最终状态，无需流转。

8. **执行失败处理** — 如果执行过程中遇到阻塞或失败，调用 `mcp__kanban__list_columns` 获取所有列的顺序，判断当前列是否为第一列。如果不是第一列，将任务状态更新为前一列对应的状态值；在评论中说明进度和失败原因，然后退出。

## 错误处理

- 若 kanban MCP 不可用：提示用户检查 MCP 服务器配置
- 若任务移动失败（可能已被其他用户抢占）：返回步骤1重新选择其他任务
- 若任务描述不清晰：调用 `mcp__kanban__add_comment` 添加评论说明任务描述不清晰，无法执行的具体原因，然后退出本次执行
