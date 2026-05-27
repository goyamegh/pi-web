import type { AppElements } from "../app/elements.js";
import type { SettingsController } from "../settings/settings.js";

const MIN_WIDTH = 240;
const MAX_WIDTH = 520;
const DEFAULT_WIDTH = 360;
const SNAP_ZONE = 28;
const BREAKOUT_FORCE = 36;

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

export function initSessionDrawerResize(options: {
  elements: AppElements;
  settings: SettingsController;
}) {
  const { elements, settings } = options;
  const drawer = elements.sessionDrawer;

  const handle = document.createElement("div");
  handle.className = "sessionDrawerResizeHandle";
  drawer.appendChild(handle);

  let dragging = false;
  let snapped = false;
  let currentWidth = settings.getNavWidth();

  function applyWidth(width: number) {
    document.documentElement.style.setProperty("--session-drawer-width", `${width}px`);
  }

  applyWidth(currentWidth);

  handle.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    dragging = true;
    snapped = Math.abs(currentWidth - DEFAULT_WIDTH) < 2;
    handle.setPointerCapture(e.pointerId);
    document.body.classList.add("sessionDrawerResizing");
  });

  handle.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const rect = drawer.getBoundingClientRect();
    const rawTarget = clamp(e.clientX - rect.left, MIN_WIDTH, MAX_WIDTH);

    if (snapped) {
      // Must push past BREAKOUT_FORCE from default to escape the detent
      if (Math.abs(rawTarget - DEFAULT_WIDTH) > BREAKOUT_FORCE) {
        snapped = false;
        currentWidth = rawTarget;
      } else {
        currentWidth = DEFAULT_WIDTH;
      }
    } else {
      // Free-dragging — enter snap if pointer enters the inner zone
      if (Math.abs(rawTarget - DEFAULT_WIDTH) < SNAP_ZONE) {
        snapped = true;
        currentWidth = DEFAULT_WIDTH;
      } else {
        currentWidth = rawTarget;
      }
    }

    applyWidth(Math.round(currentWidth));
  });

  handle.addEventListener("pointerup", (e) => {
    if (!dragging) return;
    dragging = false;
    snapped = false;
    handle.releasePointerCapture(e.pointerId);
    document.body.classList.remove("sessionDrawerResizing");

    const finalWidth = Math.round(currentWidth);
    currentWidth = finalWidth;
    applyWidth(finalWidth);

    settings.patchSettings({ appearance: { navWidth: finalWidth } }).catch(() => undefined);
  });

  handle.addEventListener("dblclick", () => {
    currentWidth = DEFAULT_WIDTH;
    applyWidth(DEFAULT_WIDTH);
    settings.patchSettings({ appearance: { navWidth: DEFAULT_WIDTH } }).catch(() => undefined);
  });

  return {
    setWidth(width: number) {
      currentWidth = clamp(width, MIN_WIDTH, MAX_WIDTH);
      applyWidth(Math.round(currentWidth));
    },
  };
}
