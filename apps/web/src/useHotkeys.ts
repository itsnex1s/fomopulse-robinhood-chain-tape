import { type RefObject, useEffect } from "react";
import { useUi, VIEWS, WINDOWS } from "./store.ts";

/**
 * Whether the browser owns this keystroke. Shift is not in the list: on a good few layouts
 * `/` is a shifted key, and the filter shortcut has to survive them.
 */
export const chorded = (event: Pick<KeyboardEvent, "metaKey" | "ctrlKey" | "altKey">): boolean =>
  event.metaKey || event.ctrlKey || event.altKey;

/** One listener for every shortcut, the way the original terminal drives itself. */
export function useHotkeys(filterRef: RefObject<HTMLInputElement | null>) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const set = useUi.getState().set;
      // Cmd+D bookmarks, Cmd+T opens a tab, Cmd+1..5 switch tabs. Every one of those also
      // reached this listener, so the browser did its thing and the tape silently changed
      // its filter or its window underneath the reader. Escape carries no modifier either.
      if (chorded(event)) return;
      if (event.key === "Escape") {
        set({ filter: "" });
        filterRef.current?.blur();
        return;
      }
      if (event.target instanceof HTMLInputElement) return;
      if (event.key === "/") {
        event.preventDefault();
        filterRef.current?.focus();
        return;
      }
      const window = WINDOWS[Number(event.key) - 1];
      if (window) set({ window });
      if (event.key === "t") set({ stocks: !useUi.getState().stocks });
      if (event.key === "d") set({ dust: !useUi.getState().dust });
      if (event.key === "[" || event.key === "]") {
        const at = VIEWS.indexOf(useUi.getState().view);
        const next = (at + (event.key === "]" ? 1 : VIEWS.length - 1)) % VIEWS.length;
        set({ view: VIEWS[next] });
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [filterRef]);
}
