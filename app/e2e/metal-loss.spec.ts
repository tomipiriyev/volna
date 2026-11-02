// Conductor loss in the browser: choose metals for the patch and its ground, and
// the prepared grid carries lossy surface edges (accuracy: cpp/tests/test_metal.cpp).
import { expect, test } from '@playwright/test';
import { gotoStep, preparePatch } from './helpers';

test('metal conductors: choice, surface resistance, sheet current faces, lossy edges in the report', async ({ page }) => {
  test.setTimeout(180_000);
  await preparePatch(page);

  await gotoStep(page, 'Assign');
  await page.getByTestId('tree-body-patch').click();
  await expect(page.getByTestId('conductor-select')).toHaveValue('pec');
  await page.getByTestId('conductor-select').selectOption('copper');
  // Copper at the band centre sqrt(1 GHz * 3 GHz) = 1.732 GHz: R_s = 10.9 mOhm, delta = 1.59 um.
  await expect(page.getByTestId('conductor-info')).toContainText('Surface resistance 10.9 mΩ, skin depth 1.59 µm at 1.732 GHz');
  await page.getByTestId('sheet-current-select').selectOption('one');
  await page.getByTestId('tree-body-ground').click();
  await page.getByTestId('conductor-select').selectOption('copper');
  await page.getByTestId('tree-body-patch').click();
  await expect(page.getByTestId('sheet-current-select')).toHaveValue('one');

  await gotoStep(page, 'Validate');
  await page.getByTestId('validate-run').click();
  const report = page.getByTestId('validate-report');
  await expect(report).toContainText('Ready to simulate', { timeout: 60_000 });
  await expect(report).toContainText(/Copper: 1,004 conductor edges, [\d,]+ on the surface with metal loss/); // patch
  await expect(report).toContainText(/Copper: 2,112 conductor edges, [\d,]+ on the surface with metal loss/); // ground
});
