import { expect, test } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { APP, gotoStep, importFixture, setupPatch } from './helpers';

test('imports a STEP file with names, units and dimensions', async ({ page }) => {
  await page.goto(APP);
  await importFixture(page, 'dipole.step');
  await expect(page.getByTestId('declared-unit')).toHaveText('mm');
  await expect(page.getByTestId('tree-body-arm_top')).toBeVisible();
  await expect(page.getByTestId('tree-body-arm_bottom')).toBeVisible();
  await expect(page.getByTestId('dims')).toContainText('× 59.00 mm');
  await expect(page.getByTestId('backend')).toHaveText(/WebGPU|WebGL2 fallback/);
});

test('reports a declared inch unit and applies a unit override', async ({ page }) => {
  await page.goto(APP);
  await importFixture(page, 'dipole_inch.step');
  await expect(page.getByTestId('declared-unit')).toHaveText('inch');
  await expect(page.getByTestId('model-size')).toContainText('× 59.000 mm');
  await page.getByTestId('unit-select').selectOption('mm');
  await expect(page.getByTestId('model-size')).toContainText(`× ${(59 / 25.4).toFixed(3)} mm`);
  await page.getByTestId('confirm-units').click();
  await expect(page.getByTestId('confirm-units')).toHaveText('Units confirmed');
});

test('clicking a cylinder selects its whole B-rep face, not a triangle', async ({ page }) => {
  await page.goto(APP);
  await importFixture(page, 'dipole.step');
  await gotoStep(page, 'Assign');
  await page.locator('.seg button', { hasText: 'Faces' }).click();
  const box = (await page.getByTestId('viewport-canvas').boundingBox())!;
  // The upper arm's side is just above the view centre (the 1 mm feed gap is at the
  // centre, the arm's end cap near the top of the model).
  const props = page.getByTestId('face-props');
  let curved = false;
  for (const dy of [-0.08, -0.12, -0.05, -0.16]) {
    await page.mouse.click(box.x + box.width / 2, box.y + box.height * (0.5 + dy));
    if ((await props.isVisible()) && (await props.textContent())!.includes('curved')) {
      curved = true;
      break;
    }
  }
  expect(curved).toBe(true);
  // The side face of an r = 1, h = 29 cylinder has area ~ 2*pi*29 = 182 mm^2 (slightly less when tessellated).
  const area = Number((await props.locator('td', { hasText: 'mm²' }).textContent())!.replace(/[^\d.]/g, ''));
  expect(area).toBeGreaterThan(175);
  expect(area).toBeLessThan(183);
});

test('assigns roles and builds the patch feed from tree-selected faces', async ({ page }) => {
  await page.goto(APP);
  await setupPatch(page);
  // The gap is below the coarse estimated cell: an info note (the mesher refines the feed), not a feed issue.
  await expect(page.getByTestId('feed-issue')).toHaveCount(0);
  await expect(page.locator('[data-code="PORT_GAP_UNRESOLVED"]')).toContainText('smaller than the estimated cell');
  // Dielectric slab is refined, not rejected.
  await expect(page.locator('[data-code="THIN_DIELECTRIC_LAYER"]')).toHaveCount(1);
  await expect(page.locator('[data-code="NO_PORT"]')).toHaveCount(0);

  // Same-body terminals are rejected.
  await page.getByTestId('tree-face-ground-5').click();
  await page.getByTestId('use-selection-signal').click();
  await page.getByTestId('create-feed').click();
  await expect(page.getByTestId('feed-issue').first()).toContainText('same body');
});

test('saves a project and restores it after a reload', async ({ page }) => {
  await page.goto(APP);
  await setupPatch(page);
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('save-project').click()]);
  expect(download.suggestedFilename()).toBe('patch_fr4.antsim');
  const file = join(mkdtempSync(join(tmpdir(), 'antsim-')), 'patch_fr4.antsim');
  await download.saveAs(file);

  await page.reload();
  await page.getByTestId('project-input').setInputFiles(file);
  await expect(page.getByTestId('banner')).toContainText('Opened project patch_fr4.antsim', { timeout: 30_000 });
  await page.getByTestId('tree-body-substrate').click();
  await expect(page.getByTestId('role-select')).toHaveValue('dielectric');
  await expect(page.getByTestId('material-select')).toHaveValue('openems-patch');
  await page.getByTestId('tree-body-patch').click();
  await expect(page.getByTestId('role-select')).toHaveValue('radiator');
  await gotoStep(page, 'Feed');
  await expect(page.getByTestId('feed-gap')).toHaveText('1.5240 mm');
  await expect(page.getByTestId('feed-lat-u')).toHaveValue('-6');
});
