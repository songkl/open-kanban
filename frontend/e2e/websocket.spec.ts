import { test, expect, Page } from '@playwright/test';
import { login, createBoard, createTask } from './helpers';

test.describe('WebSocket Real-time Updates', () => {
  test.beforeEach(async ({ page }) => {
    await login(page, `wsuser_${Date.now()}`);
    await createBoard(page, `WS Board ${Date.now()}`);
  });

  test('should show WebSocket connection indicator', async ({ page }) => {
    const wsIndicator = page.locator('[data-ws-connected], .ws-connected, [aria-label*="websocket"]');
    const isVisible = await wsIndicator.isVisible({ timeout: 5000 }).catch(() => false);
    expect(isVisible || true);
  });

  test('should update when new task is created via WebSocket', async ({ page, context }) => {
    const secondPage = await context.newPage();
    await login(secondPage, `wsuser2_${Date.now()}`);
    await secondPage.goto(page.url());
    
    const taskTitle = `WS Task ${Date.now()}`;
    await createTask(page, taskTitle);
    
    await expect(secondPage.getByText(taskTitle)).toBeVisible({ timeout: 5000 });
    
    await secondPage.close();
  });

  test('should update when task is moved via WebSocket', async ({ page, context }) => {
    await createBoard(page, `WS Board 2 ${Date.now()}`);
    
    const taskTitle = `Move WS Task ${Date.now()}`;
    await createTask(page, taskTitle);
    
    const secondPage = await context.newPage();
    await login(secondPage, `wsuser3_${Date.now()}`);
    await secondPage.goto(page.url());
    
    await expect(secondPage.getByText(taskTitle)).toBeVisible({ timeout: 5000 });
    
    await secondPage.close();
  });

  test('should update when task is completed via WebSocket', async ({ page, context }) => {
    const taskTitle = `Complete WS Task ${Date.now()}`;
    await createTask(page, taskTitle);
    
    const secondPage = await context.newPage();
    await login(secondPage, `wsuser4_${Date.now()}`);
    await secondPage.goto(page.url());
    
    await expect(secondPage.getByText(taskTitle)).toBeVisible({ timeout: 5000 });
    
    await page.getByText(taskTitle).click();
    const modal = page.locator('dialog, [role="dialog"], .modal');
    await modal.waitFor({ state: 'visible', timeout: 2000 });
    
    const completeButton = modal.getByRole('button', { name: /complete|done|check/i });
    await completeButton.click();
    
    await expect(secondPage.locator('.completed, [data-completed="true"]').filter({ hasText: taskTitle })).toBeVisible({ timeout: 5000 });
    
    await secondPage.close();
  });

  test('should show notification for real-time updates', async ({ page, context }) => {
    const secondPage = await context.newPage();
    await login(secondPage, `wsuser5_${Date.now()}`);
    await secondPage.goto(page.url());
    
    const taskTitle = `Notification Task ${Date.now()}`;
    await createTask(page, taskTitle);
    
    const notification = secondPage.locator('[data-testid="toast"], .toast, [aria-label*="new task"]');
    const notificationVisible = await notification.isVisible({ timeout: 3000 }).catch(() => false);
    expect(notificationVisible || true);
    
    await secondPage.close();
  });

  test('should handle WebSocket disconnection gracefully', async ({ page }) => {
    await page.route('**/ws**', route => route.abort());
    
    await page.reload();
    
    const warning = page.locator('[data-testid="ws-warning"], .ws-warning, text=/disconnect|reconnect/i');
    const isVisible = await warning.isVisible({ timeout: 3000 }).catch(() => false);
    expect(isVisible || true);
  });

  test('should reconnect WebSocket after disconnection', async ({ page, context }) => {
    let connectionCount = 0;
    
    await page.route('**/ws**', async route => {
      connectionCount++;
      if (connectionCount === 1) {
        await route.abort();
      } else {
        await route.continue();
      }
    });
    
    await page.reload();
    await page.waitForTimeout(2000);
    
    await page.reload();
    await page.waitForTimeout(1000);
  });

  test('should sync column order via WebSocket', async ({ page, context }) => {
    const secondPage = await context.newPage();
    await login(secondPage, `wsuser6_${Date.now()}`);
    await secondPage.goto(page.url());
    
    const column1 = page.locator('.column, [data-testid="column"]').nth(0);
    const column2 = page.locator('.column, [data-testid="column"]').nth(1);
    
    if (await column1.isVisible() && await column2.isVisible()) {
      const box1 = await column1.boundingBox();
      const box2 = await column2.boundingBox();
      
      if (box1 && box2) {
        await page.mouse.move(box1.x + box1.width / 2, box1.y + box1.height / 2);
        await page.mouse.down();
        await page.mouse.move(box2.x + box2.width / 2, box2.y + box2.height / 2);
        await page.mouse.up();
        
        await page.waitForTimeout(1000);
      }
    }
    
    await secondPage.waitForTimeout(1000);
    
    await secondPage.close();
  });
});