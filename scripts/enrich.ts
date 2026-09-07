/** Refresh the cards fomo shows for the tracked traders. Needs FOMO_ACCESS_TOKEN in .env. */
import { allTraders } from "../apps/server/src/db.ts";
import { refresh } from "../apps/server/src/traders.ts";

const seen = await refresh();
const stored = allTraders();
const withAvatar = stored.filter((t) => t.avatar_url).length;
console.log(`${seen} per window → ${stored.length} traders stored, ${withAvatar} with an avatar`);
