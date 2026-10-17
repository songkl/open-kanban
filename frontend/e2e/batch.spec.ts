import { test, expect } from '@playwright/test';
import {
  login,
  createBoard,
  createColumnViaApi,
  createTask,
  selectTaskForBatch,
  batchBar,
  taskCard,
  uniqueUser,
} from './helpers';

test.describe('Batch Operations', () => {
  test.beforeEach(async ({ page }) => {
    await login(page, uniqueUser('batchuser_'));
    await createBoard(page, `Batch Board ${Date.now()}`);
  });

  test('should select multiple tasks and show the count', async ({ page }) => {
    const task1 = `Batch Task 1 ${Date.now()}`;
    const task2 = `Batch Task 2 ${Date.now()}`;
    await createTask(page, task1);
    await createTask(page, task2);

    await selectTaskForBatch(page, task1);
    await selectTaskForBatch(page, task2);

    const bar = batchBar(page);
    await expect(bar).toBeVisible();
    await expect(bar).toContainText('2 selected');
  });

  test('should batch move selected tasks to another column', async ({ page }) => {
    const boardId = page.url().match(/\/board\/([^/?#]+)/)![1];
    const columnName = `Target ${Date.now()}`;
    await createColumnViaApi(page, boardId, columnName, 'qa_review');
    await page.reload();

    const task1 = `Move Task 1 ${Date.now()}`;
    const task2 = `Move Task 2 ${Date.now()}`;
    await createTask(page, task1);
    await createTask(page, task2);
    await selectTaskForBatch(page, task1);
    await selectTaskForBatch(page, task2);

    const bar = batchBar(page);
    await bar.getByRole('button', { name: 'Move to column...' }).click();
    await page.getByRole('option', { name: columnName, exact: true }).click();

    // Moving clears the selection, so the bar disappears and both cards
    // now live in the target column.
    await expect(bar).toBeHidden();
    const target = page
      .locator('div.relative.flex.flex-col.rounded-lg')
      .filter({ has: page.getByRole('heading', { name: columnName }) });
    await expect(target.getByRole('heading', { name: task1 })).toBeVisible();
    await expect(target.getByRole('heading', { name: task2 })).toBeVisible();
  });

  test('should batch delete selected tasks', async ({ page }) => {
    const task1 = `Delete Task 1 ${Date.now()}`;
    const task2 = `Delete Task 2 ${Date.now()}`;
    await createTask(page, task1);
    await createTask(page, task2);
    await selectTaskForBatch(page, task1);
    await selectTaskForBatch(page, task2);

    await batchBar(page).getByRole('button', { name: 'Delete', exact: true }).click();

    await expect(taskCard(page, task1)).toHaveCount(0);
    await expect(taskCard(page, task2)).toHaveCount(0);
  });

  test('should batch archive selected tasks', async ({ page }) => {
    const task1 = `Archive Task 1 ${Date.now()}`;
    const task2 = `Archive Task 2 ${Date.now()}`;
    await createTask(page, task1);
    await createTask(page, task2);
    await selectTaskForBatch(page, task1);
    await selectTaskForBatch(page, task2);

    await batchBar(page).getByRole('button', { name: 'Archive', exact: true }).click();

    await expect(taskCard(page, task1)).toHaveCount(0);
    await expect(taskCard(page, task2)).toHaveCount(0);
  });

  test('should batch update priority of selected tasks', async ({ page }) => {
    const task1 = `Priority Task ${Date.now()}`;
    await createTask(page, task1);
    await selectTaskForBatch(page, task1);

    const bar = batchBar(page);
    await bar.getByRole('button', { name: 'Set priority...' }).click();
    await page.getByRole('option', { name: 'High', exact: true }).click();

    await expect(taskCard(page, task1)).toContainText('High');
  });

  test('should clear the batch selection', async ({ page }) => {
    const task1 = `Cancel Task ${Date.now()}`;
    await createTask(page, task1);
    await selectTaskForBatch(page, task1);

    const bar = batchBar(page);
    await expect(bar).toBeVisible();
    await bar.getByRole('button', { name: 'Clear', exact: true }).click();

    await expect(bar).toBeHidden();
  });
});
