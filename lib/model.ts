// Token Launch Radar — model v2 (calibrated).
//
// One sealed snapshot in, one ranked board out. The board ranks protocols that record
// no token yet ("pre-token": no market cap, no CoinGecko id, no symbol in the snapshot)
// by what a token launch would plausibly be worth if the protocol's record stayed as
// it is. Protocols whose token already trades are never ranked: they are the
// calibration set, and the dashboard shows them apart, at the market's own values.
//
// The implied value is built only from the snapshot's own figures:
//
//   1. Category multiple, calibrated in-sample. For every category, take the live-token
//      protocols in that category and their market-cap / TVL ratios; the category's
//      multiple is the median ratio, shrunk toward the global median when the category
//      has few live samples, and clamped to [0.04, 2.5]. A lending market and a DEX are
//      not priced off the same multiple, and no multiple is a hand-picked constant:
//      change the snapshot and every multiple moves.
//   2. Growth: the 7-day TVL change, clamped to [-40, +60] percent, weighted 0.55.
//   3. Maturity: how long the protocol has run with no token, from listed_at to the
//      snapshot date; full weight at four years, floor 0.72. Unknown listing dates use
//      a neutral one year and are flagged on the row.
//   4. Breadth: 2.5 percent per extra chain beyond the first, capped at eight extras —
//      a protocol people already use on many chains has more holders to launch to.
//
//   implied = TVL x category multiple x growth x maturity x breadth, rounded.
//
// No protocol name is ever special-cased: one function scores every row, and each row
// carries its own inputs and multipliers so a reader can recompute it by hand.

/** The snapshot's protocol entry: exactly the ten fields the sealed input carries. */
export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The whole snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** One category's calibrated multiple and the live samples behind it. */
export interface CategoryCalibration {
  category: string;
  samples: number;
  median_ratio: number;
  multiple: number;
}

/** The calibration the model ran with: one global median and one row per category. */
export interface Calibration {
  global_multiple: number;
  live_protocols: number;
  categories: CategoryCalibration[];
}

/** The model's fixed weights. The multiples are not here: they are calibrated. */
export const WEIGHTS = {
  growth_weight: 0.55,
  growth_floor: -40,
  growth_cap: 60,
  maturity_floor: 0.72,
  maturity_range: 0.28,
  maturity_days: 1460,
  unknown_age_days: 365,
  breadth_per_chain: 0.025,
  breadth_max_extra: 8,
  multiple_floor: 0.04,
  multiple_cap: 2.5,
  shrink_samples: 6,
} as const;

/** The model's version label, named in the dashboard and on every board row. */
export const MODEL_VERSION = 'radar-2-calibrated';

/** How many live-token protocols the dashboard's "already trading" view carries. */
export const LIVE_ROWS = 30;

/** One row of board.json: the ranked board's row, with its model's working shown. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
  token_status: 'pre-token';
  on_watchlist: boolean;
  age_days: number | null;
  age_assumed: boolean;
  implied_value_usd: number;
  model: {
    version: string;
    category_multiple: number;
    category_samples: number;
    growth_pct: number;
    growth_multiplier: number;
    maturity_multiplier: number;
    breadth_multiplier: number;
  };
  farm_steps: string[];
}

/** The dashboard's view of one board row: everything the page renders, farm plan included. */
export interface RadarRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  listed_at: string | null;
  on_watchlist: boolean;
  age_days: number | null;
  age_assumed: boolean;
  implied_value_usd: number;
  category_multiple: number;
  category_samples: number;
  growth_multiplier: number;
  maturity_multiplier: number;
  breadth_multiplier: number;
  farm_steps: string[];
}

/** A live-token protocol: already trading, shown at the market's value, never ranked. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
  mcap_tvl: number | null;
}

/** Everything the dashboard needs: the board, the live set, and the calibration. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model_version: string;
  weights: typeof WEIGHTS;
  calibration: Calibration;
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  rows: RadarRow[];
  live: LiveRow[];
}

/** Why the snapshot is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;

function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;
const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));

/** A whole day count from `listedAt` to `asOf`, clamped at zero; null when unknown. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** The median of a non-empty list, computed on a sorted copy (deterministic). */
function median(values: number[]): number {
  const sorted = [...values].sort((x, y) => x - y);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Whether a protocol records no token at all in the snapshot. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/**
 * Categories that name a product of another protocol rather than a protocol waiting
 * on its own launch — the same screen the house's watchlist applies. The snapshot
 * carries no parent-protocol field, so category, plus the name checks below, is what
 * can be applied from its ten fields.
 */
const PRODUCT_CATEGORIES = new Set(['Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX']);
const PRODUCT_WORD = /\b(wrapped|staked|staking)\b/i;
const EXCHANGE_PREFIX = /^(Binance|Coinbase|Bybit|Kraken|Bitget|OKX|Bitfinex|Gemini)\b/;

/**
 * Whether a protocol may be ranked beyond the watchlist: pre-token, and not a wrapped,
 * staked, bridged or exchange product of a token that already trades (WBTC, Binance
 * staked ETH and USDT0 all record no token of their own in the snapshot, and all are
 * products of one that trades — the radar exists to find launches, not wrappers).
 */
export function isRankable(p: SnapshotProtocol): boolean {
  if (!isPreToken(p)) return false;
  if (p.category !== null && PRODUCT_CATEGORIES.has(p.category)) return false;
  if (VERSIONED.test(p.name) || PRODUCT_WORD.test(p.name) || EXCHANGE_PREFIX.test(p.name)) return false;
  return true;
}

/**
 * Calibrate the category multiples from the snapshot's own live-token protocols.
 * Each category's raw multiple is the median market-cap / TVL of its live protocols;
 * categories with fewer than WEIGHTS.shrink_samples samples are shrunk toward the
 * global median in proportion to how many samples they are missing.
 */
export function calibrate(snapshot: Snapshot): Calibration {
  const live = snapshot.protocols.filter(
    (p) => !isPreToken(p) && p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0,
  );
  const globalMedian = live.length > 0 ? median(live.map((p) => p.mcap_usd! / p.tvl_usd)) : 0.25;
  const byCategory = new Map<string, number[]>();
  for (const p of live) {
    const key = p.category ?? 'Uncategorized';
    const list = byCategory.get(key) ?? [];
    list.push(p.mcap_usd! / p.tvl_usd);
    byCategory.set(key, list);
  }
  const categories: CategoryCalibration[] = [...byCategory.entries()]
    .map(([category, ratios]) => {
      const med = median(ratios);
      const n = ratios.length;
      const shrunk =
        n >= WEIGHTS.shrink_samples
          ? med
          : (n * med + (WEIGHTS.shrink_samples - n) * globalMedian) / WEIGHTS.shrink_samples;
      return {
        category,
        samples: n,
        median_ratio: round4(med),
        multiple: round4(clamp(shrunk, WEIGHTS.multiple_floor, WEIGHTS.multiple_cap)),
      };
    })
    .sort((a, b) => (a.category < b.category ? -1 : a.category > b.category ? 1 : 0));
  return {
    global_multiple: round4(clamp(globalMedian, WEIGHTS.multiple_floor, WEIGHTS.multiple_cap)),
    live_protocols: live.length,
    categories,
  };
}

/** The calibrated multiple one protocol's category carries (global when unlisted). */
function multipleFor(calibration: Calibration, category: string | null): CategoryCalibration {
  const key = category ?? 'Uncategorized';
  const found = calibration.categories.find((c) => c.category === key);
  if (found !== undefined) return found;
  return { category: key, samples: 0, median_ratio: calibration.global_multiple, multiple: calibration.global_multiple };
}

/** One protocol's multipliers and implied value under the calibrated model. */
export function impliedValue(
  protocol: SnapshotProtocol,
  asOf: string,
  calibration: Calibration,
): {
  implied: number;
  multiple: number;
  samples: number;
  growthPct: number;
  growthMult: number;
  maturityMult: number;
  breadthMult: number;
  age: number | null;
  ageAssumed: boolean;
} {
  const cal = multipleFor(calibration, protocol.category);
  const growthPct = clamp(finite(protocol.change_7d, 0), WEIGHTS.growth_floor, WEIGHTS.growth_cap);
  const growthMult = 1 + (growthPct / 100) * WEIGHTS.growth_weight;
  const age = ageDays(asOf, protocol.listed_at);
  const ageAssumed = age === null;
  const ageForModel = age ?? WEIGHTS.unknown_age_days;
  const maturityMult =
    WEIGHTS.maturity_floor +
    (Math.min(Math.max(ageForModel, 0), WEIGHTS.maturity_days) / WEIGHTS.maturity_days) * WEIGHTS.maturity_range;
  const breadthMult = 1 + WEIGHTS.breadth_per_chain * Math.min(Math.max(protocol.chains.length - 1, 0), WEIGHTS.breadth_max_extra);
  const implied = Math.max(1, Math.round(protocol.tvl_usd * cal.multiple * growthMult * maturityMult * breadthMult));
  return { implied, multiple: cal.multiple, samples: cal.samples, growthPct, growthMult, maturityMult, breadthMult, age, ageAssumed };
}

/** The first chain a protocol names, or a neutral phrase. */
function chainOf(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

/** How much capital one farm position needs, from the protocol's own TVL tier. */
function capitalFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 5_000_000_000) return 300;
  if (p.tvl_usd >= 1_000_000_000) return 200;
  if (p.tvl_usd >= 250_000_000) return 120;
  if (p.tvl_usd >= 50_000_000) return 80;
  return 40;
}

/** How long to hold, from the protocol's age: younger protocols get a longer window. */
function holdDaysFor(age: number | null): number {
  if (age === null) return 45;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

/** The category's core position action, in words a farmer can follow. */
function actionFor(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral'))
    return `Supply $${capital} of USDC to ${name} on ${chain}, then borrow about 40 percent against it and re-supply the borrow so both sides of the market see your wallet.`;
  if (c.includes('curator') || c.includes('allocator') || c.includes('vault'))
    return `Deposit $${capital} of USDC into a ${name} vault on ${chain} and keep the vault shares in the same wallet for the whole window.`;
  if (c.includes('dex') || c.includes('derivative') || c.includes('perpetual'))
    return `Trade on ${name} on ${chain}: swap about $${capital} in volume across the week in small clips instead of one trade, and keep a small open position.`;
  if (c.includes('yield'))
    return `Provide $${capital} of liquidity to ${name}'s main pool on ${chain} and leave the LP position untouched between weekly checks.`;
  if (c.includes('bridge'))
    return `Bridge $${capital} of USDC to ${chain} through ${name}, then make one real transaction on the far side so the trip is not a round trip.`;
  if (c.includes('staking') || c.includes('restak'))
    return `Stake $${capital} of the chain's staking asset through ${name} on ${chain} and keep the staking receipt in your wallet.`;
  if (c.includes('rwa') || c.includes('real world'))
    return `Mint $${capital} of ${name}'s yield asset on ${chain} through its own app and hold the asset past the next monthly snapshot.`;
  if (c.includes('payment'))
    return `Route one real payment of about $${capital} through ${name} on ${chain} — pay an invoice or a second wallet you control — and keep the channel or account open.`;
  if (c.includes('prediction'))
    return `Fund $${capital} on ${name} and hold one position in a liquid market until it settles instead of flipping it the same day.`;
  if (c.includes('stable'))
    return `Mint or deposit $${capital} of the stable asset through ${name} on ${chain} and hold it rather than swapping straight back out.`;
  if (c.includes('insurance'))
    return `Buy $${capital} of cover from ${name} on ${chain} for a position you actually hold and keep the policy to expiry.`;
  if (c.includes('game') || c.includes('nft'))
    return `Play or mint on ${name} on ${chain} with about $${capital} of spend spread over several days, keeping the assets in your wallet.`;
  return `Deposit $${capital} of USDC into ${name} on ${chain} through its own app and keep the position open past the weekly snapshot.`;
}

/** The category's weekly qualifying action: the habit that keeps an account counted. */
function weeklyFor(p: SnapshotProtocol, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral'))
    return `Once a week, adjust the ${p.name} position once — add or repay about 5 percent — so the account shows ongoing use, not a parked deposit.`;
  if (c.includes('dex') || c.includes('derivative') || c.includes('perpetual'))
    return `Once a week, make two or three small swaps on ${p.name} on ${chain} on different days, so the volume looks like use and not one wash trade.`;
  if (c.includes('bridge'))
    return `Once a week, bridge a small amount, about $10, across ${p.name} in alternating directions and use the funds once on the far side.`;
  return `Once a week, make one qualifying action on ${p.name} — a deposit, a claim of accrued rewards, a vote or a small top-up of about $10 — and log it.`;
}

/** A step as one string: action, then cost, then time, inside the gate's 20..600 characters. */
function stepText(action: string, cost: string, time: string): string {
  let s = `${action} Cost: ${cost}. Time: ${time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Keep the position and re-check weekly.`;
  return s;
}

/**
 * A protocol's farm plan: six concrete steps, each with a cost and a time, derived from
 * the protocol's own record — its category, its main chain, its TVL tier and its age —
 * never from a hand-written list of protocol names.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null): string[] {
  const chain = chainOf(p);
  const capital = capitalFor(p);
  const hold = holdDaysFor(age);
  const gas = capital >= 200 ? 8 : capital >= 100 ? 5 : 3;
  return [
    stepText(
      `Set up one fresh wallet for ${p.name} farming only, fund it from your main wallet, and keep its seed phrase offline on paper`,
      'under $3 of gas for the funding transaction',
      '10 minutes',
    ),
    stepText(actionFor(p, capital, chain), `$${capital} of capital plus about $${gas} of gas`, '20 minutes to set up'),
    stepText(weeklyFor(p, chain), 'about $2 of gas a week', '10 minutes a week'),
    stepText(
      `Hold the ${p.name} position for at least ${hold} days so the activity appears in more than one weekly snapshot, and do not empty the wallet in between`,
      `the $${capital} stays in the position for the whole window`,
      `${hold} days`,
    ),
    stepText(
      `Check ${p.name}'s official site and verified social account for a points or rewards page; claim only from a link the protocol itself publishes, and never pay a fee to claim`,
      'nothing to check, and never pay to claim',
      '10 minutes a week',
    ),
    stepText(
      `Keep a farm log with the wallet address, every date, amount and transaction hash, and review the position every two weeks; unwind it if the protocol announces a snapshot date that has already passed`,
      'nothing but the log itself',
      '5 minutes a week',
    ),
  ];
}

/** The protocols the board ranks, strongest first, with ranks 1..n. */
export function buildBoard(snapshot: Snapshot, calibration: Calibration = calibrate(snapshot)): BoardRow[] {
  const index = new Map(snapshot.protocols.map((p) => [p.slug, p]));
  const chosen = new Map<string, SnapshotProtocol>();
  for (const slug of snapshot.watchlist) {
    const p = index.get(slug);
    if (p !== undefined) chosen.set(slug, p);
  }
  // The radar beyond the floor: every other rankable pre-token protocol in the snapshot,
  // not a capped sample — a radar that stops at the biggest names finds nothing early.
  for (const p of snapshot.protocols) {
    if (!chosen.has(p.slug) && isRankable(p)) chosen.set(p.slug, p);
  }
  const watchlist = new Set(snapshot.watchlist);
  const scored = [...chosen.values()].map((p) => ({ p, v: impliedValue(p, snapshot.as_of, calibration) }));
  scored.sort((a, b) => b.v.implied - a.v.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  return scored.map((s, i) => ({
    rank: i + 1,
    slug: s.p.slug,
    name: s.p.name,
    category: s.p.category,
    chains: s.p.chains,
    tvl_usd: s.p.tvl_usd,
    change_7d: s.p.change_7d,
    mcap_usd: s.p.mcap_usd,
    listed_at: s.p.listed_at,
    gecko_id: s.p.gecko_id,
    symbol: s.p.symbol,
    token_status: 'pre-token',
    on_watchlist: watchlist.has(s.p.slug),
    age_days: s.v.age,
    age_assumed: s.v.ageAssumed,
    implied_value_usd: s.v.implied,
    model: {
      version: MODEL_VERSION,
      category_multiple: s.v.multiple,
      category_samples: s.v.samples,
      growth_pct: s.v.growthPct,
      growth_multiplier: round4(s.v.growthMult),
      maturity_multiplier: round4(s.v.maturityMult),
      breadth_multiplier: round4(s.v.breadthMult),
    },
    farm_steps: farmSteps(s.p, s.v.age),
  }));
}

/** The live-token protocols, by market cap, for the dashboard's already-trading view. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !isPreToken(p) && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd)
    .slice(0, LIVE_ROWS)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
      mcap_tvl: p.mcap_usd !== null && p.tvl_usd > 0 ? round4(p.mcap_usd / p.tvl_usd) : null,
    }));
}

/** Everything the dashboard renders, from the snapshot. */
export function buildRadar(snapshot: Snapshot): { board: BoardRow[]; radar: RadarData } {
  const calibration = calibrate(snapshot);
  const board = buildBoard(snapshot, calibration);
  const live = liveRows(snapshot);
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model_version: MODEL_VERSION,
    weights: WEIGHTS,
    calibration,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: board.filter((r) => !r.on_watchlist).length,
    live_size: live.length,
    rows: board.map((row) => ({
      rank: row.rank,
      slug: row.slug,
      name: row.name,
      category: row.category,
      chains: row.chains,
      tvl_usd: row.tvl_usd,
      change_7d: row.change_7d,
      listed_at: row.listed_at,
      on_watchlist: row.on_watchlist,
      age_days: row.age_days,
      age_assumed: row.age_assumed,
      implied_value_usd: row.implied_value_usd,
      category_multiple: row.model.category_multiple,
      category_samples: row.model.category_samples,
      growth_multiplier: row.model.growth_multiplier,
      maturity_multiplier: row.model.maturity_multiplier,
      breadth_multiplier: row.model.breadth_multiplier,
      farm_steps: row.farm_steps,
    })),
    live,
  };
  return { board, radar };
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return {
    as_of: o.as_of,
    source: o.source,
    floor_usd: o.floor_usd,
    protocols,
    watchlist: o.watchlist as string[],
  };
}

/** Why a board is not one the gate will take, or null. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slugs: ${missing.slice(0, 5).join(', ')}`;
  if (board.length < 100) return `the board holds ${board.length} rows, under the 100-row floor`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value: a board that ranks nothing by value is not a ranking`;
  }
  for (const r of board) {
    const steps = r.farm_steps;
    if (steps.length < 3 || steps.length > 12) return `${r.slug} has ${steps.length} farm steps`;
    for (const s of steps) {
      const trimmed = s.trim();
      if (trimmed.length < 20 || trimmed.length > 600) return `${r.slug} has a farm step of ${trimmed.length} characters`;
    }
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `${r.slug} has implied value ${r.implied_value_usd}`;
  }
  return null;
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch, no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
