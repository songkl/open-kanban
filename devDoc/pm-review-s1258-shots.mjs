import { chromium } from '/Users/kl/Documents/ai/kl-kanban/frontend/node_modules/playwright/index.mjs';
import fs from 'node:fs';

const ADMIN_TOKEN = '3ed716f216d22a9d6b91aa546b087e40ed5f9f892895e8e1bbb0fa407205c321';
const BASE = 'http://localhost:8080';
const OUT = '/Users/kl/Documents/ai/kl-kanban/devDoc/pm-review-s1258-shots';

if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function loginAdmin(page) {
  await page.context().clearCookies();
  await page.context().addCookies([
    { name: 'kanban-token', value: ADMIN_TOKEN, domain: 'localhost', path: '/', httpOnly: false, secure: false, sameSite: 'Lax' },
  ]);
}

async function logout(page) {
  await page.context().clearCookies();
}

async function snap(page, name, fullPage = true) {
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage });
  console.log(`  📷 ${name}.png`);
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const findings = [];

  // ===== Anonymous (no auth) =====
  console.log('== Anonymous flow ==');
  const anon = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const anonPage = await anon.newPage();
  const anonConsole = [];
  anonPage.on('console', (msg) => { if (msg.type() === 'error') anonConsole.push(`${msg.type()}: ${msg.text()}`); });
  anonPage.on('pageerror', (err) => anonConsole.push(`pageerror: ${err.message}`));
  anonPage.on('requestfailed', (req) => anonConsole.push(`request-failed: ${req.url()} ${req.failure()?.errorText}`));

  await anonPage.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  await sleep(1000);
  await snap(anonPage, '01-anon-home');

  await anonPage.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await sleep(800);
  await snap(anonPage, '02-anon-login');

  await anonPage.goto(`${BASE}/templates/marketplace`, { waitUntil: 'networkidle' });
  await sleep(800);
  await snap(anonPage, '03-anon-marketplace');

  await anonPage.goto(`${BASE}/status`, { waitUntil: 'networkidle' });
  await sleep(800);
  await snap(anonPage, '04-anon-status');

  console.log(`  anon console errors: ${anonConsole.length}`);
  if (anonConsole.length) console.log('  ' + anonConsole.slice(0, 5).join('\n  '));

  // ===== Admin flow =====
  console.log('== Admin flow ==');
  const adm = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const admPage = await adm.newPage();
  const admConsole = [];
  admPage.on('console', (msg) => { if (msg.type() === 'error') admConsole.push(`${msg.type()}: ${msg.text()}`); });
  admPage.on('pageerror', (err) => admConsole.push(`pageerror: ${err.message}`));
  admPage.on('requestfailed', (req) => admConsole.push(`request-failed: ${req.url()} ${req.failure()?.errorText}`));

  await loginAdmin(admPage);
  await admPage.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  await sleep(1000);
  await snap(admPage, '10-admin-home');

  await admPage.goto(`${BASE}/boards`, { waitUntil: 'networkidle' });
  await sleep(1000);
  await snap(admPage, '11-admin-boards-light');

  // Dark mode boards
  await admPage.evaluate(() => localStorage.setItem('darkMode', 'true'));
  await admPage.reload({ waitUntil: 'networkidle' });
  await sleep(1000);
  await snap(admPage, '12-admin-boards-dark');

  // Back to light
  await admPage.evaluate(() => localStorage.setItem('darkMode', 'false'));
  await admPage.reload({ waitUntil: 'networkidle' });
  await sleep(1000);

  // Board page
  await admPage.goto(`${BASE}/board/ed9d3d12a0d309d94fd4a871ad1569d6`, { waitUntil: 'networkidle' });
  await sleep(1500);
  await snap(admPage, '13-admin-board-light');

  // Board dark
  await admPage.evaluate(() => localStorage.setItem('darkMode', 'true'));
  await admPage.reload({ waitUntil: 'networkidle' });
  await sleep(1500);
  await snap(admPage, '14-admin-board-dark');

  // Drafts page
  await admPage.evaluate(() => localStorage.setItem('darkMode', 'false'));
  await admPage.goto(`${BASE}/drafts`, { waitUntil: 'networkidle' });
  await sleep(1000);
  await snap(admPage, '15-admin-drafts');

  // Archived page
  await admPage.goto(`${BASE}/completed`, { waitUntil: 'networkidle' });
  await sleep(1000);
  await snap(admPage, '16-admin-completed');

  // History
  await admPage.goto(`${BASE}/history`, { waitUntil: 'networkidle' });
  await sleep(1000);
  await snap(admPage, '17-admin-history');

  // Activities
  await admPage.goto(`${BASE}/activities`, { waitUntil: 'networkidle' });
  await sleep(1000);
  await snap(admPage, '18-admin-activities');

  // Agent activity
  await admPage.goto(`${BASE}/agent-activity`, { waitUntil: 'networkidle' });
  await sleep(1000);
  await snap(admPage, '19-admin-agent-activity');

  // Settings profile
  await admPage.goto(`${BASE}/settings?tab=profile`, { waitUntil: 'networkidle' });
  await sleep(1000);
  await snap(admPage, '20-admin-settings-profile');

  // Settings users
  await admPage.goto(`${BASE}/settings?tab=users`, { waitUntil: 'networkidle' });
  await sleep(1000);
  await snap(admPage, '21-admin-settings-users');

  // Settings oauth
  await admPage.goto(`${BASE}/settings?tab=oauth`, { waitUntil: 'networkidle' });
  await sleep(1000);
  await snap(admPage, '22-admin-settings-oauth');

  // Settings tokens
  await admPage.goto(`${BASE}/settings?tab=tokens`, { waitUntil: 'networkidle' });
  await sleep(1000);
  await snap(admPage, '23-admin-settings-tokens');

  // Settings theme
  await admPage.goto(`${BASE}/settings?tab=theme`, { waitUntil: 'networkidle' });
  await sleep(1000);
  await snap(admPage, '24-admin-settings-theme');

  // Templates marketplace
  await admPage.goto(`${BASE}/templates/marketplace`, { waitUntil: 'networkidle' });
  await sleep(1000);
  await snap(admPage, '25-admin-marketplace');

  // Columns management
  await admPage.goto(`${BASE}/columns`, { waitUntil: 'networkidle' });
  await sleep(1000);
  await snap(admPage, '26-admin-columns');

  // Open task modal
  await admPage.goto(`${BASE}/board/ed9d3d12a0d309d94fd4a871ad1569d6`, { waitUntil: 'networkidle' });
  await sleep(2000);
  try {
    const loc = admPage.locator('div').filter({ hasText: /T-1002/ }).first();
    if (await loc.count() > 0) {
      await loc.click({ timeout: 3000 });
      await sleep(1500);
      await snap(admPage, '30-task-modal');
    }
  } catch (e) { console.log('  task modal:', e.message); }

  // Close modal
  await admPage.keyboard.press('Escape');
  await sleep(500);

  // Create board modal
  try {
    const btn = admPage.locator('button').filter({ hasText: /新建看板|创建.*看板/i }).first();
    if (await btn.count() > 0) {
      await btn.click({ timeout: 2000 });
      await sleep(1500);
      await snap(admPage, '31-create-board-modal');
      await admPage.keyboard.press('Escape');
    }
  } catch (e) {}

  // Mobile viewport
  await admPage.setViewportSize({ width: 375, height: 812 });
  await admPage.goto(`${BASE}/boards`, { waitUntil: 'networkidle' });
  await sleep(1000);
  await snap(admPage, '40-mobile-boards');

  await admPage.goto(`${BASE}/board/ed9d3d12a0d309d94fd4a871ad1569d6`, { waitUntil: 'networkidle' });
  await sleep(1500);
  await snap(admPage, '41-mobile-board');

  console.log(`\nAdmin console errors: ${admConsole.length}`);
  if (admConsole.length) {
    admConsole.slice(0, 15).forEach(m => console.log('  ' + m));
  }

  fs.writeFileSync(`${OUT}/_admin_console.json`, JSON.stringify(admConsole, null, 2));
  fs.writeFileSync(`${OUT}/_anon_console.json`, JSON.stringify(anonConsole, null, 2));
  fs.writeFileSync(`${OUT}/_findings.json`, JSON.stringify(findings, null, 2));

  await browser.close();
  console.log('Done.');
}

main().catch(err => { console.error(err); process.exit(1); });
