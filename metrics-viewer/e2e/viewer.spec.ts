import { expect, test, type Page } from '@playwright/test';

async function select(page: Page, metrics = ['metric_00']) {
  await page.getByRole('textbox', { name: 'Search runs' }).fill('Run 000');
  await page.getByRole('checkbox', { name: /^Run 000/ }).check();
  for (const metric of metrics) {
    await page.getByRole('textbox', { name: 'Search metrics' }).fill(metric);
    await page.getByRole('checkbox', { name: new RegExp(`^${metric}$`) }).check();
  }
  await expect(page.locator('.chart-card').first().locator('.endpoint-marker')).toHaveCount(1);
}
async function zoom(page: Page, name: string, from: number, to: number) {
  const canvas = page.locator(`[data-metric="${name}"] canvas`);
  const rect = (await canvas.boundingBox())!;
  const left = rect.x + 64, width = rect.width - 80;
  await page.mouse.move(left + from * width, rect.y + 80);
  await page.mouse.down();
  await page.mouse.move(left + to * width, rect.y + 80, { steps: 8 });
  await page.mouse.up();
}
test.beforeEach(async ({ page, request }) => {
  await request.post('/test/reset');
  await page.goto('/');
});

test('selects runs/metrics, switches log scale, persists choices, and renders sparse/dense/mixed charts', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await select(page, ['metric_00','metric_01','metric_02']);
  const chart = page.locator('[data-metric="metric_00"]');
  await chart.getByRole('button', { name: 'Log', exact:true }).click();
  await expect(chart.getByRole('button', { name:'Log', exact:true })).toHaveAttribute('aria-pressed','true');
  await expect(chart.locator('.endpoint-marker')).toHaveCount(1);
  await page.reload();
  await expect(page.locator('.chart-card')).toHaveCount(3);
  await expect(chart.getByRole('button', { name:'Log', exact:true })).toHaveAttribute('aria-pressed','true');
  await expect(chart.locator('.endpoint-marker')).toHaveCount(1);
  await page.screenshot({ path:'test-results/viewer-fixture.png', fullPage:true });
  expect(errors).toEqual([]);
});

test('automatically expands the right edge but preserves the left edge', async ({ page, request }) => {
  await select(page);
  await zoom(page, 'metric_00', .5, 1);
  const canvas = page.locator('[data-metric="metric_00"] canvas');
  await expect(canvas).toHaveAttribute('aria-label', /step 100 to 200/);
  await expect(page.locator('.endpoint-marker')).toHaveCount(1);
  await request.post('/test/advance');
  await expect(canvas).toHaveAttribute('aria-label', /step 100 to 215/, { timeout:12000 });
});

test('historical zoom remains fixed across refresh, and reset resumes following', async ({ page, request }) => {
  await select(page);
  await zoom(page, 'metric_00', .25, .75);
  const canvas = page.locator('[data-metric="metric_00"] canvas');
  await expect(canvas).toHaveAttribute('aria-label', /step 50 to 150/);
  await request.post('/test/advance');
  await page.getByRole('button', { name:'Refresh now' }).click();
  await expect(page.locator('.endpoint-marker')).toHaveCount(0);
  await expect(canvas).toHaveAttribute('aria-label', /step 50 to 150/);
  await page.getByRole('button', { name:'Reset zoom for metric_00' }).click();
  await expect(canvas).toHaveAttribute('aria-label', /step 0 to 215/);
});

test('links x ranges, keeps scales independent, and preserves range after unlinking', async ({ page }) => {
  await select(page, ['metric_00','metric_01']);
  await zoom(page, 'metric_00', .25, .75);
  await expect(page.locator('[data-metric="metric_01"] canvas')).toHaveAttribute('aria-label', /step 0 to 200/);
  await page.getByRole('checkbox', { name:'Link x-axes' }).check();
  await expect(page.locator('[data-metric="metric_01"] canvas')).toHaveAttribute('aria-label', /step 50 to 150/);
  await page.locator('[data-metric="metric_01"]').getByRole('button', { name:'Log', exact:true }).click();
  await expect(page.locator('[data-metric="metric_00"]').getByRole('button', { name:'Lin', exact:true })).toHaveAttribute('aria-pressed','true');
  await page.getByRole('checkbox', { name:'Link x-axes' }).uncheck();
  await expect(page.locator('[data-metric="metric_01"] canvas')).toHaveAttribute('aria-label', /step 50 to 150/);
});

test('virtualizes charts, pauses/resumes refresh, and retains good data after failures', async ({ page, request }) => {
  await select(page);
  await page.getByRole('textbox', { name:'Search metrics' }).fill('');
  await page.locator('.metrics-selector').getByRole('button', { name:'Select filtered' }).click();
  await expect(page.locator('.toolbar h2')).toContainText('60 charts');
  expect(await page.locator('.chart-card').count()).toBeLessThan(12);
  await page.locator('.chart-scroll').evaluate(el => { el.scrollTop = el.scrollHeight; });
  await expect(page.locator('[data-metric="metric_59"]')).toBeVisible();
  expect(await page.locator('.chart-card').count()).toBeLessThan(12);
  await page.locator('.chart-scroll').evaluate(el => { el.scrollTop = 0; });
  await expect(page.locator('[data-metric="metric_00"] .endpoint-marker')).toHaveCount(1);
  await page.getByRole('button', { name:'Ⅱ Pause' }).click();
  await request.post('/test/advance');
  await page.waitForTimeout(5500);
  await expect(page.locator('[data-metric="metric_00"] canvas')).toHaveAttribute('aria-label', /step 0 to 200/);
  await page.getByRole('button', { name:'▶ Resume' }).click();
  await expect(page.locator('[data-metric="metric_00"] canvas')).toHaveAttribute('aria-label', /step 0 to 215/);
  await expect(page.locator('[data-metric="metric_00"] .endpoint-marker')).toHaveCount(1);
  await request.post('/test/fail');
  await page.getByRole('button', { name:'Refresh now' }).click();
  await expect(page.locator('[data-metric="metric_00"] .chart-error')).toContainText('retaining previous data');
  await expect(page.locator('[data-metric="metric_00"] .endpoint-marker')).toHaveCount(1);
});


test('compact layout marks true endpoints and only animates active runs', async ({ page }) => {
  await select(page);
  await page.getByRole('textbox', { name: 'Search runs' }).fill('Run 001');
  await page.getByRole('checkbox', { name: /^Run 001/ }).check();
  const chart = page.locator('[data-metric="metric_00"]');
  await expect(chart.locator('.endpoint-marker')).toHaveCount(2);
  const active = chart.getByRole('img', { name: 'Run 000, latest step 200, active', exact: true });
  const finished = chart.getByRole('img', { name: 'Run 001, latest step 200', exact: true });
  await expect(active).toHaveCSS('animation-name', 'endpoint-pulse');
  await expect(finished).toHaveCSS('animation-name', 'none');
  const initialTransform = await active.evaluate(el => getComputedStyle(el).transform);
  await expect.poll(() => active.evaluate(el => getComputedStyle(el).transform)).not.toBe(initialTransform);
  expect(await page.locator('.workspace').evaluate(el => el.getBoundingClientRect().top)).toBe(0);
  expect((await chart.locator('canvas').boundingBox())!.height).toBeGreaterThan(290);
  await expect(page.locator('.topbar, .sidebar-intro, .sidebar-foot, .statusbar, .chart-footer')).toHaveCount(0);
  await expect(page.getByText(/Per-pixel min|default context|Following latest|Historical range|Catalog checked/)).toHaveCount(0);
  await zoom(page, 'metric_00', .25, .75);
  await expect(chart.locator('.endpoint-marker')).toHaveCount(0);
  await chart.getByRole('button', { name: 'Reset zoom for metric_00' }).click();
  await expect(chart.locator('.endpoint-marker')).toHaveCount(2);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(active).toHaveCSS('animation-name', 'endpoint-pulse');
  const reducedTransform = await active.evaluate(el => getComputedStyle(el).transform);
  await expect.poll(() => active.evaluate(el => getComputedStyle(el).transform)).not.toBe(reducedTransform);
  await expect(finished).toHaveCSS('animation-name', 'none');
});

test('collapses the sidebar and persists one-to-five-column layouts', async ({ page }) => {
  await select(page, ['metric_00', 'metric_01', 'metric_02', 'metric_03', 'metric_04', 'metric_05']);
  const columns = page.getByRole('combobox', { name: 'Charts per row' });
  for (const count of [1, 2, 3, 4, 5]) {
    await columns.selectOption(String(count));
    await expect(page.locator('.chart-row').first().locator('.chart-card')).toHaveCount(count);
    await expect(page.locator('[data-metric="metric_00"]')).toHaveAttribute('aria-busy', 'false');
  }
  const chart = page.locator('[data-metric="metric_00"]');
  await chart.getByRole('button', { name: 'Log', exact: true }).click();
  await zoom(page, 'metric_00', .25, .75);
  const before = (await chart.boundingBox())!.width;
  await page.getByRole('button', { name: 'Collapse side panel' }).click();
  await expect(page.getByRole('textbox', { name: 'Search runs' })).toBeHidden();
  await expect(page.getByRole('button', { name: 'Expand side panel' })).toHaveAttribute('aria-expanded', 'false');
  await expect.poll(async () => (await chart.boundingBox())!.width).toBeGreaterThan(before);
  await expect(chart.locator('canvas')).toHaveAttribute('aria-label', /step 50 to 150/);
  await expect(chart.getByRole('button', { name: 'Log', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.reload();
  await expect(columns).toHaveValue('5');
  await expect(page.getByRole('button', { name: 'Expand side panel' })).toHaveAttribute('aria-expanded', 'false');
  await expect(chart.locator('.endpoint-marker')).toHaveCount(1);
  await page.screenshot({ path: 'test-results/viewer-five-columns.png', fullPage: true });
  await page.getByRole('button', { name: 'Expand side panel' }).click();
  await expect(page.getByRole('checkbox', { name: /^Run 000/ })).toBeChecked();
  await page.getByRole('textbox', { name: 'Search metrics' }).fill('');
  await page.locator('.metrics-selector').getByRole('button', { name: 'Select filtered' }).click();
  await page.locator('.chart-scroll').evaluate(el => { el.scrollTop = el.scrollHeight; });
  await expect(page.locator('[data-metric="metric_59"]')).toBeVisible();
  expect(await page.locator('.chart-card').count()).toBeLessThan(30);
  await columns.selectOption('1');
  await expect(chart).toBeVisible();
  await expect(page.locator('.chart-row').first().locator('.chart-card')).toHaveCount(1);
});

test('keeps complete charts and axes still while a growing-range refresh loads or fails', async ({ page, request }) => {
  await select(page, ['metric_00', 'metric_01']);
  await page.getByRole('textbox', { name: 'Search runs' }).fill('Run 001');
  await page.getByRole('checkbox', { name: /^Run 001/ }).check();
  const charts = page.locator('.chart-card');
  await expect(page.locator('.endpoint-marker')).toHaveCount(4);
  await expect(page.locator('.chart-card[aria-busy=true]')).toHaveCount(0);
  await page.getByRole('button', { name: 'Ⅱ Pause' }).click();
  const capture = () => charts.locator('canvas').evaluateAll(nodes => nodes.map(node => ({
    pixels: (node as HTMLCanvasElement).toDataURL(), label: node.getAttribute('aria-label'),
  })));
  const before = await capture();
  await request.post('/test/hold');
  try {
    await request.post('/test/advance');
    await page.getByRole('button', { name: 'Refresh now' }).click();
    await expect(page.locator('.chart-card[aria-busy=true]')).toHaveCount(2);
    // Each frame must keep the old chart, not just restore it after the request.
    for (let i = 0; i < 12; i++) {
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
      expect(await capture()).toEqual(before);
      await expect(page.locator('.endpoint-marker')).toHaveCount(4);
      await expect(page.locator('.plot-empty')).toHaveCount(0);
    }
  } finally { await request.post('/test/release'); }
  await expect(charts.first().locator('canvas')).toHaveAttribute('aria-label', /step 0 to 215/);
  await expect(charts.last().locator('canvas')).toHaveAttribute('aria-label', /step 0 to 215/);
  await expect(page.locator('.chart-card[aria-busy=true]')).toHaveCount(0);
  const refreshed = await capture();
  expect(refreshed).not.toEqual(before);
  await expect(page.locator('.endpoint-marker')).toHaveCount(4);
  await request.post('/test/advance');
  await request.post('/test/fail');
  await page.getByRole('button', { name: 'Refresh now' }).click();
  await expect(page.locator('.chart-error')).toHaveCount(2);
  await expect(page.locator('.chart-card[aria-busy=true]')).toHaveCount(0);
  expect(await capture()).toEqual(refreshed);
});

test('picks local summaries with dashed guides and values entirely in axis margins', async ({ page }) => {
  await select(page, ['metric_00', 'metric_01']);
  await page.getByRole('button', { name: 'Ⅱ Pause' }).click();
  await expect(page.locator('.chart-card[aria-busy=true]')).toHaveCount(0);
  const requests: string[] = [];
  page.on('request', request => requests.push(request.url()));
  // Picking still works offline, using only the summaries already displayed.
  await page.context().setOffline(true);
  for (const name of ['metric_01', 'metric_00']) {
    const chart = page.locator(`[data-metric="${name}"]`);
    const rect = (await chart.locator('canvas').boundingBox())!;
    const before = await chart.locator('canvas').evaluate(node => (node as HTMLCanvasElement).toDataURL());
    await page.mouse.move(rect.x + 64 + (rect.width - 80) * .4, rect.y + 12 + (rect.height - 42) * .5);
    await expect(chart.locator('.hover-point')).toBeVisible();
    await expect(chart.locator('.chart-tooltip')).toHaveCount(0);
    const step = Number((await chart.locator('.hover-x').getAttribute('aria-label'))!.replace('X value: ', ''));
    const value = Number((await chart.locator('.hover-y').getAttribute('aria-label'))!.replace('Y value: ', ''));
    const rawStep = Number((await chart.locator('.hover-guides').getAttribute('aria-label'))!.match(/: step ([^,]+), value/)![1]);
    expect(step).toBe(Math.round(rawStep));
    await expect(chart.locator('.hover-x')).toHaveText(/^-?[\d,]+$/);
    if (name === 'metric_01') {
      expect(rawStep * 14 / 200).toBeCloseTo(Math.round(rawStep * 14 / 200), 7);
      expect(value).toBeCloseTo(Math.exp(-rawStep / 100) * (1 + .3 * Math.sin(rawStep * 2)), 10);
      await expect(chart.locator('.hover-x')).not.toContainText('≈');
    }
    const xBox = (await chart.locator('.hover-x').boundingBox())!;
    const yBox = (await chart.locator('.hover-y').boundingBox())!;
    expect(xBox.y).toBeGreaterThanOrEqual(rect.y + rect.height - 30);
    expect(xBox.y + xBox.height).toBeLessThanOrEqual(rect.y + rect.height);
    expect(yBox.x + yBox.width).toBeLessThanOrEqual(rect.x + 64);
    await expect(chart.locator('.hover-guide-x')).toHaveAttribute('y2', String(rect.height - 30));
    await expect(chart.locator('.hover-guide-y')).toHaveAttribute('x1', '64');
    await expect(chart.locator('.hover-guides g')).toHaveAttribute('stroke-dasharray', '4 3');
    expect(await chart.locator('canvas').evaluate(node => (node as HTMLCanvasElement).toDataURL())).toBe(before);
    if (name === 'metric_00') await page.screenshot({path:'test-results/viewer-hover.png',fullPage:true});
    await page.mouse.move(10, 10);
    await expect(chart.locator('.hover-point, .hover-axis-label')).toHaveCount(0);
  }
  expect(requests).toEqual([]);
  await page.context().setOffline(false);
});

test('picks log-scale samples and clears the highlight during zoom and on leaving', async ({ page }) => {
  await select(page, ['metric_01']);
  await page.getByRole('button', { name: 'Ⅱ Pause' }).click();
  const chart = page.locator('[data-metric="metric_01"]');
  await chart.getByRole('button', { name: 'Log', exact: true }).click();
  await expect(chart).toHaveAttribute('aria-busy', 'false');
  const endpoint = (await chart.locator('.endpoint-marker').boundingBox())!;
  await page.mouse.move(endpoint.x + endpoint.width / 2 - 1, endpoint.y + endpoint.height / 2);
  await expect(chart.locator('.hover-x')).toHaveText('200');
  const value = Number((await chart.locator('.hover-y').getAttribute('aria-label'))!.replace('Y value: ', ''));
  expect(value).toBeCloseTo(Math.exp(-2) * (1 + .3 * Math.sin(400)), 10);
  await page.mouse.down();
  await expect(chart.locator('.hover-point, .hover-axis-label')).toHaveCount(0);
  await page.mouse.up();
  await page.mouse.move(endpoint.x + endpoint.width / 2 - 2, endpoint.y + endpoint.height / 2);
  await expect(chart.locator('.hover-point')).toBeVisible();
  await page.mouse.move(10, 10);
  await expect(chart.locator('.hover-point, .hover-axis-label')).toHaveCount(0);
});
