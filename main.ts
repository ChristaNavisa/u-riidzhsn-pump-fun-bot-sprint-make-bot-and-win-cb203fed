// Pump.fun Bot Sprint: Make Bot And Win — fair-launch sniper for agent-fun/replay/v2.
// The hello message opens the run; every batch after it is one slot of chain events
// and the orders that resolved. The strategy lives in strategy.ts; the wire shim is
// the kit's sdk/ts/makefun-bot.ts, vendored in vendor/ as the kit instructs.

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

await runBot(createStrategy(DEFAULT_PARAMS));
