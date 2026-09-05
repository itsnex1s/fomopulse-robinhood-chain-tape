import { type RefObject, useEffect } from "react";
import { useUi, VIEWS, WINDOWS } from "./store.ts";

/** One listener for every shortcut, the way the original terminal drives itself. */
export function useHotkeys(filterRef: RefObject<HTMLInputElement | null>) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const set = useUi.getState().set;
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
      // `[` and `]` walk the views, so the whole screen is reachable without the mouse.
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
