import { useEffect } from "react";
import { useUi } from "./store.ts";
import { type Place, placeUrl, pushes, readPlace, titleOf } from "./url.ts";

const placeOf = (): Place => {
  const { view, window: counted, filter } = useUi.getState();
  return { view, window: counted, filter };
};

/**
 * The address bar and the store, kept in step. The address is the authority when the page
 * opens and whenever the reader goes back or forward; every change after that is written to
 * it.
 */
export function useUrl(): void {
  useEffect(() => {
    let shown = placeOf();
    let href = placeUrl(shown);
    // Replaced, not pushed: the entry the reader arrived on is this one, tidied.
    window.history.replaceState(null, "", href);
    document.title = titleOf(shown);

    const show = (place: Place) => {
      shown = place;
      href = placeUrl(place);
      document.title = titleOf(place);
    };

    const read = () => {
      // No fallback: an entry in this history was written by placeUrl, so what it leaves out
      // it means — a screen with no filter on it is a screen with no filter, not the one the
      // reader had two entries ago.
      const place = readPlace(window.location.href);
      if (place === undefined) return;
      // Adopted before the store hears about it, so the write below sees nothing to do: an
      // address arrived at by going back, written back, pushes the entry the reader just
      // left and leaves nothing to go forward to.
      show(place);
      useUi.getState().set(place);
    };
    window.addEventListener("popstate", read);

    const unsubscribe = useUi.subscribe(() => {
      const place = placeOf();
      const next = placeUrl(place);
      if (next === href) return;
      const push = pushes(shown, place);
      show(place);
      window.history[push ? "pushState" : "replaceState"](null, "", next);
    });

    return () => {
      window.removeEventListener("popstate", read);
      unsubscribe();
    };
  }, []);
}
