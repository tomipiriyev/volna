// The GitHub Pages build: served from a subfolder with no isolation headers.
import { expect, test } from '@playwright/test';
import { importFixture } from './helpers';

const PAGES = 'http://localhost:4175/volna/';

test.describe('with the service worker', () => {
  test('isolates itself, runs multi-threaded and loads every asset from the subfolder', async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto(PAGES);
    // The app renders only on the load that is not about to reload.
    await expect(page.getByTestId('capabilities')).toBeVisible({ timeout: 30_000 });
    expect(await page.evaluate(() => crossOriginIsolated)).toBe(true);
    expect(await page.title()).toBe('Volna Antenna Simulation');

    await page.getByRole('tab', { name: 'Solver' }).click();
    await page.getByTestId('run-selftest').click();
    await expect(page.getByTestId('solver-variant')).toContainText('multi-thread', { timeout: 30_000 });
    await expect(page.getByTestId('selftest-result')).toContainText('Mcells/s', { timeout: 30_000 });
    await expect(page.getByTestId('selftest-error')).toHaveCount(0);
    await importFixture(page, 'patch_fr4.step'); // the STEP importer's wasm

    // Later visits are isolated at once, with no further reload.
    await page.reload();
    await expect(page.getByTestId('capabilities')).toBeVisible({ timeout: 30_000 });
    expect(await page.evaluate(() => crossOriginIsolated)).toBe(true);
  });
});

test.describe('without service workers', () => {
  test.use({ serviceWorkers: 'block' });

  test('the host sends no headers, and the app falls back to one thread', async ({ page }) => {
    await page.goto(PAGES);
    await expect(page.getByTestId('capabilities')).toBeVisible({ timeout: 30_000 });
    expect(await page.evaluate(() => crossOriginIsolated)).toBe(false);
    await page.getByRole('tab', { name: 'Solver' }).click();
    await page.getByTestId('run-selftest').click();
    await expect(page.getByTestId('solver-variant')).toContainText('single-thread', { timeout: 30_000 });
    await expect(page.getByTestId('selftest-result')).toContainText('on 1 thread', { timeout: 30_000 });
  });
});
