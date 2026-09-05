import { Fragment, type ReactNode, useState } from "react";

/**
 * A card that opens on hover and is not in the DOM otherwise: four hundred rows carry
 * nothing they are not showing. It drops below its trigger, left-aligned, in the same
 * ink as the panel; the trigger itself is whatever the row already draws.
 */
export function Hover({
  children,
  card,
  className = "",
}: {
  children: ReactNode;
  card: () => ReactNode;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: hover only opens a card; the link inside stays the interactive element
    <span
      className={`relative inline-flex items-center ${className}`}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      {children}
      {open && (
        <span className="absolute left-0 top-full z-20 mt-1 block w-max max-w-[360px] whitespace-normal rounded-[2px] border border-line bg-panel px-2.5 py-2 text-left text-[11px] font-normal normal-case leading-[16px] tracking-normal text-dim shadow-lg">
          {card()}
        </span>
      )}
    </span>
  );
}

/** Key–value lines inside a card; a missing value is a dash, never an empty slot. */
export function Rows({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <span className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
      {rows.map(([key, value]) => (
        <Fragment key={key}>
          <span className="text-dimmer">{key}</span>
          <span className="font-mono text-fg">{value ?? "—"}</span>
        </Fragment>
      ))}
    </span>
  );
}
