// Round wires tilted off the grid axes in a STEP file become thin wires: classified from the
// tessellation, fed at their ends, reported at Validate, refused by WebGPU, run on the CPU
// (accuracy: cpp/tests/test_wires.cpp).
import { expect, test } from '@playwright/test';
import { APP, gotoStep, importFixture, setRole } from './helpers';

test('tilted round dipole from STEP: thin wires, fed at their ends, run on the CPU', async ({ page }) => {
  test.setTimeout(300_000);
  await page.goto(APP);
  await importFixture(page, 'dipole_tilted.step');
  await gotoStep(page, 'Assign');
  for (const arm of ['arm_top', 'arm_bottom']) {
    await setRole(page, arm, 'radiator');
    await page.getByTestId('conductor-select').selectOption('copper');
  }
  await gotoStep(page, 'Feed');
  await page.getByTestId('tree-expand-arm_top').click();
  // The caps at the gap (the arms' far caps are off the axis).
  await page.getByTestId('tree-face-arm_top-3').click();
  await page.getByTestId('use-selection-signal').click();
  await page.getByTestId('tree-expand-arm_bottom').click();
  await page.getByTestId('tree-face-arm_bottom-2').click();
  await page.getByTestId('use-selection-reference').click();
  await page.getByTestId('create-feed').click();
  await expect(page.getByTestId('feed-gap')).toHaveText('1.0000 mm');
  await gotoStep(page, 'Import');
  await page.getByTestId('confirm-units').click();
  await gotoStep(page, 'Frequency');
  await page.getByTestId('fmin').fill('1.5');
  await page.getByTestId('fmax').fill('3.5');
  await page.getByTestId('farfield').fill('2.4');

  await gotoStep(page, 'Validate');
  await page.getByTestId('validate-run').click();
  await expect(page.getByTestId('validate-report')).toContainText('Ready to simulate', { timeout: 60_000 });
  await expect(page.getByTestId('wires-report')).toContainText(/[\d,]+ segments/);

  await gotoStep(page, 'Simulate');
  await page.locator('[data-testid="simulate-panel"] input').first().fill('-30');
  await page.getByTestId('sim-run').click();
  await expect(page.getByTestId('sim-results')).toBeVisible({ timeout: 240_000 });
  await expect(page.getByTestId('ff-row')).toContainText('dBi');
});
