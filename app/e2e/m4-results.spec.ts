// M4 in the browser: results dashboard (port plots, polar cuts, modes),
// exports (CSV exact and independent of display settings, SVG, PNG), and a
// project saved with results that becomes current again after validation.
import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { gotoStep, preparePatch } from './helpers';

async function downloadOf(page: Page, click: () => Promise<void>) {
  const [d] = await Promise.all([page.waitForEvent('download'), click()]);
  return { name: d.suggestedFilename(), bytes: readFileSync((await d.path())!) };
}

test('results dashboard, exports, history and project round trip', async ({ page }) => {
  test.setTimeout(420_000);
  await preparePatch(page);
  await gotoStep(page, 'Simulate');
  await page.locator('[data-testid="simulate-panel"] input').first().fill('-30');
  await page.getByTestId('sim-run').click();
  await expect(page.getByTestId('sim-eta')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('sim-results')).toBeVisible({ timeout: 240_000 });
  await page.getByTestId('open-results').click();

  // Dashboard: port plots and cuts.
  const dash = page.getByTestId('results-dashboard');
  await expect(dash).toBeVisible();
  await expect(page.getByTestId('plot-s11')).toBeVisible();
  await page.getByTestId('port-plot-vswr').click();
  await expect(page.getByTestId('plot-vswr')).toBeVisible();
  await page.getByTestId('port-plot-zin').click();
  await expect(page.getByTestId('plot-zin')).toBeVisible();
  await expect(page.getByTestId('polar-elevation')).toBeVisible();
  await expect(page.getByTestId('polar-azimuth')).toBeVisible();
  await expect(page.getByTestId('hpbw-elevation')).toContainText(/HPBW \(Total\): \d+\.\d°/);
  await expect(page.getByTestId('sum-d')).toHaveAttribute('data-state', 'ok');
  await expect(page.getByTestId('sum-d')).toContainText('dBi');
  await expect(page.getByTestId('sum-g')).toContainText('dBi');
  await expect(page.getByTestId('sum-band')).toContainText('GHz');
  await expect(page.getByTestId('results-stale')).toHaveCount(0);

  // Modes and polarization change the plots, with explicit units.
  await page.getByTestId('result-quantity').selectOption('normalized');
  await expect(page.getByTestId('polar-elevation')).toContainText('dB (normalized)');
  await page.getByTestId('result-quantity').selectOption('realizedGain');
  await expect(page.getByTestId('polar-elevation')).toContainText('dBi');
  await page.getByTestId('result-pol').selectOption('co');
  await expect(page.getByTestId('polar-elevation').locator('polygon')).toHaveCount(2);

  // CSV: raw data with the documented header; the display range does not change it.
  const csv1 = await downloadOf(page, () => page.getByTestId('export-port').click());
  expect(csv1.name).toMatch(/_port\.csv$/);
  const text = csv1.bytes.toString('utf8');
  expect(text).toMatch(/^# Volna Antenna Simulation port results/);
  expect(text.split('\n').filter((l) => l && !l.startsWith('#'))).toHaveLength(402); // header + 401 frequencies
  await page.getByTestId('result-range').fill('15');
  await page.getByTestId('result-scale').selectOption('lin');
  const csv2 = await downloadOf(page, () => page.getByTestId('export-port').click());
  expect(csv2.bytes.equals(csv1.bytes)).toBe(true);
  const pattern = await downloadOf(page, () => page.getByTestId('export-pattern').click());
  expect(pattern.name).toMatch(/_pattern_2\.3500GHz\.csv$/);

  // Plot images.
  const svg = await downloadOf(page, () => page.getByTestId('svg-elevation').click());
  expect(svg.name).toMatch(/_elevation\.svg$/);
  expect(svg.bytes.toString('utf8')).toContain('<svg');
  const png = await downloadOf(page, () => page.getByTestId('png-zin').click());
  expect(png.name).toMatch(/_zin\.png$/);
  expect(png.bytes.subarray(1, 4).toString('latin1')).toBe('PNG');
  expect(png.bytes.length).toBeGreaterThan(5000);

  // Save with results, reload, reopen: results come back marked as from the file,
  // and become current once validation reproduces the same problem.
  await expect(page.getByTestId('save-results')).toBeChecked();
  const project = await downloadOf(page, () => page.getByTestId('save-project').click());
  await page.reload();
  await page.getByTestId('project-input').setInputFiles({ name: project.name, mimeType: 'application/zip', buffer: project.bytes });
  await expect(page.getByTestId('results-dashboard')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('history-item')).toHaveCount(1);
  await expect(page.getByTestId('results-stale')).toContainText('from the project file');
  await gotoStep(page, 'Validate');
  await page.getByTestId('validate-run').click();
  await expect(page.getByTestId('validate-report')).toContainText('Ready to simulate', { timeout: 60_000 });
  await gotoStep(page, 'Results');
  await expect(page.getByTestId('results-stale')).toHaveCount(0);
  await expect(page.getByTestId('run-history')).toContainText('current');
});
