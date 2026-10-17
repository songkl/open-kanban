import { test, expect } from '@playwright/test';
import { login, createBoard, boardCard, uniqueUser } from './helpers';

test.describe('Board Creation and Configuration', () => {
  test.beforeEach(async ({ page }) => {
    await login(page, uniqueUser('boarduser_'));
  });

  test('should display boards list page', async ({ page }) => {
    await page.goto('/boards');

    await expect(page.getByRole('heading', { name: /board management/i })).toBeVisible();
  });

  test('should create a new board', async ({ page }) => {
    const boardName = `Test Board ${Date.now()}`;

    await page.goto('/boards');
    await page.getByRole('button', { name: 'New Board' }).first().click();

    await expect(page.getByRole('heading', { name: 'New Board' })).toBeVisible();
    await page.getByPlaceholder('Enter board name').fill(boardName);
    await page.getByRole('button', { name: 'Create', exact: true }).click();

    await expect(boardCard(page, boardName)).toBeVisible();
  });

  test('should navigate to an existing board', async ({ page }) => {
    const boardName = `Existing Board ${Date.now()}`;
    await createBoard(page, boardName);

    await page.goto('/boards');
    await boardCard(page, boardName).getByRole('button', { name: 'Enter', exact: true }).click();

    await expect(page).toHaveURL(/\/board\/.+/);
  });

  test('should delete a board', async ({ page }) => {
    const boardName = `Board to Delete ${Date.now()}`;
    await createBoard(page, boardName);

    await page.goto('/boards');
    const card = boardCard(page, boardName);
    // The delete button's accessible name resolves from a missing i18n
    // key, so target it by its distinctive red styling instead.
    await card.locator('button.bg-red-50').click();

    const confirm = page.getByRole('alertdialog');
    await confirm.getByRole('button', { name: 'Confirm', exact: true }).click();

    await expect(card).toHaveCount(0);
  });

  test('should update board name', async ({ page }) => {
    const boardName = `Original Name ${Date.now()}`;
    const newName = `Updated Name ${Date.now()}`;
    await createBoard(page, boardName);

    await page.goto('/boards');
    await boardCard(page, boardName).getByRole('button', { name: 'Edit', exact: true }).click();

    await expect(page.getByRole('heading', { name: 'Edit Board' })).toBeVisible();
    const nameInput = page.getByPlaceholder('Enter board name');
    await nameInput.fill(newName);
    await page.getByRole('button', { name: 'Save', exact: true }).click();

    await expect(boardCard(page, newName)).toBeVisible();
  });
});
