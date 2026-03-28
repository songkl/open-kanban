# Kanban Do Skill

Use the kanban MCP tools to pick and execute a pending task end-to-end:

## Steps

1. **获取待办任务** — 调用 `mcp__kanban__list_tasks` 并传入 `status: "todo"` 获取所有待办任务。如果没有待办任务，告知用户并停止。获取时要注意用户是否给了 board或boardId,和 status

2. **选择任务（自动按优先级）** — 按以下规则自动选择任务，无需人工参与：
   - 首先按优先级排序：high > medium > low
   - 如果多个任务优先级相同，选择 ID 最小的任务（最早创建的任务）
   - 告知用户已自动选择的任务标题和优先级

3. **立即移动到进行中（抢锁）** — 调用 `mcp__kanban__update_task` 将选中任务的 `status` 改为 `in_progress`，确保其他用户无法同时选择该任务。告知用户任务已锁定并开始处理。

4. **读取任务详情** — 调用 `mcp__kanban__get_task` 获取完整任务描述，仔细阅读并理解需要完成的工作内容。

5. **执行任务** — 根据任务描述完整地执行工作：编写代码、修改文件、调试问题等。认真完成任务要求的所有内容。

6. **添加完成评论** — 调用 `mcp__kanban__add_comment` 为任务添加评论，总结：
   - 完成了哪些工作
   - 修改了哪些文件（如有）
   - 需要审核的要点

7. **移动到待审核** — 调用 `mcp__kanban__update_task` 将任务 `status` 改为 `review`，告知用户任务已完成并等待审核。

## 错误处理

- 若 kanban MCP 不可用：提示用户检查 MCP 服务器配置
- 若任务移动失败（可能已被其他用户抢占）：返回步骤1重新选择其他任务
- 若任务描述不清晰：调用 `mcp__kanban__add_comment` 添加评论说明任务描述不清晰，无法执行的具体原因，然后退出本次执行
- 若执行过程中遇到阻塞：在评论中说明进度和阻塞原因，再移动到 review
