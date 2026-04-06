import { chromium, FullConfig } from '@playwright/test';

async function globalSetup(config: FullConfig) {
  const browser = await chromium.launch();
  const storageState = process.env.PLAYWRIGHT_STORAGE_STATE
    ? { path: process.env.PLAYWRIGHT_STORAGE_STATE }
    : undefined;
  
  if (storageState) {
    const context = await browser.newContext({
      storageState: storageState.path as string,
    });
    const page = await context.newPage();
    
    await page.goto('/');
    await context.close();
  }
  
  await browser.close();
}

export default globalSetup;