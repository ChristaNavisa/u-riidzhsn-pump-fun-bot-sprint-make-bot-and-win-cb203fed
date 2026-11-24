// Fair-launch sniper for the pump.fun bonding-curve replay (agent-fun/replay/v2).
//
// The hello message opens the run with the capital, the caps and the seed. Every batch
// after that carries one slot of chain events plus the orders that resolved since the
// previous batch. This strategy answers each batch with at most a handful of orders.
//
// Idea: the tape decides in the first slots. A new curve is bought only in its first
// few slots, and only when its opening tape looks like real demand: the creator did
// not buy a huge chunk of it themselves, at least six distinct wallets other than the
// creator bought in with them, net flow is positive, and the curve already holds real
// SOL. Launches bundled by one cluster fail this test and are never touched. The buy
// is small (0.05 SOL, capped at 1% of the real reserve) and the exit is fast: a
// take-profit, a stop loss, a trailing stop once it is up, a short time limit, or at
// once when the creator sells. Stakes stay tiny and spread across many coins, so no
// single coin decides the run.
//
// Guardrail pacing: the run must end with round trips of at least 0.01 SOL on at least
// 20 coins. When the bot's own filled orders or coins lag the pace set by elapsed block
// time, it opens tiny probe round trips on the most liquid curve it traded this batch
// and flips them on a small gain or a short clock.
//
// Deterministic by construction: no clock, no environment, no randomness; iteration only
// over insertion-ordered maps fed by the batch stream, and every money value is a bigint.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  /** Youngest age (slots since create) at which a coin may be bought. */
  minAge: number;
  /** Oldest age at which a first buy may still be decided. */
  maxAge: number;
  /** Creator's own buys in the opening tape: lamports window. */
  minDevBuy: number;
  maxDevBuy: number;
  /** Distinct non-creator buyers seen before entry, at least. */
  minBuyers: number;
  /** Net buy SOL (buys minus sells) in the opening tape, at least. */
  minNetSol: number;
  /** Real SOL reserve at decision time, at least. */
  minRqSol: number;
  /** SOL to put into one position. */
  stakeSol: number;
  /** Smallest buy worth sending. */
  minBuySol: number;
  /** Slippage on buys (bps); sells always go out at 10000. */
  buySlipBps: number;
  /** Take profit: sell all once value reaches cost * (1 + takeProfit). */
  takeProfit: number;
  /** Stop loss: sell all once value falls to cost * (1 - stopLoss). */
  stopLoss: number;
  /** Trailing stop arms once value reaches cost * (1 + trailArm). */
  trailArm: number;
  /** Trailing stop: sell once value falls this much below its peak. */
  trail: number;
  /** Exit after this many slots held. */
  maxHold: number;
  /** Slots to wait after an exit before the same curve may be bought again. */
  cooldown: number;
  /** Most entries per curve over the run. */
  maxEntries: number;
  /** Most sniper positions open at once (the rest of the cap is for probes). */
  maxMain: number;
  /** Most SOL at cost across all positions at once (a drawdown guard). */
  maxExposureSol: number;
  /** Guardrail pacing: target coins and fills over paceSecs of block time. */
  targetCoins: number;
  targetFills: number;
  paceSecs: number;
  /** Probe round-trip size (SOL). */
  probeSol: number;
  /** Most probes open at once. */
  maxProbes: number;
  /** Sell a probe once it is up this much, or after this many slots. */
  probeTp: number;
  probeMaxHold: number;
}

export const DEFAULT_PARAMS: Params = {
  minAge: 1,
  maxAge: 3,
  minDevBuy: 0,
  maxDevBuy: 2.5,
  minBuyers: 6,
  minNetSol: 0.05,
  minRqSol: 0.3,
  stakeSol: 0.05,
  minBuySol: 0.01,
  buySlipBps: 10_000,
  takeProfit: 0.25,
  stopLoss: 0.1,
  trailArm: 0.1,
  trail: 0.15,
  maxHold: 60,
  cooldown: 120,
  maxEntries: 1,
  maxMain: 4,
  maxExposureSol: 1,
  targetCoins: 30,
  targetFills: 300,
  paceSecs: 21_600,
  probeSol: 0.015,
  maxProbes: 1,
  probeTp: 0.06,
  probeMaxHold: 60,
};

const LAMPORTS = 1e9;
const CURVE_FEE_BPS = 125n;
const BPS = 10_000n;

interface Trade {
  slot: number;
  buy: boolean;
  sol: number;
  user: string;
}

interface Tape {
  created: number | null;
  creator: string | null;
  devSold: boolean;
  devBuy: number;
  trades: Trade[];
  entries: number;
  lastExit: number;
  done: boolean;
}

interface Held {
  opened: number;
  /** Best net value seen, in lamports. */
  peak: bigint;
  exiting: boolean;
  filled: boolean;
}

interface Probe {
  opened: number;
  selling: boolean;
}

/** Net SOL a sell of `tokens` against (vq, vt) pays, curve fees deducted (tx fee extra). */
function sellValueLamports(tokens: bigint, vq: bigint, vt: bigint): bigint {
  if (tokens <= 0n || vt <= 0n) return 0n;
  const q = (tokens * vq) / (vt + tokens);
  return q - (q * CURVE_FEE_BPS + BPS - 1n) / BPS;
}

export function createStrategy(p: Params = DEFAULT_PARAMS): Bot {
  const tapes = new Map<Pubkey, Tape>();
  const held = new Map<Pubkey, Held>();
  const probes = new Map<Pubkey, Probe>();
  let myFills = 0;
  const myCoins = new Set<Pubkey>();
  let firstTime: number | null = null;
  let lastTime: number | null = null;

  const tapeOf = (mint: Pubkey): Tape => {
    let t = tapes.get(mint);
    if (t === undefined) {
      t = { created: null, creator: null, devSold: false, devBuy: 0, trades: [], entries: 0, lastExit: -1e12, done: false };
      tapes.set(mint, t);
    }
    return t;
  };

  /** Opening-tape signal: real demand from many distinct buyers, creator not dominant. */
  const entrySignal = (t: Tape): boolean => {
    if (t.devBuy < p.minDevBuy || t.devBuy > p.maxDevBuy) return false;
    let buySol = 0;
    let sellSol = 0;
    const buyers = new Set<string>();
    for (const tr of t.trades) {
      if (tr.buy) {
        buySol += tr.sol;
        if (t.creator === null || tr.user !== t.creator) buyers.add(tr.user);
      } else sellSol += tr.sol;
    }
    if (buyers.size < p.minBuyers) return false;
    if (buySol - sellSol < p.minNetSol) return false;
    return true;
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      const traded = new Set<Pubkey>();
      for (const f of batch.fills) {
        if (f.status === 'filled' && !f.client_id.startsWith('_')) {
          myFills++;
          myCoins.add(f.mint);
        }
      }
      for (const e of batch.events) {
        if (e.block_time !== null) {
          if (firstTime === null) firstTime = e.block_time;
          if (lastTime === null || e.block_time > lastTime) lastTime = e.block_time;
        }
        if (e.event === 'CreateEvent') {
          const t = tapeOf(e.mint);
          t.created = e.slot;
          t.creator = e.creator;
        } else if (e.event === 'TradeEvent') {
          const t = tapeOf(e.mint);
          const sol = Number(e.sol_amount) / LAMPORTS;
          t.trades.push({ slot: e.slot, buy: e.is_buy, sol, user: e.user });
          traded.add(e.mint);
          if (e.is_buy && t.creator !== null && e.user === t.creator && e.slot === t.created) t.devBuy += sol;
          if (!e.is_buy && t.creator !== null && e.user === t.creator) t.devSold = true;
        } else {
          tapeOf(e.mint).done = true;
        }
      }
      const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));
      const pendingByMint = new Map<Pubkey, number>();
      for (const po of state.pending.values()) pendingByMint.set(po.order.mint, (pendingByMint.get(po.order.mint) ?? 0) + 1);

      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = Number(state.txFeeLamports()) / LAMPORTS;

      const reservesOf = (mint: Pubkey): { vq: bigint; vt: bigint; rqSol: number } | null => {
        const mk = marks.get(mint);
        if (mk !== undefined) {
          return {
            vq: BigInt(mk.virtual_quote_reserves),
            vt: BigInt(mk.virtual_token_reserves),
            rqSol: Number(mk.real_quote_reserves) / LAMPORTS,
          };
        }
        const curve = state.curves.get(mint);
        if (curve === undefined) return null;
        return {
          vq: curve.virtual_quote_reserves,
          vt: curve.virtual_token_reserves,
          rqSol: Number(curve.real_quote_reserves) / LAMPORTS,
        };
      };

      // Exits first: sniper positions.
      for (const [mint, h] of held) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) {
            held.delete(mint);
            const t = tapeOf(mint);
            if (h.filled) t.lastExit = now;
            else t.entries--;
          }
          continue;
        }
        h.filled = true;
        if (curve === undefined || curve.complete) continue;
        const r = reservesOf(mint);
        if (r === null) continue;
        const tokens = BigInt(pos.token_amount);
        const value = sellValueLamports(tokens, r.vq, r.vt) - state.txFeeLamports();
        const cost = BigInt(pos.cost_lamports);
        if (value > h.peak) h.peak = value;
        let exit = h.exiting;
        const t = tapeOf(mint);
        if (!exit && cost > 0n) {
          if (value * BPS >= cost * BigInt(Math.round((1 + p.takeProfit) * 10_000))) exit = true;
          if (value * BPS <= cost * BigInt(Math.round((1 - p.stopLoss) * 10_000))) exit = true;
          if (h.peak * BPS >= cost * BigInt(Math.round((1 + p.trailArm) * 10_000)) && value * BPS <= h.peak * BigInt(Math.round((1 - p.trail) * 10_000))) exit = true;
        }
        if (!exit && now - h.opened > p.maxHold) exit = true;
        if (!exit && t.devSold) exit = true;
        if (!exit) continue;
        h.exiting = true;
        let sellPending = false;
        for (const po of state.pending.values()) if (po.order.mint === mint && po.order.side === 'sell') sellPending = true;
        if (sellPending) continue;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
      }

      // Probe exits: flip the probe on a small gain, a small loss, or the clock.
      for (const [mint, pr] of probes) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) probes.delete(mint);
          continue;
        }
        if (curve === undefined || curve.complete || pendingByMint.has(mint)) continue;
        const r = reservesOf(mint);
        if (r === null) continue;
        const value = sellValueLamports(BigInt(pos.token_amount), r.vq, r.vt) - state.txFeeLamports();
        const cost = BigInt(pos.cost_lamports);
        let exit = false;
        if (cost > 0n) {
          if (value * BPS >= cost * BigInt(Math.round((1 + p.probeTp) * 10_000))) exit = true;
          if (value * BPS <= cost * BigInt(Math.round(0.92 * 10_000))) exit = true;
        }
        if (now - pr.opened > p.probeMaxHold) exit = true;
        if (!exit) continue;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
        pr.selling = true;
      }

      // Then entries: only coins a few slots old whose opening tape passed the filter.
      let free = Number(state.freeCashLamports()) / LAMPORTS;
      let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
      let mainLeft = p.maxMain - held.size;
      let exposure = 0;
      for (const [mint, h] of held) exposure += Number(state.positions.get(mint)?.cost_lamports ?? 0n) / LAMPORTS;
      for (const mint of traded) {
        if (orders.length >= cap) break;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (pendingByMint.has(mint) || probes.has(mint) || held.has(mint)) continue;
        const t = tapes.get(mint)!;
        if (t.done || t.created === null) continue;
        const age = now - t.created;
        if (age < p.minAge || age > p.maxAge) continue;
        if (slotsLeft <= 0 || mainLeft <= 0) continue;
        if (t.entries >= p.maxEntries || now - t.lastExit < p.cooldown) continue;
        if (!entrySignal(t)) continue;
        const r = reservesOf(mint);
        if (r === null || r.rqSol < p.minRqSol) continue;
        const capSol = Math.floor(Number(state.maxBuyLamports(mint))) / LAMPORTS;
        let amount = Math.min(capSol, p.stakeSol, p.maxExposureSol - exposure);
        if (amount > free - tx) amount = free - tx;
        if (amount < p.minBuySol) continue;
        const lamports = BigInt(Math.floor(amount * LAMPORTS));
        orders.push({ side: 'buy', mint, quote_lamports: lamports, max_slippage_bps: p.buySlipBps });
        free -= amount + tx;
        exposure += amount;
        held.set(mint, { opened: now, peak: 0n, exiting: false, filled: false });
        t.entries++;
        slotsLeft--;
        mainLeft--;
      }

      // Guardrail pacing: open a probe when the bot's fills or coins lag the pace.
      if (probes.size < p.maxProbes && slotsLeft > 0 && firstTime !== null && lastTime !== null) {
        const pace = Math.min(1, (lastTime - firstTime) / p.paceSecs);
        const needCoins = myCoins.size < Math.ceil(p.targetCoins * pace);
        const needFills = myFills < Math.ceil(p.targetFills * pace);
        if (needCoins || needFills) {
          const minRq = (p.probeSol * Number(BPS)) / state.hello.caps.max_order_bps_of_real_reserve;
          for (const mint of traded) {
            if (orders.length >= cap || probes.size >= p.maxProbes) break;
            if (held.has(mint) || probes.has(mint) || pendingByMint.has(mint) || state.positions.has(mint)) continue;
            if (needCoins && !needFills && myCoins.has(mint)) continue;
            const curve = state.curves.get(mint);
            if (curve === undefined || curve.complete) continue;
            if (Number(curve.real_quote_reserves) / LAMPORTS < minRq * 1.5) continue;
            if (free < p.probeSol + 2 * tx) break;
            orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(p.probeSol * LAMPORTS)), max_slippage_bps: p.buySlipBps });
            probes.set(mint, { opened: now, selling: false });
            free -= p.probeSol + tx;
          }
        }
      }
      return orders;
    },
  };
}
