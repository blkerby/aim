import { expect, test } from '@playwright/test';
import { writeFileSync } from 'node:fs';

test('read-only real-data rendering and warm scroll benchmark', async ({ page, request }) => {
  test.skip(!process.env.REAL_REPO_URL, 'Set REAL_REPO_URL to an already running viewer for optional real-data QA.');
  test.setTimeout(180000);
  const url = process.env.REAL_REPO_URL!;
  const catalog = await (await request.get(`${url}/api/runs`)).json();
  const runs = catalog.runs.map((r: {id:string}) => r.id);
  const metadata = await (await request.post(`${url}/api/metrics`, { data:{runs} })).json();
  const favorites = ['loss','success_rate','avg_conn','avg_door','temperature','min_conn'];
  const metrics = favorites.map(name => metadata.metrics.find((m: any) => m.name === name && !Object.keys(m.context).length)?.id).filter(Boolean);
  await page.addInitScript(({repo,runs,metrics}) => {
    localStorage.setItem(`aim-viewer:${repo}`,JSON.stringify({runs,metrics}));
    (window as any).longTasks = [];
    new PerformanceObserver(list => { for (const entry of list.getEntries()) (window as any).longTasks.push(entry.duration); }).observe({type:'longtask',buffered:true});
  },{repo:catalog.repo,runs,metrics});
  const errors: string[] = []; page.on('pageerror', err => errors.push(err.message));
  const begin = Date.now(); await page.goto(url);
  await expect(page.locator('.chart-card')).toHaveCount(metrics.length);
  await expect(page.locator('.chart-card').first()).toHaveAttribute('aria-busy', 'false', {timeout:120000});
  await expect(page.locator('.plot-empty')).toHaveCount(0, {timeout:120000});
  await expect(page.locator('.chart-card[aria-busy=true]')).toHaveCount(0, {timeout:120000});
  const loadedMs = Date.now() - begin;
  expect(await page.locator('.chart-error').count()).toBe(0);
  await page.screenshot({path:'test-results/real-data.png',fullPage:true});
  const scroll = await page.evaluate(async () => {
    const el = document.querySelector('.chart-scroll')!;
    (window as any).longTasks = [];
    const gaps: number[] = [];
    let previous = performance.now();
    for (let i=0;i<90;i++) {
      await new Promise<void>(resolve => requestAnimationFrame(now => {
        gaps.push(now-previous);previous=now;el.scrollTop=(Math.sin(i/15)+1)/2*(el.scrollHeight-el.clientHeight);resolve();
      }));
    }
    gaps.sort((a,b)=>a-b);
    return {p95FrameMs:gaps[Math.floor(gaps.length*.95)],maxFrameMs:Math.max(...gaps),longTasks:(window as any).longTasks,
      heapBytes:(performance as any).memory?.usedJSHeapSize};
  });
  // Select every metric; only visible chart rows should mount and request data.
  await page.locator('.metrics-selector').getByRole('button',{name:'Select filtered'}).click();
  await expect(page.locator('.toolbar h2')).toContainText(`${metadata.metrics.length} charts`);
  const mounted = await page.locator('.chart-card').count();
  expect(mounted).toBeLessThan(12);
  await page.locator('.chart-scroll').evaluate(el => { el.scrollTop = el.scrollHeight; });
  expect(await page.locator('.chart-card').count()).toBeLessThan(12);
  const stats = await (await request.get(`${url}/api/stats`)).json();
  writeFileSync('test-results/real-browser-benchmark.json',JSON.stringify({runCount:runs.length,metricCount:metadata.metrics.length,initialCharts:metrics.length,loadedMs,scroll,mounted,stats,errors},null,2));
  expect(errors).toEqual([]);
});
