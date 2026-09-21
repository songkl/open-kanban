import { test, expect } from '@playwright/test';
import { login, createBoard, createTask } from './helpers';

// s-1269: TaskRunIndicator's full mode used to wrap the status pill
// ("● 上次运行 · 已 · · 运行器: mi… 16 完成 秒") onto two lines on the
// admin board. This regression test asserts the badge fits on a single
// row on the canonical 1440x900 desktop viewport.
//
// Flow:
//   1. Login + create board + create task via the existing UI helpers
//      (so the user owns the board as admin).
//   2. Use the browser context's authenticated `page.request` to call
//      POST /api/v1/runs/claim against the freshly created task. The
//      helper logs in through the UI so the kanban-token cookie is
//      already attached to every request issued from this context.
//   3. Reload the board so the live `task_runs` row is reflected on
//      the task card.
//   4. Assert the badge's measured height stays under the 32 px
//      budget (single row = spinner + status pill + dot + runner
//      label + elapsed counter all on one line).

test.describe('TaskRunIndicator (s-1269)', () => {
  test('full-mode badge stays on a single line on 1440x900', async ({ page }) => {
    test.setTimeout(60_000);
    await page.setViewportSize({ width: 1440, height: 900 });

    const user = `runindicator_${Date.now()}`;
    await login(page, user);
    await createBoard(page, `Run Indicator Board ${Date.now()}`);

    const taskTitle = `Run Indicator Task ${Date.now()}`;
    await createTask(page, taskTitle);

    // The UI flow above creates the task in the board's "Todo" column
    // and the creator is the board admin (can claim from any column
    // they can write to). Look up the task id via the kanban API so
    // the claim call below can target it directly. The auth cookie is
    // already attached to page.request via the context.
    const tasks = await page.request.get('/api/v1/tasks?status=todo');
    expect(tasks.ok()).toBeTruthy();
    const taskList = (await tasks.json()) as Array<{ id: string; title: string; boardId: string; columnId: string }>;
    const target = taskList.find((t) => t.title === taskTitle);
    expect(target, `expected to find created task "${taskTitle}"`).toBeTruthy();

    const claim = await page.request.post('/api/v1/runs/claim', {
      data: {
        boardId: target!.boardId,
        status: 'todo',
        agentType: 'opencoder',
        runnerId: 'mac-66681-regression-runner',
      },
    });
    expect(claim.ok(), `claim failed: ${claim.status()} ${await claim.text()}`).toBeTruthy();

    // Reload so the board picks up the freshly claimed row.
    await page.reload();
    await expect(page.getByText(taskTitle)).toBeVisible();
    const badge = page.getByTestId('task-run-indicator').first();
    await expect(badge).toBeVisible();

    const height = await badge.evaluate((el) => (el as HTMLElement).getBoundingClientRect().height);
    // s-1269 budget: the row must fit on one line (≈ 14 px text + 8 px
    // vertical padding ≈ 30 px) plus a small tolerance for subpixel
    // rounding and the progress bar that follows the pill on the same
    // flex row.
    expect(height, `badge rendered too tall (${height}px) — likely wrapped`).toBeLessThanOrEqual(32);
  });
});