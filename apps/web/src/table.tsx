import { type ReactNode, useState } from "react";

/**
 * The table vocabulary every view shares. Class strings are spelled out in full because
 * Tailwind reads them from the source: a name built at runtime would not be in the build.
 */

/** A row of a list — traders, bags — and its numeric cell. A finger needs more of a row
 *  than a cursor does, so rows only pack tight once there is a mouse-sized screen. */
export const cell = "px-2 h-[30px] leading-[30px] sm:h-[22px] sm:leading-[22px] whitespace-nowrap";
export const num = `${cell} text-right font-mono`;
/** The tape packs its rows tighter; it picks the font per cell. */
export const denseCell = "px-1 sm:px-2 h-[28px] leading-[28px] sm:h-[18px] sm:leading-[18px] whitespace-nowrap";

/** Never wrapped: a two-word header in a narrow column breaks over two lines and stands
 *  out from the row of single ones far more than the extra pixel of width costs. */
export const head =
  "sticky top-0 z-10 bg-panel text-left font-normal text-dimmer uppercase tracking-[0.1em] text-[10px] px-2 py-1 border-b border-line whitespace-nowrap";

/** Columns that only a wide, a medium or a not-a-phone screen has room for. */
export const wide = "hidden lg:table-cell";
export const mid = "hidden md:table-cell";
export const roomy = "hidden sm:table-cell";

/** Green up, red down, dim for a number that is not there. */
export const tone = (n: number | null | undefined) => (n == null ? "text-dimmer" : n >= 0 ? "text-up" : "text-down");

/** Click-to-sort state: one click picks the column, a second turns it around. */
export function useSort<Key extends string>(initial: Key) {
  const [sort, setSort] = useState({ key: initial, asc: false });
  const flip = (key: Key) => setSort((was) => ({ key, asc: was.key === key ? !was.asc : false }));
  return { sort, flip };
}

/** Rows ordered by the column's number, least first when ascending. */
export function sorted<T, Key extends string>(
  rows: T[],
  sort: { key: Key; asc: boolean },
  by: Record<Key, (row: T) => number>,
): T[] {
  return [...rows].sort((a, b) => (by[sort.key](a) - by[sort.key](b)) * (sort.asc ? 1 : -1));
}

/** A header cell that sorts. */
export function SortHeader<Key extends string>({
  sort,
  flip,
  sortKey,
  title,
  extra = "",
  children,
}: {
  sort: { key: Key; asc: boolean };
  flip: (key: Key) => void;
  sortKey: Key;
  title: string;
  extra?: string;
  children: ReactNode;
}) {
  const active = sort.key === sortKey;
  return (
    <th className={`${head} text-right ${extra}`}>
      <button
        type="button"
        title={title}
        className={`uppercase tracking-[0.1em] ${active ? "text-dim" : "hover:text-dim"}`}
        onClick={() => flip(sortKey)}
      >
        {children}
        {active && <span className="ml-1 text-[8px]">{sort.asc ? "▲" : "▼"}</span>}
      </button>
    </th>
  );
}
