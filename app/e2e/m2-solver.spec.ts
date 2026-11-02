import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const expected = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../validation/cases/dipole/expected.json'), 'utf8'));

for (const [label, url] of [
  ['multi-thread (isolated)', 'http://localhost:4173/'],
  ['single-thread (not isolated)', 'http://localhost:4174/'],
] as const) {
  test(`validation dipole runs in the browser, ${label}, and matches the native solver`, async ({ page }) => {
    test.setTimeout(180_000);
    await page.goto(url);
    await page.getByRole('tab', { name: 'Solver' }).click();
    await page.getByTestId('run-benchmark').click();
    await expect(page.getByTestId('benchmark-progress')).toBeVisible({ timeout: 30_000 });
    const table = page.getByTestId('benchmark-results');
    await expect(table).toBeVisible({ timeout: 170_000 });
    const resonance = await table.locator('tr', { hasText: 'Series resonance' }).locator('td').nth(1).textContent();
    const fGHz = Number(resonance!.replace(/[^\d.]/g, ''));
    // wasm and native run the same arithmetic (no FMA contraction), so the
    // resonance agrees to the printed precision.
    expect(Math.abs(fGHz * 1e9 - expected.native.fRes)).toBeLessThan(1e5);
    await expect(page.getByTestId('benchmark-error')).toHaveCount(0);
  });
}

test('a running solve can be cancelled', async ({ page }) => {
  await page.goto('http://localhost:4173/');
  await page.getByRole('tab', { name: 'Solver' }).click();
  await page.getByTestId('run-benchmark').click();
  await expect(page.getByTestId('benchmark-progress')).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('cancel-benchmark').click();
  await expect(page.getByTestId('benchmark-error')).toContainText('cancelled', { timeout: 10_000 });
  await expect(page.getByTestId('run-benchmark')).toBeEnabled();
});
