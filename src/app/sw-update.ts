/**
 * Auto-reload on service-worker update.
 *
 * With `registerType: "autoUpdate"` the generated SW already calls
 * `skipWaiting()` + `clientsClaim()`, so a new SW activates as soon as it
 * installs.  The missing piece is a client-side `controllerchange` listener
 * that reloads the page when that happens — without it, long-lived tabs keep
 * running the old JS bundles indefinitely.
 *
 * See: GitHub issue #9
 */
export function initSwAutoReload(): void {
  if (!("serviceWorker" in navigator)) return;

  if (Boolean((import.meta as any).env?.DEV)) {
    Promise.all([
      navigator.serviceWorker.getRegistrations().then((registrations) => Promise.all(registrations.map((registration) => registration.unregister()))),
      "caches" in window ? caches.keys().then((keys) => Promise.all(keys.map((key) => caches.delete(key)))) : Promise.resolve([]),
    ]).then(() => {
      if (navigator.serviceWorker.controller) window.location.reload();
    }).catch(() => undefined);
    return;
  }

  let refreshing = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (refreshing) return;
    refreshing = true;
    window.location.reload();
  });
}
