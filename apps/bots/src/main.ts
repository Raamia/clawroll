#!/usr/bin/env node
/**
 * The house bots, kept permanently seated.
 *
 * A poker room worth opening when you are bored has to have a game running when you get
 * there. This process connects a fixed roster of agents and keeps them playing — it is what
 * turns a deployed engine into a room.
 *
 * ## Why it is a separate process from the engine
 *
 * The engine is the dealer and must stay impartial: if it also decided how the players bet,
 * "the house runs the bots" would stop being a description of who pays for the compute and
 * start being a reason to distrust every hand. Keeping the bots on the far side of the same
 * public WebSocket any stranger uses means they have exactly the information a stranger's
 * bot would, and no more. That is worth a container.
 *
 * It also means the fleet can be restarted, rewritten or switched off without touching the
 * dealer, which matters when the dealer is holding live hands.
 *
 * ## Credentials
 *
 * `BOT_KEYS` is a comma-separated list of `tableId:apiKey`. Keys are secrets, so in a
 * deployed room they live in Secrets Manager and this process **fetches them at runtime**
 * rather than having ECS inject them.
 *
 * That is not a stylistic choice. ECS resolves `secrets:` *before* starting a container, and
 * the secret is created empty — the bots do not exist until the room they play in has been
 * deployed and they have been registered against it. Injecting it would mean the container
 * could never start on a first deploy, its circuit breaker would trip, and CloudFormation
 * would roll the whole stack back. That exact circular dependency cost three deploys on the
 * master seed before it was understood; this is the same shape and takes the same way out.
 */

import { ClawrollAgent, type Decision, type Situation } from 'clawroll';

const USDC = 1_000_000;

/** Distinct personalities, because five identical bots produce five identical folds. */
const STRATEGIES: { readonly name: string; readonly act: (s: Situation) => Decision }[] = [
  {
    name: 'rock',
    // Folds a lot, so the pots it does play mean something.
    act: ({ legal, pot }) => {
      if (legal.canCheck) return { action: 'check' };
      if (legal.canCall && legal.callAmount <= pot / 6) return { action: 'call' };
      return { action: 'fold' };
    },
  },
  {
    name: 'station',
    // Calls almost anything. Loses slowly, keeps hands alive to the river.
    act: ({ legal, pot }) => {
      if (legal.canCheck) return { action: 'check' };
      if (legal.canCall && legal.callAmount <= pot) return { action: 'call' };
      return { action: 'fold' };
    },
  },
  {
    name: 'raiser',
    // Builds pots. Without at least one of these a table is mostly checked-down blinds.
    act: ({ legal, pot, street }) => {
      if (legal.canBet && pot > 0) return { action: 'bet', amount: legal.minRaiseTo };
      if (legal.canRaise && street !== 'preflop' && pot > USDC / 2) {
        return { action: 'raise', amount: legal.minRaiseTo };
      }
      if (legal.canCheck) return { action: 'check' };
      if (legal.canCall && legal.callAmount <= pot / 2) return { action: 'call' };
      return { action: 'fold' };
    },
  },
  {
    name: 'maniac',
    // Occasionally shoves. Provides the hands that are actually fun to watch.
    act: ({ legal, pot, seat }) => {
      // Deterministic per seat and pot rather than random: a bot whose decisions cannot be
      // reproduced from the published hand is a bot nobody can check.
      const aggressive = (pot + seat) % 5 === 0;
      if (aggressive && legal.canRaise) return { action: 'raise', amount: legal.maxRaiseTo };
      if (aggressive && legal.canBet) return { action: 'bet', amount: legal.minRaiseTo * 3 };
      if (legal.canCheck) return { action: 'check' };
      if (legal.canCall && legal.callAmount <= pot) return { action: 'call' };
      return { action: 'fold' };
    },
  },
  {
    name: 'grinder',
    // Plays position and pot odds, roughly. The closest thing here to a real strategy.
    act: ({ legal, pot, board, street }) => {
      const seenBoard = board.split(' ').filter(Boolean).length;
      if (legal.canBet && seenBoard >= 3) return { action: 'bet', amount: legal.minRaiseTo };
      if (legal.canCheck) return { action: 'check' };
      const price = street === 'preflop' ? pot / 3 : pot / 2;
      if (legal.canCall && legal.callAmount <= price) return { action: 'call' };
      return { action: 'fold' };
    },
  },
];

interface Seat {
  readonly tableId: string;
  readonly apiKey: string;
}

function parseSeats(raw: string): Seat[] {
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const at = entry.indexOf(':');
      if (at < 1) throw new Error(`BOT_KEYS entries look like "tableId:apiKey", got "${entry}"`);
      return { tableId: entry.slice(0, at), apiKey: entry.slice(at + 1) };
    });
}

/**
 * The roster, waiting for it if it has not been written yet.
 *
 * An unset secret is a normal state between deploying the room and registering the bots that
 * play in it, so it is something to sit in rather than fail on.
 */
async function loadSeats(): Promise<Seat[]> {
  const direct = process.env['BOT_KEYS'];
  if (direct) return parseSeats(direct);

  const secretArn = process.env['BOT_KEYS_SECRET_ARN'];
  if (!secretArn) throw new Error('either BOT_KEYS or BOT_KEYS_SECRET_ARN must be set');

  // Imported lazily so local runs never load the AWS SDK at all.
  const { SecretsManagerClient, GetSecretValueCommand } = await import(
    '@aws-sdk/client-secrets-manager'
  );
  const client = new SecretsManagerClient({});

  for (let attempt = 0; ; attempt++) {
    try {
      const { SecretString } = await client.send(new GetSecretValueCommand({ SecretId: secretArn }));
      if (SecretString && SecretString.trim() !== '') return parseSeats(SecretString);
    } catch (error) {
      // A secret with no version raises ResourceNotFoundException, which is exactly the
      // freshly-deployed state. Anything else is real.
      if ((error as { name?: string }).name !== 'ResourceNotFoundException') throw error;
    }
    console.log(
      `[fleet] no bot keys yet (attempt ${attempt + 1}). Waiting. Register bots, then put ` +
        `"tableId:apiKey,…" in ${secretArn}`,
    );
    await new Promise((r) => setTimeout(r, 20_000));
  }
}

async function main(): Promise<void> {
  const url = process.env['CLAWROLL_URL'];
  if (!url) throw new Error('CLAWROLL_URL must be set');

  const seats = await loadSeats();
  const buyIn = Number(process.env['BOT_BUY_IN_MICROS'] ?? 5 * USDC);
  // Above this stack a bot stands up, banks the excess, and sits back down at `buyIn`.
  //
  // Without it the room has a terminal state. Chips on a table can only leave it when the
  // player does, and the rebalancer moves spendable balance only — so a bot that keeps
  // winning and never stands up ends up holding everything, on a table where nothing can
  // reach it, while every other bot sits benched unable to afford a seat. That is exactly
  // where the deployed room ended up: one bot with 126 of 200 USDC on `main`, one other bot
  // still seated with it. Banking is what turns a winning streak back into circulation.
  const bankAbove = Number(process.env['BOT_BANK_ABOVE_MICROS'] ?? 4 * buyIn);
  console.log(`[fleet] seating ${seats.length} bot(s) at ${url}`);

  await Promise.all(
    seats.map(async (seat, i) => {
      const strategy = STRATEGIES[i % STRATEGIES.length]!;
      const label = `${strategy.name}@${seat.tableId}`;
      try {
        // Constructed rather than `play()`ed so the hand-end callback can reach the agent.
        let agent: ClawrollAgent | null = null;
        agent = new ClawrollAgent({
          url,
          apiKey: seat.apiKey,
          tableId: seat.tableId,
          buyIn,
          // Effectively endless. The point is a table that is never empty, and a bot that
          // stops re-buying is a seat that stays empty until someone notices.
          rebuys: 1_000_000,
          act: strategy.act,
          onHandEnd: ({ net, stack }) => {
            // Only the hands that moved something, or the log is mostly blinds.
            if (Math.abs(net) >= USDC / 10) {
              console.log(
                `[fleet] ${label} ${net > 0 ? '+' : ''}${(net / USDC).toFixed(2)} → ${(stack / USDC).toFixed(2)}`,
              );
            }
            if (stack >= bankAbove) {
              console.log(`[fleet] ${label} banking ${(stack / USDC).toFixed(2)}`);
              agent?.leaveTable();
            }
          },
          onWarning: (message) => console.warn(`[fleet] ${label}: ${message}`),
        });
        await agent.connect();
        console.log(`[fleet] ${label} seated`);
      } catch (error) {
        // One bot failing to connect must not take the rest of the table down with it.
        console.error(`[fleet] ${label} could not start: ${(error as Error).message}`);
      }
    }),
  );

  console.log('[fleet] all bots connected; playing');

  // The SDK reconnects on its own, so there is nothing to do but stay alive. An explicit
  // interval rather than relying on open sockets to hold the loop: if every bot somehow
  // disconnected for good, the process should keep running and keep retrying rather than
  // exit quietly and leave ECS to guess whether that was success.
  setInterval(() => {}, 1 << 30);
}

main().catch((error: Error) => {
  console.error(`[fleet] fatal: ${error.message}`);
  process.exit(1);
});
