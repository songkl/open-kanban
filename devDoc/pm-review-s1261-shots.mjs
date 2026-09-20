// PM review s-1261 — Playwright walkthrough
// Runs against the freshly built dev server at http://localhost:8080
// using the devDoc/pm-review-s1261/kanban-test.db (admin / admin123).

import { chromium } from '/Users/kl/Documents/ai/kl-kanban/frontend/node_modules/playwright/index.mjs';
import fs from 'node:fs';

const ADMIN_TOKEN = process.argv[2];
if (!ADMIN_TOKEN) {
  console.error('Usage: node pm-review-s1261-shots.mjs <admin-token>');
  process.exit(1);
}
const BASE = 'http://localhost:8080';
const OUT = '/Users/kl/Documents/ai/kl-kanban/devDoc/pm-review-s1261-shots';

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

  // ===== Anonymous flow =====
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
  const adm404 = new Set();
  admPage.on('console', (msg) => { if (msg.type() === 'error') admConsole.push(`${msg.type()}: ${msg.text()}`); });
  admPage.on('pageerror', (err) => admConsole.push(`pageerror: ${err.message}`));
  admPage.on('requestfailed', (req) => admConsole.push(`request-failed: ${req.url()} ${req.failure()?.errorText}`));
  admPage.on('response', (resp) => {
    if (resp.status() >= 400) {
      adm404.add(`${resp.status()}  ${resp.url()}`);
    }
  });

  await loginAdmin(admPage);
  await admPage.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  await sleep(1500);
  await snap(admPage, '10-admin-home');

  await admPage.goto(`${BASE}/boards`, { waitUntil: 'networkidle' });
  await sleep(1000);
  await snap(admPage, '11-admin-boards-light');

  await admPage.evaluate(() => localStorage.setItem('darkMode', 'true'));
  await admPage.reload({ waitUntil: 'networkidle' });
  await sleep(1000);
  await snap(admPage, '12-admin-boards-dark');

  await admPage.evaluate(() => localStorage.setItem('darkMode', 'false'));
  await admPage.reload({ waitUntil: 'networkidle' });
  await sleep(1000);

  await admPage.goto(`${BASE}/board/ed9d3d12a0d309d94fd4a871ad1569d6`, { waitUntil: 'networkidle' });
  await sleep(2000);
  await snap(admPage, '13-admin-board-light');

  await admPage.evaluate(() => localStorage.setItem('darkMode', 'true'));
  await admPage.reload({ waitUntil: 'networkidle' });
  await sleep(2000);
  await snap(admPage, '14-admin-board-dark');

  await admPage.evaluate(() => localStorage.setItem('darkMode', 'false'));
  await admPage.goto(`${BASE}/drafts`, { waitUntil: 'networkidle' });
  await sleep(1000);
  await snap(admPage, '15-admin-drafts');

  await admPage.goto(`${BASE}/completed`, { waitUntil: 'networkidle' });
  await sleep(1000);
  await snap(admPage, '16-admin-completed');

  await admPage.goto(`${BASE}/history`, { waitUntil: 'networkidle' });
  await sleep(1000);
  await snap(admPage, '17-admin-history');

  await admPage.goto(`${BASE}/activities`, { waitUntil: 'networkidle' });
  await sleep(1500);
  await snap(admPage, '18-admin-activities');

  await admPage.goto(`${BASE}/agent-activity`, { waitUntil: 'networkidle' });
  await sleep(1000);
  await snap(admPage, '19-admin-agent-activity');

  await admPage.goto(`${BASE}/settings?tab=profile`, { waitUntil: 'networkidle' });
  await sleep(1000);
  await snap(admPage, '20-admin-settings-profile');

  await admPage.goto(`${BASE}/settings?tab=users`, { waitUntil: 'networkidle' });
  await sleep(1000);
  await snap(admPage, '21-admin-settings-users');

  await admPage.goto(`${BASE}/settings?tab=oauth`, { waitUntil: 'networkidle' });
  await sleep(1000);
  await snap(admPage, '22-admin-settings-oauth');

  await admPage.goto(`${BASE}/settings?tab=tokens`, { waitUntil: 'networkidle' });
  await sleep(1000);
  await snap(admPage, '23-admin-settings-tokens');

  await admPage.goto(`${BASE}/settings?tab=theme`, { waitUntil: 'networkidle' });
  await sleep(1000);
  await snap(admPage, '24-admin-settings-theme');

  await admPage.goto(`${BASE}/templates/marketplace`, { waitUntil: 'networkidle' });
  await sleep(1000);
  await snap(admPage, '25-admin-marketplace');

  await admPage.goto(`${BASE}/columns`, { waitUntil: 'networkidle' });
  await sleep(1000);
  await snap(admPage, '26-admin-columns');

  // Open task modal
  await admPage.goto(`${BASE}/board/ed9d3d12a0d309d94fd4a871ad1569d6`, { waitUntil: 'networkidle' });
  await sleep(2000);
  try {
    const loc = admPage.locator('div').filter({ hasText: /T-1007/ }).first();
    if (await loc.count() > 0) {
      await loc.click({ timeout: 3000 });
      await sleep(1500);
      await snap(admPage, '30-task-modal');
    }
  } catch (e) { console.log('  task modal:', e.message); }

  await admPage.keyboard.press('Escape');
  await sleep(500);

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
  fs.writeFileSync(`${OUT}/_admin_404.txt`, Array.from(adm404).sort().join('\n'));

  await browser.close();
  console.log('Done.');
}

main().catch(err => { console.error(err); process.exit(1); });