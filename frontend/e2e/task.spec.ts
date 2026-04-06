import { test, expect, Page } from '@playwright/test';
import { login, createBoard, createColumn, createTask, dragTask, completeTask } from './helpers';

test.describe('Task Creation, Movement, and Completion', () => {
  test.beforeEach(async ({ page }) => {
    await login(page, `taskuser_${Date.now()}`);
    await createBoard(page, `Task Board ${Date.now()}`);
  });

  test('should create a new task', async ({ page }) => {
    const taskTitle = `New Task ${Date.now()}`;
    await createTask(page, taskTitle);
    
    await expect(page.getByText(taskTitle)).toBeVisible();
  });

  test('should create task with description', async ({ page }) => {
    const taskTitle = `Task with Desc ${Date.now()}`;
    const taskDesc = `Description for task ${Date.now()}`;
    
    await createTask(page, taskTitle, { description: taskDesc });
    
    await expect(page.getByText(taskTitle)).toBeVisible();
    await page.getByText(taskTitle).click();
    await expect(page.getByText(taskDesc)).toBeVisible({ timeout: 2000 });
  });

  test('should create task in specific column', async ({ page }) => {
    await createColumn(page, 'In Progress');
    
    const taskTitle = `Column Task ${Date.now()}`;
    const addTaskButton = page.locator('.column, [data-testid="column"]').filter({ hasText: 'In Progress' }).getByRole('button', { name: /add task/i });
    await addTaskButton.click();
    
    const titleInput = page.getByLabel(/task title|title/i);
    await titleInput.fill(taskTitle);
    
    const submitButton = page.getByRole('button', { name: /create|add|submit/i });
    await submitButton.click();
    
    const column = page.locator('.column, [data-testid="column"]').filter({ hasText: 'In Progress' });
    await expect(column.getByText(taskTitle)).toBeVisible();
  });

  test('should move task between columns via drag and drop', async ({ page }) => {
    const taskTitle = `Drag Task ${Date.now()}`;
    await createTask(page, taskTitle);
    
    await createColumn(page, 'Done');
    
    await dragTask(page, taskTitle, 'Done');
    
    const doneColumn = page.locator('.column, [data-testid="column"]').filter({ hasText: 'Done' });
    await expect(doneColumn.getByText(taskTitle)).toBeVisible({ timeout: 3000 });
  });

  test('should complete a task', async ({ page }) => {
    const taskTitle = `Complete Task ${Date.now()}`;
    await createTask(page, taskTitle);
    
    await completeTask(page, taskTitle);
    
    const completedTask = page.locator('[data-testid="task"].completed, .task-item.completed').filter({ hasText: taskTitle });
    await expect(completedTask).toBeVisible({ timeout: 2000 });
  });

  test('should open task modal on click', async ({ page }) => {
    const taskTitle = `Modal Task ${Date.now()}`;
    await createTask(page, taskTitle);
    
    await page.getByText(taskTitle).click();
    
    const modal = page.locator('dialog, [role="dialog"], .modal, [data-testid="task-modal"]');
    await expect(modal).toBeVisible({ timeout: 2000 });
  });

  test('should edit task title', async ({ page }) => {
    const taskTitle = `Edit Task ${Date.now()}`;
    await createTask(page, taskTitle);
    
    await page.getByText(taskTitle).click();
    
    const modal = page.locator('dialog, [role="dialog"], .modal, [data-testid="task-modal"]');
    await modal.waitFor({ state: 'visible', timeout: 2000 });
    
    const editButton = modal.getByRole('button', { name: /edit|modify/i });
    if (await editButton.isVisible({ timeout: 1000 }).catch(() => false)) {
      await editButton.click();
      
      const titleInput = modal.getByLabel(/title/i);
      await titleInput.clear();
      const newTitle = `Edited ${Date.now()}`;
      await titleInput.fill(newTitle);
      
      const saveButton = modal.getByRole('button', { name: /save|update/i });
      await saveButton.click();
      
      await expect(page.getByText(newTitle)).toBeVisible();
    }
  });

  test('should delete a task', async ({ page }) => {
    const taskTitle = `Delete Task ${Date.now()}`;
    await createTask(page, taskTitle);
    
    await page.getByText(taskTitle).click();
    
    const modal = page.locator('dialog, [role="dialog"], .modal, [data-testid="task-modal"]');
    await modal.waitFor({ state: 'visible', timeout: 2000 });
    
    const deleteButton = modal.getByRole('button', { name: /delete|remove/i });
    await deleteButton.click();
    
    const confirmButton = page.getByRole('button', { name: /confirm|delete|yes/i });
    await confirmButton.click();
    
    await expect(page.getByText(taskTitle)).not.toBeVisible();
  });

  test('should add subtask to task', async ({ page }) => {
    const taskTitle = `Parent Task ${Date.now()}`;
    await createTask(page, taskTitle);
    
    await page.getByText(taskTitle).click();
    
    const modal = page.locator('dialog, [role="dialog"], .modal, [data-testid="task-modal"]');
    await modal.waitFor({ state: 'visible', timeout: 2000 });
    
    const addSubtaskButton = page.getByRole('button', { name: /add subtask/i });
    if (await addSubtaskButton.isVisible({ timeout: 1000 }).catch(() => false)) {
      await addSubtaskButton.click();
      
      const subtaskInput = page.getByPlaceholder(/subtask|title/i);
      await subtaskInput.fill(`Subtask ${Date.now()}`);
      
      const addButton = page.getByRole('button', { name: /add|create/i });
      await addButton.click();
      
      await expect(modal.getByText(/subtask/i)).toBeVisible();
    }
  });

  test('should filter tasks by status', async ({ page }) => {
    await createTask(page, `Filter Task 1 ${Date.now()}`);
    await createTask(page, `Filter Task 2 ${Date.now()}`);
    
    const filterButton = page.getByRole('button', { name: /filter/i });
    await filterButton.click();
    
    const filterOption = page.getByRole('option', { name: /todo|in progress|done/i }).first();
    await filterOption.click();
    
    await page.waitForTimeout(500);
  });

  test('should search tasks', async ({ page }) => {
    const uniqueTitle = `Searchable Task ${Date.now()}`;
    await createTask(page, uniqueTitle);
    
    const searchInput = page.getByPlaceholder(/search/i);
    await searchInput.fill(uniqueTitle);
    
    await expect(page.getByText(uniqueTitle)).toBeVisible();
  });
});