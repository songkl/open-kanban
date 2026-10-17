import { test, expect } from '@playwright/test';
import { login, createBoard, createTask, uniqueUser } from './helpers';

// s-1269: TaskRunIndicator's full mode used to wrap the status pill
// ("● 上次运行 · 已 · · 运行器: mi… 16 完成 秒") onto two lines on the
// admin board. This regression test asserts the status row fits on a
// single line on the canonical 1440x900 desktop viewport.
//
// Flow:
//   1. Login + create board + create task via the existing UI helpers
//      (so the user owns the board as admin).
//   2. Use the browser context's authenticated `page.request` to call
//      POST /api/v1/runs/claim against the freshly created task. The
//      helper logs in through the UI so the kanban-token cookie is
//      already attached to every request issued from this context.
//   3. Reload the board so the live `task_runs` row is reflected on
//      the task card, then measure the rendered widget.
//
// Regression guard: this also covers the frontend bug where
// `runsApi.getByTask` short-circuited on a readable `kanban-token`
// cookie — but that cookie is HttpOnly, so the board's run polling
// never fired and the indicator never appeared.

test.describe('TaskRunIndicator (s-1269)', () => {
  test('full-mode badge stays on a single line on 1440x900', async ({ page }) => {
    test.setTimeout(60_000);
    await page.setViewportSize({ width: 1440, height: 900 });

    const user = uniqueUser('runind');
    await login(page, user);
    await createBoard(page, `Run Indicator Board ${Date.now()}`);

    const taskTitle = `Run Indicator Task ${Date.now()}`;
    await createTask(page, taskTitle);

    // The UI flow above creates the task in the board's "Todo" column
    // and the creator is the board admin (can claim from any column
    // they can write to). Look up the task id via the kanban API so
    // the claim call below can target it directly. The auth cookie is
    // already attached to page.request via the context.
    const boardId = page.url().match(/\/board\/([^/?#]+)/)![1];
    const tasks = await page.request.get(`/api/v1/tasks?boardId=${boardId}&status=todo`);
    expect(tasks.ok()).toBeTruthy();
    const { data: taskList } = (await tasks.json()) as {
      data: Array<{ id: string; title: string }>;
    };
    const target = taskList.find((t) => t.title === taskTitle);
    expect(target, `expected to find created task "${taskTitle}"`).toBeTruthy();

    const claim = await page.request.post('/api/v1/runs/claim', {
      data: {
        boardId,
        status: 'todo',
        agentType: 'opencoder',
        runnerId: 'mac-66681-regression-runner',
      },
    });
    expect(claim.ok(), `claim failed: ${claim.status()} ${await claim.text()}`).toBeTruthy();
    if (claim.status() !== 200) {
      throw new Error(`claim returned ${claim.status()} (expected 200 with a run row)`);
    }
    const directRun = await page.request.get(`/api/v1/runs/${encodeURIComponent(target!.id)}`);
    const directBody = (await directRun.json()) as { run: unknown; hasRun: boolean };
    expect(directBody.hasRun, `run row missing for ${target!.id}: ${JSON.stringify(directBody)}`).toBe(true);

    // Reload so the board picks up the freshly claimed row.
    await page.reload();
    await expect(page.getByText(taskTitle)).toBeVisible();
    const badge = page.getByTestId('task-run-indicator').first();
    await expect(badge).toBeVisible({ timeout: 15000 });

    // The full-mode widget is a two-row block (status row + progress
    // bar). s-1269 was about the *status row* wrapping its pill text
    // ("● Claimed · 🤖 runner · 5s") onto a second line on a 1440px
    // board. Measure the inner flex row (first child) — a single line
    // of text-xs (16px line-height) plus the h-3.5 spinner is ≤ 20px,
    // while a wrapped row balloons past 30px.
    const statusRow = badge.locator(':scope > div').first();
    const rowHeight = await statusRow.evaluate((el) => (el as HTMLElement).getBoundingClientRect().height);
    expect(rowHeight, `status row wrapped onto a second line (${rowHeight}px)`).toBeLessThanOrEqual(24);

    // The progress bar must stay a sibling row below (not push the
    // status row), so the whole widget is a stable two-row block.
    const blockHeight = await badge.evaluate((el) => (el as HTMLElement).getBoundingClientRect().height);
    expect(blockHeight, `full-mode widget too tall (${blockHeight}px)`).toBeLessThanOrEqual(64);
  });
});