import { test, expect } from '@playwright/test';
import {
  login,
  createBoard,
  createColumnViaApi,
  createTask,
  openTask,
  taskCard,
  columnContainer,
  moveTaskToColumn,
  deleteTask,
  uniqueUser,
} from './helpers';

test.describe('Task Creation, Movement, and Completion', () => {
  test.beforeEach(async ({ page }) => {
    await login(page, uniqueUser('taskuser_'));
    await createBoard(page, `Task Board ${Date.now()}`);
  });

  test('should create a new task', async ({ page }) => {
    const taskTitle = `New Task ${Date.now()}`;
    await createTask(page, taskTitle);

    await expect(taskCard(page, taskTitle)).toBeVisible();
  });

  test('should create task with description', async ({ page }) => {
    const taskTitle = `Task with Desc ${Date.now()}`;
    const taskDesc = `Description for task ${Date.now()}`;

    await createTask(page, taskTitle, { description: taskDesc });

    const dialog = await openTask(page, taskTitle);
    await expect(dialog.getByText(taskDesc)).toBeVisible();
  });

  test('should create task in a specific column', async ({ page }) => {
    const boardId = page.url().match(/\/board\/([^/?#]+)/)![1];
    const columnName = `QA Review ${Date.now()}`;
    const columnId = await createColumnViaApi(page, boardId, columnName, 'qa_review');

    await page.reload();
    const column = columnContainer(page, columnId);
    await expect(column.getByText(columnName)).toBeVisible();

    // The empty column shows a "Click to add new task" affordance which
    // opens the Add Task dialog with this column preselected.
    await column.getByText('Click to add new task').click();
    const dialog = page.getByRole('dialog', { name: 'Add Task' });
    const columnTaskTitle = `Column Task ${Date.now()}`;
    await dialog.getByPlaceholder('Enter task title').fill(columnTaskTitle);
    await dialog.getByPlaceholder('Enter task title').press('Enter');

    await expect(column.getByRole('heading', { name: columnTaskTitle })).toBeVisible();
  });

  test('should move a task to another column', async ({ page }) => {
    const boardId = page.url().match(/\/board\/([^/?#]+)/)![1];
    const columnName = `Done ${Date.now()}`;
    const columnId = await createColumnViaApi(page, boardId, columnName, 'qa_review');

    const taskTitle = `Move Task ${Date.now()}`;
    await createTask(page, taskTitle);

    await moveTaskToColumn(page, taskTitle, columnName);

    const column = columnContainer(page, columnId);
    await expect(column.getByRole('heading', { name: taskTitle })).toBeVisible();
  });

  test('should delete a task', async ({ page }) => {
    const taskTitle = `Delete Task ${Date.now()}`;
    await createTask(page, taskTitle);

    await deleteTask(page, taskTitle);

    await expect(taskCard(page, taskTitle)).toHaveCount(0);
  });

  test('should open the task modal on click', async ({ page }) => {
    const taskTitle = `Modal Task ${Date.now()}`;
    await createTask(page, taskTitle);

    const dialog = await openTask(page, taskTitle);
    await expect(dialog).toBeVisible();
  });

  test('should edit a task title', async ({ page }) => {
    const taskTitle = `Edit Task ${Date.now()}`;
    await createTask(page, taskTitle);

    const dialog = await openTask(page, taskTitle);
    await dialog.getByRole('button', { name: 'Edit Task', exact: true }).click();

    const newTitle = `Edited ${Date.now()}`;
    const titleInput = dialog.getByLabel('Task title');
    await titleInput.fill(newTitle);
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();

    await expect(page.getByRole('heading', { name: newTitle }).first()).toBeVisible();
    await expect(taskCard(page, taskTitle)).toHaveCount(0);
  });

  test('should add a subtask to a task', async ({ page }) => {
    const taskTitle = `Parent Task ${Date.now()}`;
    await createTask(page, taskTitle);

    const dialog = await openTask(page, taskTitle);
    await dialog.getByRole('button', { name: 'Edit Task', exact: true }).click();

    const subtaskTitle = `Subtask ${Date.now()}`;
    await dialog.getByRole('button', { name: /Add Subtask/ }).click();

    const subDialog = page.getByRole('dialog', { name: 'Add Subtask' });
    await subDialog.getByPlaceholder('Enter subtask title').fill(subtaskTitle);
    await subDialog.getByRole('button', { name: 'Add Subtask', exact: true }).click();

    await expect(dialog.getByText(subtaskTitle)).toBeVisible();
  });

  test('should search tasks', async ({ page }) => {
    const uniqueTitle = `Searchable ${Date.now()}`;
    await createTask(page, uniqueTitle);

    await page.getByPlaceholder('Search tasks...').first().fill(uniqueTitle);

    await expect(taskCard(page, uniqueTitle)).toBeVisible();
  });
});
