import { Page, expect } from '@playwright/test';

// The SPA's English copy (seeded via the `language=en` storageState in
// playwright.config.ts). Keep the visible strings here so the specs
// stay close to what a user actually sees.
const UI = {
  usernamePlaceholder: 'Enter your nickname',
  passwordPlaceholder: 'Set password (optional)',
  signInButton: /sign in|get started/i,
  newBoardButton: 'New Board',
  boardNamePlaceholder: 'Enter board name',
  createButton: 'Create',
  createTaskButton: 'Create',
  addTaskDialog: 'Add Task',
  taskTitlePlaceholder: 'Enter task title',
  addButton: 'Add',
  moreActions: 'More actions',
  moveToColumn: 'Move to column',
  deleteTask: 'Delete task',
  editTask: 'Edit Task',
  saveButton: 'Save',
  confirmButton: 'Confirm',
  addSubtask: 'Add Subtask',
  subtaskTitlePlaceholder: 'Enter subtask title',
  searchPlaceholder: 'Search tasks...',
} as const;

// The login input caps nicknames at 20 characters (LoginPage maxLength),
// so a `prefix + Date.now()` name is silently truncated and different
// tests can collide on the same truncated value. Keep the whole thing
// short and append a random suffix to guarantee uniqueness.
export function uniqueUser(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}${rand}`.slice(0, 20);
}

export async function login(page: Page, username: string, password?: string) {
  await page.goto('/');

  await page.getByPlaceholder(UI.usernamePlaceholder).fill(username);
  if (password) {
    await page.getByPlaceholder(UI.passwordPlaceholder).fill(password);
  }

  await page.getByRole('button', { name: UI.signInButton }).click();

  // A successful login lands on the first accessible board; the SPA
  // only leaves /login once boardsApi.getAll() returns something, which
  // is why global-setup guarantees at least one public board.
  await page.waitForURL(/\/board\//, { timeout: 15_000 });
}

export async function logout(page: Page) {
  // The account menu lives in the header; its trigger is the avatar
  // button with no accessible name, so reach it through the menu text.
  const menuTrigger = page.locator('header button').filter({ has: page.locator('img, svg') }).last();
  if (await menuTrigger.isVisible({ timeout: 1000 }).catch(() => false)) {
    await menuTrigger.click();
    const logoutButton = page.getByRole('button', { name: /logout/i });
    if (await logoutButton.isVisible({ timeout: 1000 }).catch(() => false)) {
      await logoutButton.click();
    }
  }
}

export async function createBoard(page: Page, name: string): Promise<string> {
  await page.goto('/boards');

  await page.getByRole('button', { name: UI.newBoardButton }).first().click();
  await page.getByPlaceholder(UI.boardNamePlaceholder).fill(name);
  await page.getByRole('button', { name: UI.createButton, exact: true }).click();

  // Boards are created without navigating away; the new card shows up
  // in the list, and its "Enter" button opens the board.
  const card = boardCard(page, name);
  await expect(card).toBeVisible({ timeout: 10_000 });
  await card.getByRole('button', { name: 'Enter', exact: true }).click();
  await page.waitForURL(/\/board\/[^/]+$/);

  return boardIdFromUrl(page);
}

export function boardCard(page: Page, name: string) {
  return page
    .locator('div.group.rounded-2xl')
    .filter({ has: page.getByRole('heading', { name, exact: true }) });
}

export function boardIdFromUrl(page: Page): string {
  const match = page.url().match(/\/board\/([^/?#]+)/);
  if (!match) throw new Error(`not on a board page: ${page.url()}`);
  return match[1];
}

// Columns are created through the API rather than the Columns page:
// the board view has no add-column affordance, and the fixture only
// needs the column to exist so the interaction under test has a target.
export async function createColumnViaApi(
  page: Page,
  boardId: string,
  name: string,
  status = 'in_progress',
): Promise<string> {
  const res = await page.request.post('/api/v1/columns', {
    data: { boardId, name, status },
  });
  if (!res.ok()) {
    throw new Error(`createColumnViaApi failed: ${res.status()} ${await res.text()}`);
  }
  const column = (await res.json()) as { id: string };
  return column.id;
}

export async function createTask(
  page: Page,
  title: string,
  options?: { description?: string },
) {
  await page.getByRole('button', { name: UI.createTaskButton, exact: true }).first().click();

  const dialog = page.getByRole('dialog', { name: UI.addTaskDialog });
  await expect(dialog).toBeVisible();

  await dialog.getByPlaceholder(UI.taskTitlePlaceholder).fill(title);
  if (options?.description) {
    await dialog.getByLabel('Description').fill(options.description);
  }

  // The dialog can grow taller than the viewport (no internal scroll),
  // which pushes the footer Add button off-screen. The title field is
  // inside the form, so Enter submits it just like clicking Add.
  await dialog.getByPlaceholder(UI.taskTitlePlaceholder).press('Enter');
  await expect(dialog).toBeHidden();
  await expect(taskCard(page, title)).toBeVisible({ timeout: 10_000 });
}

export function taskCard(page: Page, title: string) {
  return page.locator('div.group.rounded-xl').filter({ has: page.getByRole('heading', { name: title, exact: true }) });
}

// The column root is only identifiable by the testid on its header menu
// button, so filter the column container by that anchor.
export function columnContainer(page: Page, columnId: string) {
  return page
    .locator('div.relative.flex.flex-col.rounded-lg')
    .filter({ has: page.getByTestId(`column-menu-button-${columnId}`) });
}

export async function moveTaskToColumn(page: Page, title: string, columnName: string) {
  await taskCard(page, title).getByTitle(UI.moreActions).click();
  await page.getByRole('button', { name: UI.moveToColumn, exact: true }).click();
  await page.getByRole('button', { name: columnName, exact: true }).click();
}

export async function deleteTask(page: Page, title: string) {
  await taskCard(page, title).getByTitle(UI.moreActions).click();
  await page.getByRole('button', { name: UI.deleteTask, exact: true }).click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: UI.confirmButton, exact: true }).click();
}

export async function openTask(page: Page, title: string) {
  await taskCard(page, title).getByRole('heading', { name: title, exact: true }).click();
  // In edit mode the modal drops its aria-labelledby target (the title
  // <h2> is replaced by an input), so return a name-agnostic locator.
  const dialog = page.locator('[role="dialog"]');
  await expect(dialog).toBeVisible();
  return dialog;
}

export async function selectTaskForBatch(page: Page, title: string) {
  // Modifier-clicking the card toggles its selection (TaskCard's
  // handleCardClick). Clicking the hover-only checkbox would instead
  // bubble to the card's onClick and open the task modal.
  const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
  await taskCard(page, title).click({ modifiers: [modifier] });
}

export function batchBar(page: Page) {
  return page.locator('div.fixed.bottom-6');
}

export async function waitForNotification(page: Page, text: string) {
  await page.getByText(text).first().waitFor({ state: 'visible', timeout: 8000 });
}
