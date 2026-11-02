// GitHub Pages cannot set response headers, so the Pages build gets cross-origin
// isolation from a service worker that adds them (public/coi-sw.js). A first
// visit reloads once, after the worker is active. If the page still is not
// isolated, or the worker cannot run, the app carries on with the single-thread
// solver, as on any host without the headers.
const RELOADED = 'coi-reloaded';

function activated(worker: ServiceWorker): Promise<boolean> {
  return new Promise((resolve) => {
    if (worker.state === 'activated') return resolve(true);
    worker.addEventListener('statechange', () => {
      if (worker.state === 'activated') resolve(true);
      if (worker.state === 'redundant') resolve(false);
    });
  });
}

/** Resolves true if the page is about to reload (the app should not start). */
export async function enableIsolation(): Promise<boolean> {
  try {
    if (crossOriginIsolated) {
      sessionStorage.removeItem(RELOADED);
      return false;
    }
    if (!('serviceWorker' in navigator) || sessionStorage.getItem(RELOADED)) return false;
    const registration = await navigator.serviceWorker.register(`${import.meta.env.BASE_URL}coi-sw.js`);
    const worker = registration.installing ?? registration.waiting ?? registration.active;
    if (!worker || !(await activated(worker))) return false;
    sessionStorage.setItem(RELOADED, '1');
    location.reload();
    return true;
  } catch {
    return false;
  }
}
