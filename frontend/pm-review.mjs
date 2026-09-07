import { chromium } from 'playwright';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import path from 'path';

const SCREENSHOT_DIR = '/Users/kl/Documents/ai/kl-kanban/.opencode/pm-review-shots';
if (!existsSync(SCREENSHOT_DIR)) mkdirSync(SCREENSHOT_DIR, { recursive: true });

const BASE_URL = 'http://localhost:5173';
const findings = [];

async function snap(page, name) {
  const file = path.join(SCREENSHOT_DIR, `${name}.png`);
  try { await page.screenshot({ path: file, fullPage: true }); console.log(`[SNAP] ${name}`); }
  catch (e) { console.log(`[ERR] ${name}: ${e.message}`); }
}

async function logConsole(page) {
  page.on('console', msg => {
    if (msg.type() === 'error') findings.push({ type: 'console-error', text: msg.text() });
  });
  page.on('pageerror', err => findings.push({ type: 'page-error', text: err.message }));
  page.on('requestfailed', req => findings.push({ type: 'request-failed', url: req.url(), text: req.failure()?.errorText }));
}

async function captureView(page, urlPath, name, opts = {}) {
  const url = `${BASE_URL}${urlPath}`;
  console.log(`\n[VISIT] ${name}: ${url}`);
  try {
    const resp = await page.goto(url, { waitUntil: 'networkidle', timeout: 15000 });
    console.log(`  status=${resp ? resp.status() : 'no-resp'} finalUrl=${page.url()}`);
    await page.waitForTimeout(opts.wait || 1500);
    await snap(page, name);

    const h1 = await page.locator('h1').first().textContent().catch(() => null);
    const bodyText = (await page.locator('body').textContent().catch(() => '') || '').slice(0, 600);
    console.log(`  h1="${h1}"`);
    console.log(`  body="${bodyText.replace(/\s+/g,' ').trim()}"`);
  } catch (e) {
    console.log(`  [ERR] ${e.message}`);
    findings.push({ page: name, type: 'navigation', text: e.message });
  }
}

(async () => {
  const browser = await chromium.launch({
    headless: true,
    executablePath: '/Users/kl/Library/Caches/ms-playwright/chromium-1217/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'
  });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await logConsole(page);

  // Login (use a fresh user that doesn't have password set)
  console.log('\n[LOGIN]');
  await page.goto(`${BASE_URL}/login`);
  await page.waitForTimeout(2500);  // Wait for requirePassword check
  await snap(page, '02-login');

  // Try PM_Reviewer (a new user) so we don't trigger requirePassword
  const username = 'PMReviewer';
  await page.fill('input[type="text"]', username);
  await page.click('button[type="submit"]');
  await page.waitForTimeout(4000);
  await snap(page, '00-after-login');
  console.log(`  url=${page.url()}`);

  if (!page.url().includes('/board') && !page.url().includes('/boards')) {
    console.log('  Login may have failed, retrying with OpenClow password empty');
    await page.fill('input[type="text"]', '');
    await page.fill('input[type="text"]', 'OpenClow');
    await page.waitForTimeout(1000);
    // If password field is shown, leave it blank (this user had no pw originally)
    const pwd = await page.locator('input[type="password"]').count();
    console.log(`  pwd field count=${pwd}`);
    await page.click('button[type="submit"]');
    await page.waitForTimeout(4000);
    await snap(page, '00-after-login');
    console.log(`  retry url=${page.url()}`);
  }

  // Authenticated pages
  await captureView(page, '/boards', '04-boards');
  await captureView(page, '/board/sys', '05-board-sys');
  await captureView(page, '/columns', '06-columns');
  await captureView(page, '/columns/dai-sys', '07-column-detail');
  await captureView(page, '/drafts', '08-drafts');
  await captureView(page, '/completed', '09-completed');
  await captureView(page, '/activity', '10-activity-log');
  await captureView(page, '/agents', '11-agent-activity');
  await captureView(page, '/history', '12-history');
  await captureView(page, '/settings', '13-settings');
  await captureView(page, '/oauth-device', '14-oauth-device');
  await captureView(page, '/users/test', '15-user-detail');

  // Open TaskDetail modal
  console.log('\n[TASK MODAL]');
  await page.goto(`${BASE_URL}/board/sys`);
  await page.waitForTimeout(3000);
  await snap(page, '18a-board-with-task');
  // Try clicking a task card
  const candidates = ['.task-card', '[class*="task"]', 'div[role="button"]'];
  for (const sel of candidates) {
    try {
      const loc = page.locator(sel).filter({ hasText: /T-|#/ }).first();
      if (await loc.count() > 0) {
        await loc.click({ timeout: 3000 });
        await page.waitForTimeout(2000);
        await snap(page, '18-task-modal');
        break;
      }
    } catch (e) {}
  }

  // Settings tabs
  console.log('\n[SETTINGS TABS]');
  await page.goto(`${BASE_URL}/settings`);
  await page.waitForTimeout(2500);
  await snap(page, '13a-settings-profile');
  for (const tab of ['键盘快捷键', 'OAuth 2.1', '主题']) {
    try {
      await page.locator('button').filter({ hasText: new RegExp(tab) }).first().click({ timeout: 2000 });
      await page.waitForTimeout(1200);
      await snap(page, `13b-settings-${tab.replace(/[^\w]/g,'')}`);
    } catch (e) {}
  }

  // Create board modal
  console.log('\n[CREATE BOARD MODAL]');
  await page.goto(`${BASE_URL}/boards`);
  await page.waitForTimeout(2500);
  try {
    await page.locator('button').filter({ hasText: /新建看板/i }).first().click({ timeout: 2000 });
    await page.waitForTimeout(1500);
    await snap(page, '21-create-board-modal');
  } catch (e) {}

  // Add task modal
  console.log('\n[ADD TASK MODAL]');
  await page.goto(`${BASE_URL}/board/sys`);
  await page.waitForTimeout(3000);
  try {
    await page.locator('button').filter({ hasText: /新建任务|创建.*任务|添加任务/i }).first().click({ timeout: 2000 });
    await page.waitForTimeout(1500);
    await snap(page, '20-add-task-modal');
  } catch (e) {
    try {
      // Click "添加新任务" placeholder
      await page.locator('text=/添加新任务/i').first().click({ timeout: 2000 });
      await page.waitForTimeout(1500);
      await snap(page, '20-add-task-modal');
    } catch (e2) {}
  }

  // Boards page - try the 编辑/复制 actions
  console.log('\n[BOARDS MENU]');
  await page.goto(`${BASE_URL}/boards`);
  await page.waitForTimeout(2500);
  await snap(page, '04b-boards-fresh');

  // Mobile
  await page.setViewportSize({ width: 375, height: 812 });
  await captureView(page, '/board/sys', '17-mobile-board');
  await captureView(page, '/boards', '16-mobile-boards');

  // Dark mode
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ colorScheme: 'dark' });
  await captureView(page, '/boards', '22-dark-boards');
  await captureView(page, '/board/sys', '23-dark-board');
  await captureView(page, '/settings', '24-dark-settings');

  writeFileSync(path.join(SCREENSHOT_DIR, 'findings.json'), JSON.stringify(findings, null, 2));
  console.log(`\nTotal findings: ${findings.length}`);
  await browser.close();
})();
