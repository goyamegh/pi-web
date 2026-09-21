import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSessionDrawerHoverPeek } from "../src/sessions/sessionDrawerHoverPeek.js";

class FakePointerEvent extends Event {
  constructor(type: string, public readonly pointerType: string) {
    super(type, { bubbles: false, cancelable: true });
  }
}

function harness(overrides: { canHover?: () => boolean } = {}) {
  const trigger = new EventTarget() as unknown as HTMLElement;
  const panel = new EventTarget() as unknown as HTMLElement;
  let open = false;
  const target = {
    isOpen: () => open,
    peek: vi.fn(() => { open = true; }),
    close: vi.fn(() => { open = false; }),
  };
  const peek = createSessionDrawerHoverPeek({ trigger, panel, target, canHover: overrides.canHover ?? (() => true), openDelayMs: 150, closeDelayMs: 300 });
  const pointer = (element: HTMLElement, type: string, pointerType = "mouse") => element.dispatchEvent(new FakePointerEvent(type, pointerType));
  return { trigger, panel, target, peek, pointer, isOpen: () => open, setOpen: (value: boolean) => { open = value; } };
}

describe("session drawer hover peek", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("opens after resting on the trigger and closes after the pointer leaves both trigger and drawer", () => {
    const h = harness();
    h.pointer(h.trigger, "pointerenter");
    vi.advanceTimersByTime(149);
    expect(h.isOpen()).toBe(false);
    vi.advanceTimersByTime(1);
    expect(h.isOpen()).toBe(true);
    expect(h.peek.isPeeking()).toBe(true);

    // Crossing from the trigger into the drawer must not close it.
    h.pointer(h.trigger, "pointerleave");
    vi.advanceTimersByTime(200);
    h.pointer(h.panel, "pointerenter");
    vi.advanceTimersByTime(1_000);
    expect(h.isOpen()).toBe(true);

    h.pointer(h.panel, "pointerleave");
    vi.advanceTimersByTime(299);
    expect(h.isOpen()).toBe(true);
    vi.advanceTimersByTime(1);
    expect(h.isOpen()).toBe(false);
    expect(h.target.close).toHaveBeenCalledTimes(1);
    expect(h.peek.isPeeking()).toBe(false);
  });

  it("a brush past the trigger never opens", () => {
    const h = harness();
    h.pointer(h.trigger, "pointerenter");
    vi.advanceTimersByTime(100);
    h.pointer(h.trigger, "pointerleave");
    vi.advanceTimersByTime(2_000);
    expect(h.target.peek).not.toHaveBeenCalled();
    expect(h.isOpen()).toBe(false);
  });

  it("clicking the trigger during a peek pins the drawer instead of toggling it shut", () => {
    const h = harness();
    const managerToggle = vi.fn();
    h.trigger.addEventListener("click", managerToggle);
    h.pointer(h.trigger, "pointerenter");
    vi.advanceTimersByTime(150);
    expect(h.peek.isPeeking()).toBe(true);

    const click = new Event("click", { cancelable: true });
    h.trigger.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
    expect(managerToggle).not.toHaveBeenCalled();
    expect(h.peek.isPeeking()).toBe(false);

    h.pointer(h.trigger, "pointerleave");
    vi.advanceTimersByTime(5_000);
    expect(h.isOpen()).toBe(true);
    expect(h.target.close).not.toHaveBeenCalled();

    // Once pinned, the trigger click reaches the panel manager again.
    h.trigger.dispatchEvent(new Event("click", { cancelable: true }));
    expect(managerToggle).toHaveBeenCalledTimes(1);
  });

  it("working inside the drawer pins it", () => {
    for (const interaction of ["pointerdown", "keydown", "focusin"]) {
      const h = harness();
      h.pointer(h.trigger, "pointerenter");
      vi.advanceTimersByTime(150);
      h.panel.dispatchEvent(new Event(interaction));
      expect(h.peek.isPeeking()).toBe(false);
      h.pointer(h.panel, "pointerleave");
      vi.advanceTimersByTime(5_000);
      expect(h.isOpen()).toBe(true);
    }
  });

  it("ignores touch pointers, hover-incapable devices, and an already open drawer", () => {
    const touch = harness();
    touch.pointer(touch.trigger, "pointerenter", "touch");
    vi.advanceTimersByTime(1_000);
    expect(touch.target.peek).not.toHaveBeenCalled();

    const coarse = harness({ canHover: () => false });
    coarse.pointer(coarse.trigger, "pointerenter");
    vi.advanceTimersByTime(1_000);
    expect(coarse.target.peek).not.toHaveBeenCalled();

    const open = harness();
    open.setOpen(true);
    open.pointer(open.trigger, "pointerenter");
    vi.advanceTimersByTime(1_000);
    open.pointer(open.trigger, "pointerleave");
    vi.advanceTimersByTime(5_000);
    expect(open.target.peek).not.toHaveBeenCalled();
    expect(open.target.close).not.toHaveBeenCalled();
    expect(open.isOpen()).toBe(true);
  });

  it("does not leave a stale peek flag when the manager refuses to open", () => {
    const h = harness();
    h.target.peek.mockImplementation(() => { /* refused */ });
    h.pointer(h.trigger, "pointerenter");
    vi.advanceTimersByTime(150);
    expect(h.peek.isPeeking()).toBe(false);
  });
});
