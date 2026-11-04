/** Where the docked chat sits over the full-screen computer, and how tall it is. */
export type ComputerDockEdge = "top" | "bottom";

export type ComputerDockPref = {
  edge: ComputerDockEdge;
  /** Pixels; clamped again on read against the current viewport and the caller's minimum. */
  height: number;
  collapsed: boolean;
};

const STORAGE_KEY = "rakazo:computer-dock";

const DEFAULT_PREF: ComputerDockPref = { edge: "bottom", height: 320, collapsed: false };

export function readComputerDockPref(): ComputerDockPref {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_PREF;
    const parsed = JSON.parse(raw) as Partial<ComputerDockPref>;
    return {
      edge: parsed.edge === "top" ? "top" : "bottom",
      height: Number.isFinite(parsed.height) ? Number(parsed.height) : DEFAULT_PREF.height,
      collapsed: parsed.collapsed === true,
    };
  } catch {
    return DEFAULT_PREF;
  }
}

export function writeComputerDockPref(pref: ComputerDockPref): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(pref));
  } catch {
    // Keep the dock usable when storage is unavailable; the in-memory state still applies.
  }
}
