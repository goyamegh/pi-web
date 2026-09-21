/**
 * Fork: Chrome-style hover peek for the sessions drawer.
 *
 * Resting a mouse pointer on the hamburger opens the drawer as a transient
 * "peek"; moving the pointer off both the trigger and the drawer closes it
 * again after a short grace period. Any deliberate interaction — clicking the
 * trigger, clicking or typing inside the drawer — converts the peek into a
 * normal, sticky open. Touch and coarse pointers never peek.
 */
import { panelPaneModeQuery } from "../layout/responsive.js";

export type HoverPeekTarget = {
  isOpen: () => boolean;
  /** Open transiently (no history entry). */
  peek: () => void;
  /** Close a peek without moving focus. */
  close: () => void;
};

export type HoverPeekOptions = {
  trigger: HTMLElement;
  panel: HTMLElement;
  target: HoverPeekTarget;
  /** Defaults to `(hover: hover) and (pointer: fine)`. */
  canHover?: () => boolean;
  openDelayMs?: number;
  closeDelayMs?: number;
};

export type HoverPeekController = {
  /** True while the drawer is open only because of a hover. */
  isPeeking: () => boolean;
  /** Convert the current peek (if any) into a normal open. */
  pin: () => void;
  dispose: () => void;
};

// Fine mouse pointer on a split-pane layout only: an overlay drawer popping open
// on a narrow window as the mouse passes the corner would be a nuisance.
const defaultCanHover = () => typeof window.matchMedia === "function"
  && window.matchMedia("(hover: hover) and (pointer: fine)").matches
  && window.matchMedia(panelPaneModeQuery).matches;

export function createSessionDrawerHoverPeek(options: HoverPeekOptions): HoverPeekController {
  const { trigger, panel, target } = options;
  const canHover = options.canHover ?? defaultCanHover;
  const openDelayMs = options.openDelayMs ?? 150;
  const closeDelayMs = options.closeDelayMs ?? 300;
  let peeking = false;
  let openTimer: ReturnType<typeof setTimeout> | undefined;
  let closeTimer: ReturnType<typeof setTimeout> | undefined;

  const clearOpenTimer = () => { if (openTimer !== undefined) { clearTimeout(openTimer); openTimer = undefined; } };
  const clearCloseTimer = () => { if (closeTimer !== undefined) { clearTimeout(closeTimer); closeTimer = undefined; } };
  const isMouse = (event: PointerEvent) => event.pointerType === "mouse" || event.pointerType === "";

  function pin() {
    clearOpenTimer();
    clearCloseTimer();
    peeking = false;
  }

  function scheduleClose() {
    if (!peeking) return;
    clearCloseTimer();
    closeTimer = setTimeout(() => {
      closeTimer = undefined;
      if (!peeking) return;
      peeking = false;
      if (target.isOpen()) target.close();
    }, closeDelayMs);
  }

  const onTriggerEnter = (event: PointerEvent) => {
    if (!isMouse(event) || !canHover()) return;
    clearCloseTimer();
    if (target.isOpen() || openTimer !== undefined) return;
    openTimer = setTimeout(() => {
      openTimer = undefined;
      if (target.isOpen()) return;
      peeking = true;
      target.peek();
      // Opening can fail silently (another panel refused to yield); never keep
      // a stale peek flag around in that case.
      if (!target.isOpen()) peeking = false;
    }, openDelayMs);
  };
  const onTriggerLeave = (event: PointerEvent) => {
    if (!isMouse(event)) return;
    clearOpenTimer();
    scheduleClose();
  };
  const onPanelEnter = (event: PointerEvent) => { if (isMouse(event)) clearCloseTimer(); };
  const onPanelLeave = (event: PointerEvent) => { if (isMouse(event)) scheduleClose(); };

  // A click on the trigger during a peek would normally toggle the drawer shut;
  // make it stick instead. Capture phase + stopImmediatePropagation runs before
  // the panel manager's own bubble-phase toggle on the same element.
  const onTriggerClick = (event: MouseEvent) => {
    if (!peeking) return;
    pin();
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  const onPanelInteract = () => { if (peeking) pin(); };

  trigger.addEventListener("pointerenter", onTriggerEnter);
  trigger.addEventListener("pointerleave", onTriggerLeave);
  trigger.addEventListener("click", onTriggerClick, { capture: true });
  panel.addEventListener("pointerenter", onPanelEnter);
  panel.addEventListener("pointerleave", onPanelLeave);
  panel.addEventListener("pointerdown", onPanelInteract);
  panel.addEventListener("keydown", onPanelInteract);
  panel.addEventListener("focusin", onPanelInteract);

  return {
    isPeeking: () => peeking,
    pin,
    dispose() {
      pin();
      trigger.removeEventListener("pointerenter", onTriggerEnter);
      trigger.removeEventListener("pointerleave", onTriggerLeave);
      trigger.removeEventListener("click", onTriggerClick, { capture: true });
      panel.removeEventListener("pointerenter", onPanelEnter);
      panel.removeEventListener("pointerleave", onPanelLeave);
      panel.removeEventListener("pointerdown", onPanelInteract);
      panel.removeEventListener("keydown", onPanelInteract);
      panel.removeEventListener("focusin", onPanelInteract);
    },
  };
}
