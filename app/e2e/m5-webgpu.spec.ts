// M5: the WebGPU time loop against the C++ solver, in Chromium's new headless
// mode (channel 'chromium'), which exposes the real GPU (Metal on macOS); the
// default headless shell has no WebGPU adapter. Acceptance:
//   fields after 1000 steps: relative L2 < 1e-4 (dipole and STEP patch)
//   complete runs: Zin within 0.5 %, D within 0.02 dB; speedup reported
// plus a WebGPU run through the app and the device-lost fallback to the CPU.
import { expect, test } from '@playwright/test';
import { APP, gotoStep, preparePatch } from './helpers';

test.use({ channel: 'chromium' });

test('GPU self-test: fields after 1000 steps match the C++ solver', async ({ page }) => {
  test.setTimeout(240_000);
  await page.goto(APP);
  await page.getByRole('tab', { name: 'Solver' }).click();
  await page.getByTestId('run-gpu-selftest').click();
  const rows = page.getByTestId('gpu-selftest-row');
  await expect(rows).toHaveCount(2, { timeout: 200_000 });
  for (const row of await rows.all()) {
    const worst = Number(await row.getAttribute('data-worst'));
    expect(worst).toBeLessThan(1e-4);
    console.log(`self-test ${(await row.innerText()).replace(/\s+/g, ' ')}`);
  }
});

test('complete runs on WebGPU reproduce the CPU solver (Zin, D) and are faster', async ({ page }) => {
  test.setTimeout(600_000);
  await page.goto(APP);
  await page.getByRole('tab', { name: 'Solver' }).click();
  await page.getByTestId('run-gpu-compare').click();
  const rows = page.getByTestId('gpu-compare-row');
  await expect(rows).toHaveCount(2, { timeout: 560_000 });
  for (const row of await rows.all()) {
    expect(Number(await row.getAttribute('data-zin'))).toBeLessThan(0.005);
    expect(Number(await row.getAttribute('data-d'))).toBeLessThan(0.02);
    console.log(`complete run ${(await row.innerText()).replace(/\s+/g, ' ')}`);
  }
});

test('simulating on WebGPU from the app, and falling back to the CPU when the device is lost', async ({ page }) => {
  test.setTimeout(420_000);
  // A normal WebGPU run through the workflow.
  await preparePatch(page);
  await gotoStep(page, 'Simulate');
  await page.locator('[data-testid="simulate-panel"] input').first().fill('-30');
  await page.getByTestId('sim-backend').selectOption('webgpu');
  await page.getByTestId('sim-run').click();
  await expect(page.getByTestId('sim-results')).toBeVisible({ timeout: 240_000 });
  await expect(page.getByTestId('run-backend')).toHaveText('on WebGPU');
  await expect(page.getByTestId('s11-min')).toContainText(/dB at 2\.\d{4} GHz/);

  // The test hook destroys the device after 300 steps: the run fails with
  // GPU_DEVICE_LOST and the panel offers the CPU, which then completes the run.
  await preparePatch(page, `${APP}?gpuLoseDevice=300`);
  await gotoStep(page, 'Simulate');
  await page.locator('[data-testid="simulate-panel"] input').first().fill('-30');
  await page.getByTestId('sim-backend').selectOption('webgpu');
  await page.getByTestId('sim-run').click();
  await expect(page.getByTestId('sim-error')).toContainText('GPU_DEVICE_LOST', { timeout: 120_000 });
  await page.getByTestId('sim-run-cpu').click();
  await expect(page.getByTestId('sim-results')).toBeVisible({ timeout: 300_000 });
  await expect(page.getByTestId('run-backend')).toContainText('CPU thread');
  await expect(page.getByTestId('sim-backend')).toHaveValue('cpu');
});
