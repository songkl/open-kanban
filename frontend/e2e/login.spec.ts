import { test, expect } from '@playwright/test';

const usernameInput = (page: import('@playwright/test').Page) =>
  page.getByPlaceholder(/enter your nickname/i);
const submitButton = (page: import('@playwright/test').Page) =>
  page.getByRole('button', { name: /sign in|get started/i });

test.describe('User Login Flow', () => {
  test('should display login page', async ({ page }) => {
    await page.goto('/');

    await expect(page.getByRole('heading', { name: /open kanban/i })).toBeVisible();
    await expect(usernameInput(page)).toBeVisible();
    await expect(submitButton(page)).toBeVisible();
  });

  test('should keep submit disabled until a nickname is entered', async ({ page }) => {
    await page.goto('/');

    await expect(submitButton(page)).toBeDisabled();
    await usernameInput(page).fill('someone');
    await expect(submitButton(page)).toBeEnabled();
  });

  test('should login successfully with valid username', async ({ page }) => {
    const username = `testuser_${Date.now()}`;

    await page.goto('/');
    await usernameInput(page).fill(username);
    await submitButton(page).click();

    await page.waitForURL(/\/board\//, { timeout: 15_000 });
  });

  test('should navigate to setup page when setup is required', async ({ page }) => {
    await page.route('**/api/v1/auth/me', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ needsSetup: true }),
      });
    });

    await page.goto('/');

    await expect(page).toHaveURL(/\/setup/i);
  });

  test('should show password field when password is required', async ({ page }) => {
    await page.route('**/api/v1/auth/me', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ needsSetup: false, requirePassword: true }),
      });
    });

    await page.goto('/');

    await expect(page.getByPlaceholder(/set password/i)).toBeVisible();
  });

  test('should login with password when required', async ({ page }) => {
    await page.route('**/api/v1/auth/me', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ needsSetup: false, requirePassword: true }),
      });
    });
    await page.route('**/api/v1/auth/login', async (route) => {
      const body = JSON.parse(route.request().postData() || '{}');
      if (body.username && body.password) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ success: true }),
        });
      } else {
        await route.fulfill({
          status: 401,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'Invalid credentials' }),
        });
      }
    });

    await page.goto('/');
    await usernameInput(page).fill(`testuser_${Date.now()}`);
    await page.getByPlaceholder(/set password/i).fill('testpassword');
    await submitButton(page).click();

    await page.waitForURL(/\/board\//, { timeout: 15_000 });
  });

  test('should show error for invalid login', async ({ page }) => {
    await page.route('**/api/v1/auth/login', async (route) => {
      await route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Invalid credentials' }),
      });
    });

    await page.goto('/');
    await usernameInput(page).fill('invaliduser');
    await submitButton(page).click();

    await expect(page.getByRole('alert')).toContainText(/invalid|failed|error/i);
  });
});
