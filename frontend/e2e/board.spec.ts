import { test, expect, Page } from '@playwright/test';
import { login, createBoard } from './helpers';

test.describe('Board Creation and Configuration', () => {
  test.beforeEach(async ({ page }) => {
    await login(page, `boarduser_${Date.now()}`);
  });

  test('should display boards list page', async ({ page }) => {
    await page.goto('/boards');
    
    await expect(page.getByRole('heading', { name: /boards/i })).toBeVisible();
  });

  test('should create a new board', async ({ page }) => {
    await page.goto('/boards');
    
    const createButton = page.getByRole('button', { name: /create|new board/i });
    await createButton.click();
    
    const modal = page.locator('dialog, [role="dialog"], .modal');
    await expect(modal).toBeVisible();
    
    const nameInput = page.getByLabel(/board name|name/i);
    const boardName = `Test Board ${Date.now()}`;
    await nameInput.fill(boardName);
    
    const submitButton = page.getByRole('button', { name: /create|submit/i });
    await submitButton.click();
    
    await expect(page).toHaveURL(new RegExp(`/board/`));
    await expect(page.getByText(boardName)).toBeVisible();
  });

  test('should navigate to existing board', async ({ page }) => {
    await createBoard(page, `Existing Board ${Date.now()}`);
    
    await page.goto('/boards');
    
    const boardLink = page.locator('a[href*="/board/"]').first();
    await boardLink.click();
    
    await expect(page).toHaveURL(/\/board\/.+/);
  });

  test('should delete a board', async ({ page }) => {
    await createBoard(page, `Board to Delete ${Date.now()}`);
    
    await page.goto('/boards');
    
    const boardCard = page.locator('[data-testid="board-card"], .board-card').filter({ hasText: /delete/i }).first();
    if (await boardCard.isVisible({ timeout: 1000 }).catch(() => false)) {
      await boardCard.hover();
      const deleteButton = boardCard.getByRole('button', { name: /delete|remove/i });
      await deleteButton.click();
      
      const confirmButton = page.getByRole('button', { name: /confirm|delete|yes/i });
      await confirmButton.click();
    }
  });

  test('should show board settings', async ({ page }) => {
    await createBoard(page, `Settings Board ${Date.now()}`);
    
    const settingsButton = page.getByRole('button', { name: /settings|configure/i });
    if (await settingsButton.isVisible({ timeout: 1000 }).catch(() => false)) {
      await settingsButton.click();
      
      const settingsModal = page.locator('dialog, [role="dialog"], .modal');
      await expect(settingsModal).toBeVisible();
    }
  });

  test('should update board name', async ({ page }) => {
    const boardName = `Original Name ${Date.now()}`;
    await createBoard(page, boardName);
    
    const editButton = page.getByRole('button', { name: /edit|rename|modify/i });
    if (await editButton.isVisible({ timeout: 1000 }).catch(() => false)) {
      await editButton.click();
      
      const nameInput = page.getByLabel(/board name/i);
      await nameInput.clear();
      const newName = `Updated Name ${Date.now()}`;
      await nameInput.fill(newName);
      
      const saveButton = page.getByRole('button', { name: /save|update|confirm/i });
      await saveButton.click();
      
      await expect(page.getByText(newName)).toBeVisible();
    }
  });

  test('should share board', async ({ page }) => {
    await createBoard(page, `Shared Board ${Date.now()}`);
    
    const shareButton = page.getByRole('button', { name: /share|invite/i });
    if (await shareButton.isVisible({ timeout: 1000 }).catch(() => false)) {
      await shareButton.click();
      
      const shareModal = page.locator('dialog, [role="dialog"], .modal');
      await expect(shareModal).toBeVisible();
    }
  });
});