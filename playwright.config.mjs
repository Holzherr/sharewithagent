import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests',
  testMatch: '**/*.spec.mjs',
  // The screenshot walkthrough is a design-review tool, not a test — run it
  // explicitly with: npx playwright test screenshots
  testIgnore: '**/screenshots.spec.mjs',
  timeout: 30000,
  use: { headless: true },
  reporter: 'list',
});
