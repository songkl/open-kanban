import { test, expect } from '@playwright/test';

test.describe('User Login Flow', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('should display login page', async ({ page }) => {
    await expect(page.getByRole('heading', { name: /open kanban/i })).toBeVisible();
    await expect(page.getByPlaceholder(/nickname|username/i)).toBeVisible();
    await expect(page.getByRole('button', { name: /start|login/i })).toBeVisible();
  });

  test('should show error when submitting empty username', async ({ page }) => {
    const loginButton = page.getByRole('button', { name: /start|login/i });
    await loginButton.click();
    
    await expect(page.getByText(/enter nickname|username required/i)).toBeVisible();
  });

  test('should login successfully with valid username', async ({ page }) => {
    const username = `testuser_${Date.now()}`;
    await page.getByPlaceholder(/nickname|username/i).fill(username);
    
    const loginButton = page.getByRole('button', { name: /start|login/i });
    await loginButton.click();
    
    await page.waitForURL(/\/board\/|\/setup/i, { timeout: 10000 });
  });

  test('should navigate to setup page when setup is required', async ({ page }) => {
    await page.route('/api/v1/auth/me', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ needsSetup: true }),
      });
    });

    await page.getByPlaceholder(/nickname|username/i).fill('newuser');
    await page.getByRole('button', { name: /start|login/i }).click();
    
    await expect(page).toHaveURL(/\/setup/i);
  });

  test('should show password field when password is required', async ({ page }) => {
    await page.route('/api/v1/auth/me', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ requirePassword: true }),
      });
    });

    await expect(page.getByPlaceholder(/password/i)).toBeVisible();
  });

  test('should login with password when required', async ({ page }) => {
    const username = `testuser_${Date.now()}`;
    
    await page.route('/api/v1/auth/me', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ requirePassword: true }),
      });
    });

    await page.route('/api/v1/auth/login', async (route) => {
      const body = JSON.parse(route.request().postData() || '{}');
      if (body.username === username && body.password) {
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

    await page.getByPlaceholder(/nickname|username/i).fill(username);
    await page.getByPlaceholder(/password/i).fill('testpassword');
    await page.getByRole('button', { name: /start|login/i }).click();
    
    await page.waitForURL(/\/board\/|\/setup/i, { timeout: 10000 });
  });

  test('should show error for invalid login', async ({ page }) => {
    await page.route('/api/v1/auth/login', async (route) => {
      await route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Invalid credentials' }),
      });
    });

    await page.getByPlaceholder(/nickname|username/i).fill('invaliduser');
    await page.getByRole('button', { name: /start|login/i }).click();
    
    await expect(page.getByText(/invalid|failed|error/i)).toBeVisible();
  });
});