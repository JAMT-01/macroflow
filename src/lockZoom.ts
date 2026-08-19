/**
 * Locks page zoom on touch devices.
 *
 * The viewport meta and `touch-action: pan-x pan-y` (src/styles.css) cover
 * Android and desktop, but iOS Safari has ignored `user-scalable=no` since
 * iOS 10 and drives pinch through its own non-standard gesture events.
 * Cancelling those is the only lever left on that browser.
 *
 * Deliberately narrow: gesture events only. Swallowing `touchend` to kill
 * double-tap would also cancel the synthesised click, which breaks tapping the
 * quantity steppers twice in quick succession — and `touch-action` already
 * disables double-tap zoom on both engines.
 *
 * This does not touch the browser's own accessibility zoom or the OS
 * magnifier; both still work.
 */
export function lockZoom() {
  const swallow = (event: Event) => event.preventDefault();
  for (const type of ["gesturestart", "gesturechange", "gestureend"]) {
    document.addEventListener(type, swallow, { passive: false });
  }
}
