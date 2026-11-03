// Curved conductors from a STEP file run conformal by default, and a Mesh-step switch
// returns to staircases (accuracy: cpp/tests/test_conformal.cpp, validation report).
import { expect, test } from '@playwright/test';
import { APP, gotoStep, importFixture, setRole } from './helpers';

test('round metal dipole from STEP: conformal by default, a switch for staircases, and a full run', async ({ page }) => {
  test.setTimeout(300_000);
  await page.goto(APP);
  await importFixture(page, 'dipole.step');
  await gotoStep(page, 'Assign');
  for (const arm of ['arm_top', 'arm_bottom']) {
    await setRole(page, arm, 'radiator');
    await page.getByTestId('conductor-select').selectOption('copper');
  }
  await gotoStep(page, 'Feed');
  await page.getByTestId('tree-expand-arm_top').click();
  await page.getByTestId('tree-face-arm_top-2').click();
  await page.getByTestId('use-selection-signal').click();
  await page.getByTestId('tree-expand-arm_bottom').click();
  await page.getByTestId('tree-face-arm_bottom-3').click();
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
  await expect(page.getByTestId('conformal-report')).toContainText(/[\d,]+ cut faces/);

  await gotoStep(page, 'Mesh');
  await expect(page.getByTestId('mesh-conformal')).toBeChecked();
  await page.getByTestId('mesh-conformal').uncheck();
  await gotoStep(page, 'Validate');
  await page.getByTestId('validate-run').click();
  await expect(page.getByTestId('validate-report')).toContainText('Ready to simulate', { timeout: 60_000 });
  await expect(page.getByTestId('conformal-report')).toHaveCount(0);

  await gotoStep(page, 'Mesh');
  await page.getByTestId('mesh-conformal').check();
  await gotoStep(page, 'Simulate');
  await page.locator('[data-testid="simulate-panel"] input').first().fill('-30');
  await page.getByTestId('sim-run').click();
  await expect(page.getByTestId('sim-results')).toBeVisible({ timeout: 240_000 });
  await expect(page.getByTestId('ff-row')).toContainText('dBi');
});
