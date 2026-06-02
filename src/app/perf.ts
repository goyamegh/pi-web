// Lightweight, opt-in performance tracker for user-perceived latency hotspots
// (session switches today; can be reused for any phased operation).
//
// Enable via either of:
//   • localStorage.setItem("pi-web:perf", "1")
//   • Append ?perf=1 to the URL (auto-stores in localStorage so it persists)
//
// Disable with:
//   • localStorage.removeItem("pi-web:perf")
//
// When disabled the tracker is a no-op (returns null) so call sites stay
// branch-free and impose zero runtime cost in production.

const STORAGE_KEY = "pi-web:perf";

(function bootstrap() {
  try {
    const params = new URLSearchParams(window.location.search);
    if (params.get("perf") === "1") localStorage.setItem(STORAGE_KEY, "1");
    if (params.get("perf") === "0") localStorage.removeItem(STORAGE_KEY);
  } catch {
    // SSR / private mode / non-browser test envs — perf is just disabled.
  }
})();

export function isPerfEnabled(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export type PerfTracker = {
  /** Record a phase boundary. The delta from the previous mark (or t0) is logged at end(). */
  mark: (name: string) => void;
  /** Emit a single-line console summary of all phase deltas plus total. */
  end: (extra?: Record<string, unknown>) => void;
};

export function createTracker(label: string): PerfTracker | null {
  if (!isPerfEnabled()) return null;
  const t0 = performance.now();
  const phases: Array<{ name: string; t: number }> = [];
  return {
    mark(name: string) {
      phases.push({ name, t: performance.now() - t0 });
    },
    end(extra?: Record<string, unknown>) {
      const total = performance.now() - t0;
      const segments: string[] = [];
      let prev = 0;
      for (const p of phases) {
        segments.push(`${p.name}=${(p.t - prev).toFixed(0)}ms`);
        prev = p.t;
      }
      segments.push(`total=${total.toFixed(0)}ms`);
      const suffix = extra ? " " + Object.entries(extra).map(([k, v]) => `${k}=${String(v)}`).join(" ") : "";
      // eslint-disable-next-line no-console
      console.log(`[pi-web perf] ${label}: ${segments.join(" ")}${suffix}`);
    },
  };
}
