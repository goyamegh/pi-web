const nonTextInputTypes = new Set([
  "button",
  "checkbox",
  "color",
  "file",
  "hidden",
  "image",
  "radio",
  "range",
  "reset",
  "submit",
]);

export function isTouchLikeDevice() {
  if (typeof window === "undefined" || typeof navigator === "undefined") return false;
  return Boolean(
    window.matchMedia?.("(hover: none), (pointer: coarse)").matches
    || "ontouchstart" in window
    || navigator.maxTouchPoints > 0,
  );
}

export function shouldAvoidProgrammaticKeyboardFocus() {
  return isTouchLikeDevice();
}

export function isEditableElement(element: Element | null): element is HTMLElement {
  if (!(element instanceof HTMLElement)) return false;
  if (element instanceof HTMLInputElement) return !nonTextInputTypes.has(element.type.toLowerCase());
  return element instanceof HTMLTextAreaElement
    || element instanceof HTMLSelectElement
    || element.isContentEditable;
}

export function blurActiveEditableOnMobile() {
  if (!shouldAvoidProgrammaticKeyboardFocus() || typeof document === "undefined") return false;
  const active = document.activeElement;
  if (!isEditableElement(active)) return false;
  active.blur();
  return true;
}

export function focusIfKeyboardFriendly(element: HTMLElement, options?: FocusOptions) {
  if (shouldAvoidProgrammaticKeyboardFocus() && isEditableElement(element)) return false;
  element.focus(options);
  return true;
}
