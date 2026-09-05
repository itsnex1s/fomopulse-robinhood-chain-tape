import { memo, useState } from "react";

const hash = (seed: string) => {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
};

/**
 * fomo's picture when there is one, otherwise a chip derived from the address — the
 * same wallet always draws the same chip, so a trader is still recognisable in a
 * dense tape without fetching anything.
 */
export const Avatar = memo(function Avatar({
  src,
  seed,
  size = 14,
}: {
  src?: string | null;
  seed: string;
  size?: number;
}) {
  const [broken, setBroken] = useState(false);

  if (src && !broken) {
    return (
      <img
        src={src}
        alt=""
        loading="lazy"
        referrerPolicy="no-referrer"
        onError={() => setBroken(true)}
        className="inline-block shrink-0 rounded-[2px] object-cover align-[-2px]"
        style={{ width: size, height: size }}
      />
    );
  }

  const h = hash(seed);
  const hue = h % 360;
  const cells: [number, number][] = [];
  for (let x = 0; x < 3; x++) {
    for (let y = 0; y < 5; y++) {
      if (!((h >> (x * 5 + y)) & 1)) continue;
      cells.push([x, y]);
      if (x < 2) cells.push([4 - x, y]);
    }
  }

  return (
    <svg
      viewBox="0 0 5 5"
      width={size}
      height={size}
      className="inline-block shrink-0 rounded-[2px] align-[-2px]"
      style={{ background: `hsl(${hue} 30% 14%)` }}
      aria-hidden="true"
    >
      {cells.map(([x, y]) => (
        <rect key={`${x}-${y}`} x={x} y={y} width="1" height="1" fill={`hsl(${hue} 60% 58%)`} />
      ))}
    </svg>
  );
});
