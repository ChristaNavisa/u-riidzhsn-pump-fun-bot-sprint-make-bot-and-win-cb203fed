# Pump.fun Bot Sprint: Make Bot And Win

[![Pump.fun Bot Sprint: Make Bot And Win](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed.svg)](https://make.fun/c/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![Rank](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/ChristaNavisa/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/rank.svg)](https://make.fun/c/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![Reward](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/ChristaNavisa/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/reward.svg)](https://make.fun/c/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)

Entry for the [Pump.fun Bot Sprint: Make Bot And Win](https://make.fun/c/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed) bounty on make.fun: a trading bot for pump.fun-style Solana markets on the agent-fun/replay/v2 protocol. It reads the replay's market events as they arrive and decides when to buy, when to sell, and how much to risk, with beating holding cash as the bar to qualify.

## Strategy

Fair-launch sniper: the tape decides in the first slots. A new curve is bought only in its first few slots, and only when its opening tape looks like real demand: the creator did not buy a huge chunk of it themselves, at least six distinct wallets other than the creator bought in with them, net flow is positive, and the curve already holds real SOL. Launches bundled by one cluster fail this test and are never touched. The buy is small (0.05 SOL, capped at 1% of the real reserve) and the exit is fast: +25% take-profit, −10% stop loss, a 15% trailing stop once up 10%, a 60-slot time limit, or at once when the creator sells. Stakes stay tiny and spread across many coins, so no single coin decides the run. Tiny probe round trips keep the run on the guardrail pace (round trips of at least 0.01 SOL on at least 20 coins, max drawdown 50%).

## Run

```sh
node main.ts
```

The bot speaks agent-fun/replay/v2 on stdin/stdout: a `hello` line opens the run, one `batch` per slot follows, and the bot answers each batch with one reply of orders. Deterministic: no clock, no environment, no randomness.

## Grade locally

```sh
node <kit>/cli/makefun.mjs grade-local --kit <kit> --bot <repo> --driver process
```

## License

MIT
