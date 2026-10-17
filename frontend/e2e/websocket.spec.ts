import { test, expect } from '@playwright/test';
import {
  login,
  createBoard,
  createColumnViaApi,
  createTask,
  moveTaskToColumn,
  deleteTask,
  taskCard,
  uniqueUser,
} from './helpers';

// The board view keeps every open tab in sync over the WebSocket
// `refresh` broadcast, so a second tab on the same board is the
// cleanest way to observe real-time updates. Tabs share the context's
// cookies (same session) and localStorage (language=en storageState).
test.describe('WebSocket Real-time Updates', () => {
  test('should connect without showing the reconnect warning', async ({ page }) => {
    await login(page, uniqueUser('wsuser_'));
    await createBoard(page, `WS Board ${Date.now()}`);

    // Once the socket is open WsWarning renders nothing; the warning is
    // only present while disconnected/failed.
    await expect(page.getByText('Connection lost')).toBeHidden({ timeout: 15_000 });
  });

  test('should show tasks created in another tab', async ({ page, context }) => {
    await login(page, uniqueUser('wsuser_'));
    await createBoard(page, `WS Board ${Date.now()}`);
    const boardUrl = page.url();

    const secondPage = await context.newPage();
    await secondPage.goto(boardUrl);
    await expect(secondPage.getByRole('button', { name: 'Create', exact: true })).toBeVisible();

    const taskTitle = `WS Task ${Date.now()}`;
    await createTask(page, taskTitle);

    await expect(taskCard(secondPage, taskTitle)).toBeVisible({ timeout: 15_000 });
  });

  test('should reflect tasks moved in another tab', async ({ page, context }) => {
    await login(page, uniqueUser('wsuser_'));
    await createBoard(page, `WS Board ${Date.now()}`);
    const boardId = page.url().match(/\/board\/([^/?#]+)/)![1];
    const columnName = `Live ${Date.now()}`;
    const columnId = await createColumnViaApi(page, boardId, columnName, 'qa_review');
    await page.reload();

    const taskTitle = `Move WS Task ${Date.now()}`;
    await createTask(page, taskTitle);

    const secondPage = await context.newPage();
    await secondPage.goto(page.url());
    const target = secondPage
      .locator('div.relative.flex.flex-col.rounded-lg')
      .filter({ has: secondPage.getByTestId(`column-menu-button-${columnId}`) });
    await expect(target).toBeVisible();

    await moveTaskToColumn(page, taskTitle, columnName);

    await expect(target.getByRole('heading', { name: taskTitle })).toBeVisible({ timeout: 15_000 });
  });

  test('should remove tasks deleted in another tab', async ({ page, context }) => {
    await login(page, uniqueUser('wsuser_'));
    await createBoard(page, `WS Board ${Date.now()}`);
    const taskTitle = `Delete WS Task ${Date.now()}`;
    await createTask(page, taskTitle);

    const secondPage = await context.newPage();
    await secondPage.goto(page.url());
    await expect(taskCard(secondPage, taskTitle)).toBeVisible();

    await deleteTask(page, taskTitle);

    await expect(taskCard(secondPage, taskTitle)).toHaveCount(0, { timeout: 15_000 });
  });

  test('should warn and recover when the socket drops', async ({ page }) => {
    // Fail every upgrade until we explicitly allow it. Dev mode mounts
    // the board (and thus opens sockets) more than once, so closing only
    // the first connection would recover before the warning is asserted.
    let allowConnection = false;
    await page.routeWebSocket('**/ws', (ws) => {
      if (allowConnection) {
        ws.connectToServer();
      } else {
        ws.close();
      }
    });

    await login(page, uniqueUser('wsuser_'));
    await createBoard(page, `WS Board ${Date.now()}`);

    // The warning surfaces with a manual retry affordance.
    const retry = page.getByRole('button', { name: 'Retry now' });
    await expect(retry).toBeVisible({ timeout: 10_000 });

    // Let the handshake through and retry; the warning clears on connect.
    allowConnection = true;
    await retry.click();
    await expect(retry).toBeHidden({ timeout: 15_000 });
  });
});
