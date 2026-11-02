// M3 end to end in the browser: STEP patch -> mesh -> validate -> simulate,
// cancel, and stale-result marking. The grid matches validation/cases/patch_step
// (same fixture, roles, feed and band), whose native run agrees with openEMS.
import { expect, test } from '@playwright/test';
import { gotoStep, preparePatch } from './helpers';

test('patch from STEP: mesh preview, validation report, run, results and stale marking', async ({ page }) => {
  test.setTimeout(300_000);
  await preparePatch(page);

  await gotoStep(page, 'Mesh');
  await expect(page.getByTestId('mesh-cells')).toContainText('390,400');
  await expect(page.getByTestId('mesh-blockers')).toHaveCount(0);

  await gotoStep(page, 'Validate');
  await page.getByTestId('validate-run').click();
  const report = page.getByTestId('validate-report');
  await expect(report).toContainText('Ready to simulate', { timeout: 60_000 });
  await expect(report).toContainText('2,112 PEC edges'); // ground
  await expect(report).toContainText('1,004 PEC edges'); // patch
  await expect(report).toContainText('3,072 cells of openems-patch');
  await expect(page.getByTestId('time-estimate')).toContainText('at least');

  // A loose end criterion keeps the browser run short; accuracy is covered by the native validation.
  await gotoStep(page, 'Simulate');
  await page.locator('[data-testid="simulate-panel"] input').first().fill('-30');
  await page.getByTestId('sim-run').click(); // re-validates: the settings changed
  await expect(page.getByTestId('sim-progress')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('sim-results')).toBeVisible({ timeout: 240_000 });
  await expect(page.getByTestId('s11-min')).toContainText(/-?\d+\.\d+ dB at 2\.\d{4} GHz/);
  await expect(page.getByTestId('ff-row')).toContainText('dBi');
  await expect(page.getByTestId('open-results')).toBeVisible(); // plots live on the Results step (M4)
  await expect(page.getByTestId('stale-badge')).toHaveCount(0);

  // Any input change marks the result stale.
  await gotoStep(page, 'Frequency');
  await page.getByTestId('farfield').fill('2.3');
  await gotoStep(page, 'Simulate');
  await expect(page.getByTestId('stale-badge')).toBeVisible();
});

test('a running simulation can be cancelled', async ({ page }) => {
  test.setTimeout(180_000);
  await preparePatch(page);
  await gotoStep(page, 'Simulate');
  await page.getByTestId('sim-run').click();
  await expect(page.getByTestId('sim-progress')).toBeVisible({ timeout: 60_000 });
  await page.getByTestId('sim-cancel').click();
  await expect(page.getByTestId('sim-error')).toHaveText(/cancelled/, { timeout: 10_000 });
  await expect(page.getByTestId('sim-run')).toBeEnabled();
});
