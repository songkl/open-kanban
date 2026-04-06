import { Page, APIRequestContext } from '@playwright/test';

export async function login(page: Page, username: string, password?: string) {
  await page.goto('/');
  
  const usernameInput = page.getByPlaceholder(/nickname|username/i);
  await usernameInput.fill(username);
  
  if (password) {
    const passwordInput = page.getByPlaceholder(/password/i);
    await passwordInput.fill(password);
  }
  
  const loginButton = page.getByRole('button', { name: /start|login|sign in/i });
  await loginButton.click();
  
  await page.waitForURL(/\/board\/|\/setup/i, { timeout: 10000 });
}

export async function logout(page: Page) {
  await page.goto('/');
  const menuButton = page.locator('[aria-label*="menu" i], [data-testid="menu"]').first();
  if (await menuButton.isVisible({ timeout: 1000 }).catch(() => false)) {
    await menuButton.click();
    const logoutButton = page.getByRole('button', { name: /logout|sign out|log out/i });
    if (await logoutButton.isVisible({ timeout: 1000 }).catch(() => false)) {
      await logoutButton.click();
    }
  }
}

export async function createBoard(page: Page, name: string) {
  await page.goto('/boards');
  
  const createButton = page.getByRole('button', { name: /create|new board/i });
  await createButton.click();
  
  const nameInput = page.getByLabel(/board name/i);
  await nameInput.fill(name);
  
  const submitButton = page.getByRole('button', { name: /create|submit/i });
  await submitButton.click();
  
  await page.waitForURL(new RegExp(`/board/`), { timeout: 5000 });
}

export async function createColumn(page: Page, name: string) {
  const addColumnButton = page.getByRole('button', { name: /add column|new column/i });
  await addColumnButton.click();
  
  const nameInput = page.getByLabel(/column name/i);
  await nameInput.fill(name);
  
  const submitButton = page.getByRole('button', { name: /create|add|submit/i });
  await submitButton.click();
  
  await page.waitForSelector(`text=${name}`, { timeout: 5000 });
}

export async function createTask(page: Page, title: string, options?: { description?: string; columnId?: string }) {
  const addTaskButton = page.getByRole('button', { name: /add task|new task/i }).first();
  await addTaskButton.click();
  
  const titleInput = page.getByLabel(/task title|title/i);
  await titleInput.fill(title);
  
  if (options?.description) {
    const descInput = page.getByLabel(/description/i);
    await descInput.fill(options.description);
  }
  
  const submitButton = page.getByRole('button', { name: /create|add|submit/i });
  await submitButton.click();
  
  await page.waitForSelector(`text=${title}`, { timeout: 5000 });
}

export async function dragTask(page: Page, taskTitle: string, targetColumnName: string) {
  const task = page.locator(`[data-testid="task"], .task-item`).filter({ hasText: taskTitle }).first();
  const targetColumn = page.locator('.column, [data-testid="column"]').filter({ hasText: targetColumnName });
  
  await task.dragTo(targetColumn);
  await page.waitForTimeout(500);
}

export async function completeTask(page: Page, taskTitle: string) {
  const task = page.locator(`[data-testid="task"], .task-item`).filter({ hasText: taskTitle }).first();
  const completeButton = task.getByRole('button', { name: /complete|done|check/i });
  await completeButton.click();
  
  await page.waitForTimeout(500);
}

export async function selectTask(page: Page, taskTitle: string) {
  const task = page.locator(`[data-testid="task"], .task-item`).filter({ hasText: taskTitle }).first();
  await task.click();
}

export async function selectTasks(page: Page, taskTitles: string[]) {
  for (const title of taskTitles) {
    const task = page.locator(`[data-testid="task"], .task-item`).filter({ hasText: title }).first();
    await task.click({ modifiers: ['Meta', 'Ctrl'].includes(process.platform === 'darwin' ? 'Meta' : 'Control') ? 'Meta' : 'Control' });
  }
}

export async function waitForWebSocket(page: Page) {
  await page.waitForFunction(() => {
    return (window as any).__wsConnected === true || 
           document.querySelector('[data-ws-connected="true"]') !== null ||
           document.querySelector('.ws-connected') !== null;
  }, { timeout: 5000 }).catch(() => {});
}

export async function waitForNotification(page: Page, text: string) {
  await page.waitForSelector(`text=${text}`, { timeout: 5000 });
}