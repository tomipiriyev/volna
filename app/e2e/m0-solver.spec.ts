import { expect, test } from '@playwright/test';

test('isolated page uses the multi-thread solver build', async ({ page }) => {
  await page.goto('http://localhost:4173/');
  const caps = page.getByTestId('capabilities');
  await expect(caps).toContainText('Cross-origin isolated');
  expect(await page.evaluate(() => crossOriginIsolated)).toBe(true);

  await page.getByRole('tab', { name: 'Solver' }).click();
  await page.getByTestId('run-selftest').click();
  await expect(page.getByTestId('solver-variant')).toContainText('multi-thread', { timeout: 30_000 });
  await expect(page.getByTestId('selftest-result')).toContainText('Mcells/s', { timeout: 30_000 });
  await expect(page.getByTestId('selftest-error')).toHaveCount(0);
});

test('non-isolated page falls back to the single-thread build', async ({ page }) => {
  await page.goto('http://localhost:4174/');
  expect(await page.evaluate(() => crossOriginIsolated)).toBe(false);

  await page.getByRole('tab', { name: 'Solver' }).click();
  await page.getByTestId('run-selftest').click();
  const variant = page.getByTestId('solver-variant');
  await expect(variant).toContainText('single-thread', { timeout: 30_000 });
  await expect(variant).toContainText('not cross-origin isolated');
  await expect(page.getByTestId('selftest-result')).toContainText('on 1 thread', { timeout: 30_000 });
});

test('workflow steps need a model; none is left as a planned placeholder', async ({ page }) => {
  await page.goto('http://localhost:4173/');
  await expect(page.getByRole('button', { name: /Import/ })).toBeEnabled();
  for (const step of [/Simulate/, /Results/]) await expect(page.getByRole('button', { name: step })).toBeDisabled();
  await expect(page.locator('.stepper .badge.planned')).toHaveCount(0);
});
