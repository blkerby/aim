import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './e2e', workers: 1, timeout: 45000,
  use: { baseURL: 'http://127.0.0.1:43802', viewport: { width: 1440, height: 1000 },
    launchOptions: { executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome' },
    screenshot: 'only-on-failure', trace: 'retain-on-failure' },
  webServer: { command: `${process.env.AIM_VIEWER_PYTHON || 'python'} tests/fixture_server.py`,
    url: 'http://127.0.0.1:43802/api/runs', reuseExistingServer: false },
});
