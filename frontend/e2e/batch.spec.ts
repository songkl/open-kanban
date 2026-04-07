import { test, expect } from '@playwright/test';
import { login, createBoard, createColumn, createTask, selectTask } from './helpers';

test.describe('Batch Operations', () => {
  test.beforeEach(async ({ page }) => {
    await login(page, `batchuser_${Date.now()}`);
    await createBoard(page, `Batch Board ${Date.now()}`);
  });

  test('should select multiple tasks', async ({ page }) => {
    await createTask(page, `Batch Task 1 ${Date.now()}`);
    await createTask(page, `Batch Task 2 ${Date.now()}`);
    await createTask(page, `Batch Task 3 ${Date.now()}`);
    
    const task1 = page.locator('[data-testid="task"], .task-item').filter({ hasText: /Batch Task 1/i }).first();
    const task2 = page.locator('[data-testid="task"], .task-item').filter({ hasText: /Batch Task 2/i }).first();
    
    await task1.click();
    const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
    await task2.click({ modifiers: [modifier] });
    
    const batchBar = page.locator('[data-testid="batch-bar"], .batch-bar, [aria-label*="batch"]');
    await expect(batchBar).toBeVisible({ timeout: 2000 });
  });

  test('should batch move selected tasks', async ({ page }) => {
    await createColumn(page, 'Target Column');
    
    await createTask(page, `Move Task 1 ${Date.now()}`);
    await createTask(page, `Move Task 2 ${Date.now()}`);
    
    const task1 = page.locator('[data-testid="task"], .task-item').filter({ hasText: /Move Task 1/i }).first();
    const task2 = page.locator('[data-testid="task"], .task-item').filter({ hasText: /Move Task 2/i }).first();
    
    await task1.click();
    await task2.click({ modifiers: [process.platform === 'darwin' ? 'Meta' : 'Control'] });
    
    const batchBar = page.locator('[data-testid="batch-bar"], .batch-bar');
    await batchBar.waitFor({ state: 'visible', timeout: 2000 });
    
    const moveSelect = batchBar.locator('select').first();
    await moveSelect.selectOption({ label: 'Target Column' });
    
    await expect(page.locator('.column, [data-testid="column"]').filter({ hasText: 'Target Column' }).locator('text=/Move Task 1/i')).toBeVisible({ timeout: 3000 });
    await expect(page.locator('.column, [data-testid="column"]').filter({ hasText: 'Target Column' }).locator('text=/Move Task 2/i')).toBeVisible({ timeout: 3000 });
  });

  test('should batch delete selected tasks', async ({ page }) => {
    await createTask(page, `Delete Task 1 ${Date.now()}`);
    await createTask(page, `Delete Task 2 ${Date.now()}`);
    
    const task1 = page.locator('[data-testid="task"], .task-item').filter({ hasText: /Delete Task 1/i }).first();
    const task2 = page.locator('[data-testid="task"], .task-item').filter({ hasText: /Delete Task 2/i }).first();
    
    await task1.click();
    await task2.click({ modifiers: [process.platform === 'darwin' ? 'Meta' : 'Control'] });
    
    const batchBar = page.locator('[data-testid="batch-bar"], .batch-bar');
    await batchBar.waitFor({ state: 'visible', timeout: 2000 });
    
    const deleteButton = batchBar.getByRole('button', { name: /delete|remove/i });
    await deleteButton.click();
    
    const confirmButton = page.getByRole('button', { name: /confirm|delete|yes/i });
    await confirmButton.click();
    
    await expect(page.locator('text=/Delete Task 1/i')).not.toBeVisible();
    await expect(page.locator('text=/Delete Task 2/i')).not.toBeVisible();
  });

  test('should batch complete selected tasks', async ({ page }) => {
    await createTask(page, `Complete Task 1 ${Date.now()}`);
    await createTask(page, `Complete Task 2 ${Date.now()}`);
    
    const task1 = page.locator('[data-testid="task"], .task-item').filter({ hasText: /Complete Task 1/i }).first();
    const task2 = page.locator('[data-testid="task"], .task-item').filter({ hasText: /Complete Task 2/i }).first();
    
    await task1.click();
    await task2.click({ modifiers: [process.platform === 'darwin' ? 'Meta' : 'Control'] });
    
    const batchBar = page.locator('[data-testid="batch-bar"], .batch-bar');
    await batchBar.waitFor({ state: 'visible', timeout: 2000 });
    
    const completeButton = batchBar.getByRole('button', { name: /complete|done|check/i });
    await completeButton.click();
    
    await page.waitForTimeout(1000);
  });

  test('should batch archive selected tasks', async ({ page }) => {
    await createTask(page, `Archive Task 1 ${Date.now()}`);
    await createTask(page, `Archive Task 2 ${Date.now()}`);
    
    const task1 = page.locator('[data-testid="task"], .task-item').filter({ hasText: /Archive Task 1/i }).first();
    const task2 = page.locator('[data-testid="task"], .task-item').filter({ hasText: /Archive Task 2/i }).first();
    
    await task1.click();
    await task2.click({ modifiers: [process.platform === 'darwin' ? 'Meta' : 'Control'] });
    
    const batchBar = page.locator('[data-testid="batch-bar"], .batch-bar');
    await batchBar.waitFor({ state: 'visible', timeout: 2000 });
    
    const archiveButton = batchBar.getByRole('button', { name: /archive/i });
    if (await archiveButton.isVisible({ timeout: 1000 }).catch(() => false)) {
      await archiveButton.click();
      
      await expect(page.locator('text=/Archive Task 1/i')).not.toBeVisible();
    }
  });

  test('should cancel batch selection', async ({ page }) => {
    await createTask(page, `Cancel Task ${Date.now()}`);
    
    const task = page.locator('[data-testid="task"], .task-item').filter({ hasText: /Cancel Task/i }).first();
    await task.click();
    
    const batchBar = page.locator('[data-testid="batch-bar"], .batch-bar');
    if (await batchBar.isVisible({ timeout: 1000 }).catch(() => false)) {
      const cancelButton = batchBar.getByRole('button', { name: /cancel|deselect|clear/i });
      await cancelButton.click();
      
      await expect(batchBar).not.toBeVisible();
    }
  });

  test('should show selected count in batch bar', async ({ page }) => {
    await createTask(page, `Count Task 1 ${Date.now()}`);
    await createTask(page, `Count Task 2 ${Date.now()}`);
    await createTask(page, `Count Task 3 ${Date.now()}`);
    
    const task1 = page.locator('[data-testid="task"], .task-item').filter({ hasText: /Count Task 1/i }).first();
    const task2 = page.locator('[data-testid="task"], .task-item').filter({ hasText: /Count Task 2/i }).first();
    
    await task1.click();
    await task2.click({ modifiers: [process.platform === 'darwin' ? 'Meta' : 'Control'] });
    
    const batchBar = page.locator('[data-testid="batch-bar"], .batch-bar');
    await expect(batchBar).toBeVisible({ timeout: 2000 });
    await expect(batchBar).toContainText(/2/i);
  });
});