// Shared e2e steps: import a fixture, assign roles, define the patch feed.
import { expect, type Page } from '@playwright/test';
import { resolve } from 'node:path';

export const FIX = resolve(import.meta.dirname, '../../validation/fixtures/step');
export const APP = 'http://localhost:4173/';

export async function importFixture(page: Page, name: string) {
  await page.getByTestId('step-input').setInputFiles(resolve(FIX, name));
  await expect(page.getByTestId('banner')).toContainText(`Imported ${name}`, { timeout: 30_000 });
}

export async function gotoStep(page: Page, label: string) {
  await page.locator('.stepper button', { hasText: label }).click();
}

export async function setRole(page: Page, body: string, role: string) {
  await page.getByTestId(`tree-body-${body}`).click();
  await page.getByTestId('role-select').selectOption(role);
}

export async function setupPatch(page: Page) {
  await importFixture(page, 'patch_fr4.step');
  await gotoStep(page, 'Assign');
  await setRole(page, 'patch', 'radiator');
  await setRole(page, 'ground', 'ground');
  await setRole(page, 'substrate', 'dielectric');
  await page.getByTestId('material-select').selectOption('openems-patch');
  await gotoStep(page, 'Feed');
  await page.getByTestId('tree-expand-patch').click();
  await page.getByTestId('tree-face-patch-5').click(); // bottom face, z = 1.524
  await page.getByTestId('use-selection-signal').click();
  await page.getByTestId('tree-expand-ground').click();
  await page.getByTestId('tree-face-ground-6').click(); // top face, z = 0
  await page.getByTestId('use-selection-reference').click();
  await page.getByTestId('create-feed').click();
  await page.getByTestId('feed-lat-u').fill('-6');
  await expect(page.getByTestId('feed-gap')).toHaveText('1.5240 mm');
}

/** Patch with confirmed units and the band of validation/cases/patch_step, ready to mesh. */
export async function preparePatch(page: Page, url = APP) {
  await page.goto(url);
  await setupPatch(page);
  await gotoStep(page, 'Import');
  await page.getByTestId('confirm-units').click();
  await gotoStep(page, 'Frequency');
  await page.getByTestId('fmin').fill('1');
  await page.getByTestId('fmax').fill('3');
  await page.getByTestId('farfield').fill('2.35');
}
