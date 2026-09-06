import { useQuery } from "@tanstack/react-query";
import { Avatar } from "./Avatar.tsx";
import { fomoTokenUrl, getTraders, TRACKED_CHAIN, tokenExplorerUrl, tokenUrl, traderUrl } from "./api.ts";
import { ago, compact, pct, price, short, signed, span, usdCompact } from "./format.ts";
import { Rows } from "./Hover.tsx";
import { useUi } from "./store.ts";
import { tone } from "./table.tsx";
import type { Fill } from "./types.ts";

/** What the status endpoint said about the chain: where a transaction and a token are looked up. */
export interface Links {
  explorer: string;
  slug: string;
}

/** Under this much in the pool, a fill of ordinary size moves the price; the symbol carries a dotted line. */
export const THIN_LIQUIDITY = 10_000;
/** A pool younger than this when the fill landed is a launch, and the row says so. */
export const NEW_POOL_S = 3_600;

/**
 * The trade against the price now: for a buy, where the mark stands against the price
 * paid; for a sell, where the price received stands against the mark. Positive is the
 * trade in front either way — a buy into a token that rose, a sell before a fall — which
 * is not the same as the token being up, and is why the column is called `vs now` and
 * not `since`.
 * Green means the trade is working, whichever direction it went.
 */
export const vsNowPct = (fill: Fill): number | null => {
  if (fill.mark === null || fill.price === null || fill.mark <= 0 || fill.price <= 0 || fill.priced === "unpriced")
    return null;
  return (fill.side === "buy" ? fill.mark / fill.price - 1 : fill.price / fill.mark - 1) * 100;
};

/**
 * What the whole token was worth when this fill landed. The feed reports the market cap
 * now, and the row carries both the price paid and the price now: the ratio between those
 * two is the ratio between the two market caps, because the supply of these tokens does
 * not move. So the column answers what a tape is read for — the size they got in at —
 * instead of repeating today's number down every row of the same token, which is what the
 * card is for.
 */
export const mcapAt = (fill: Fill): number | null => {
  if (fill.market_cap === null || fill.mark === null || fill.price === null) return null;
  if (fill.mark <= 0 || fill.price <= 0 || fill.priced === "unpriced") return null;
  return (fill.market_cap * fill.price) / fill.mark;
};

export const poolAge = (fill: Fill, at: number): number | null =>
  fill.pair_created_at === null ? null : at - fill.pair_created_at / 1000;

const pnlCell = (value: number) => <span className={tone(value)}>{signed(value)}</span>;

/** The token's card from the feed, on hover: everything the row has no column for. */
export function TokenCard({ fill, explorer, slug }: { fill: Fill } & Links) {
  const now = Math.floor(Date.now() / 1000);
  const vsNow = vsNowPct(fill);
  const age = poolAge(fill, now);
  const fomo = fomoTokenUrl({ network: TRACKED_CHAIN, token: fill.token });
  return (
    <>
      <span className="mb-1 flex items-center gap-2 text-fg">
        <Avatar src={fill.image_url} seed={fill.token} size={16} />
        <span className="font-medium">{fill.symbol ?? short(fill.token)}</span>
        {fill.name && fill.name !== fill.symbol && <span className="text-dim">{fill.name}</span>}
        {fill.is_stock === 1 && <span className="text-[9px] text-dimmer">tokenised stock</span>}
      </span>
      <Rows
        rows={[
          [
            "mark",
            fill.mark === null ? null : (
              <>
                {price(fill.mark)}
                {vsNow !== null && <span className={`ml-2 ${tone(vsNow)}`}>{pct(vsNow)} on this trade</span>}
              </>
            ),
          ],
          // Named for the clock, because the row now has the other one: the column is the market cap
          // this fill landed at, and the two sitting side by side unlabelled read as a contradiction.
          ["mcap now", fill.market_cap === null ? null : usdCompact(fill.market_cap)],
          ["vol 24h", fill.volume24 === null ? null : usdCompact(fill.volume24)],
          [
            "liquidity",
            fill.liquidity === null ? null : (
              <>
                {usdCompact(fill.liquidity)}
                {fill.liquidity < THIN_LIQUIDITY && <span className="ml-2 text-down">thin</span>}
              </>
            ),
          ],
          [
            "market 24h",
            fill.buys24 === null && fill.sells24 === null ? null : (
              <>
                <span className="text-up">{compact(fill.buys24 ?? 0)} buys</span>
                <span className="text-dimmer"> / </span>
                <span className="text-down">{compact(fill.sells24 ?? 0)} sells</span>
              </>
            ),
          ],
          [
            "1h / 24h",
            fill.change1h === null && fill.change24 === null ? null : (
              <>
                <span className={tone(fill.change1h)}>{fill.change1h === null ? "—" : pct(fill.change1h)}</span>
                <span className="text-dimmer"> / </span>
                <span className={tone(fill.change24)}>{fill.change24 === null ? "—" : pct(fill.change24)}</span>
              </>
            ),
          ],
          ["pool", age === null ? null : `${span(age)} old${fill.dex ? ` · ${fill.dex}` : ""}`],
          [
            "crowd",
            fill.others > 0
              ? `${fill.others} other tracked ${fill.others === 1 ? "wallet" : "wallets"} bought it in the hour before`
              : "nobody else in the hour before",
          ],
        ]}
      />
      <span className="mt-1.5 flex gap-3 text-[10px]">
        <a
          className="hover:text-accent"
          href={fill.pair_url ?? tokenUrl(slug, fill.token)}
          target="_blank"
          rel="noreferrer"
        >
          chart ↗
        </a>
        {fomo && (
          <a className="hover:text-accent" href={fomo} target="_blank" rel="noreferrer">
            fomo ↗
          </a>
        )}
        <a className="hover:text-accent" href={tokenExplorerUrl(explorer, fill.token)} target="_blank" rel="noreferrer">
          contract ↗
        </a>
      </span>
    </>
  );
}

/**
 * The trader's card: fomo's standing and what they did on this tape in the window.
 * The tape stats come from the traders query the traders tab already keeps, read only
 * while the card is open.
 */
export function TraderCard({ fill }: { fill: Fill }) {
  const window = useUi((state) => state.window);
  const { data } = useQuery({ queryKey: ["traders", window], queryFn: () => getTraders(window), staleTime: 30_000 });
  const stats = data?.find((t) => t.handle === fill.handle);
  return (
    <>
      <span className="mb-1 flex items-center gap-2 text-fg">
        <Avatar src={fill.avatar_url} seed={fill.wallet} size={16} />
        <span className="font-medium">{fill.handle}</span>
        {fill.verified === 1 && <span title="verified on fomo">✓</span>}
        {fill.display_name && fill.display_name !== fill.handle && (
          <span className="text-dim">{fill.display_name}</span>
        )}
        {fill.clan && <span className="text-[9px] text-dimmer">{fill.clan}</span>}
      </span>
      <Rows
        rows={[
          ["rank 24h", fill.rank === null ? null : `#${fill.rank}`],
          ["pnl 24h", fill.pnl_24h === null ? null : pnlCell(fill.pnl_24h)],
          ["followers", compact(fill.followers)],
          [`on this tape, ${window}`, stats ? `${stats.fills} fills · ${usdCompact(stats.tape_volume)}` : null],
          ["last fill", stats?.last_ts ? `${ago(stats.last_ts)} ago` : null],
        ]}
      />
      <span className="mt-1.5 flex gap-3 text-[10px]">
        <a className="hover:text-accent" href={traderUrl(fill)} target="_blank" rel="noreferrer">
          profile ↗
        </a>
        <span className="text-dimmer">rank, pnl and followers are fomo's</span>
      </span>
    </>
  );
}
