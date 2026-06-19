/**
 * useStoreVersion.ts — React hooks that subscribe to non-React stores via
 * useSyncExternalStore.
 *
 * These hooks replace the old setRenderKey hack in ExtensionHub.tsx.
 * Instead of forcing a remount via key change, the component subscribes
 * to the store's version counter and re-renders naturally when it changes.
 *
 * useSyncExternalStore guarantees:
 *   - No tearing (consistent snapshot across concurrent renders)
 *   - No infinite loops (snapshot must be referentially stable between changes)
 *   - Works in SSR (returns initial snapshot during hydration)
 */

import { useSyncExternalStore } from "react";
import {
  subscribeToHubChanges,
  getHubVersion,
} from "../extensionCenter.js";
import {
  subscribeToModesChanges,
  getModesVersion,
} from "../modes.js";

/**
 * Subscribe to extensionCenter store changes.
 * Returns the current hub version (bumped on every mutation).
 * The component re-renders when the version changes.
 */
export function useHubVersion(): number {
  return useSyncExternalStore(
    subscribeToHubChanges,
    getHubVersion,
    // Server snapshot — same as client snapshot (we're not doing SSR but
    // useSyncExternalStore requires this argument in some React versions).
    getHubVersion,
  );
}

/**
 * Subscribe to modes store changes.
 * Returns the current modes version (bumped on every mutation).
 */
export function useModesVersion(): number {
  return useSyncExternalStore(
    subscribeToModesChanges,
    getModesVersion,
    getModesVersion,
  );
}

/**
 * Subscribe to BOTH stores at once (convenience for the Hub which needs both).
 * Returns a composite version string that changes when either store changes.
 *
 * This is the recommended way for the ExtensionHub to subscribe — it needs
 * to re-render when either extensions or modes change.
 */
export function useHubAndModesVersions(): { hub: number; modes: number } {
  const hub = useHubVersion();
  const modes = useModesVersion();
  return { hub, modes };
}
