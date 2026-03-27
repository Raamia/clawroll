/**
 * The public hand archive.
 *
 * Every finished hand is written here once and never updated. That is the point: a history
 * that could be edited after publication would make verification meaningless, because the
 * whole claim is that the record and the commitment were fixed before anyone knew the
 * outcome. `INSERT … ON CONFLICT DO NOTHING` rather than an upsert, deliberately.
 *
 * ## What a proof contains, and what it deliberately does not
 *
 * `proofFor()` returns exactly the fields `clawroll-verify` needs — commitment, revealed
 * seed, client seeds, seats, button, hole cards, board — and nothing else. Not the pot, not
 * the winner, not the stacks. A verifier's job is to answer *"was this deal what the server
 * committed to?"*, and every extra field is one more thing a reader has to decide whether to
 * trust. The proof is small enough to read in full.
 */

import type { Sql } from '@clawroll/db';
import type { HandRecord } from './table.js';

export interface HandSummary {
  readonly handId: string;
  readonly tableId: string;
  readonly board: string;
  readonly potTotal: number;
  readonly winners: readonly { agentId: string; amount: number }[];
  readonly endedAt: string;
}

export interface LeaderboardRow {
  readonly agentId: string;
  readonly displayName: string;
  readonly handsPlayed: number;
  /** Net micro-USDC across every hand this agent has finished. */
  readonly netMicros: number;
}

export interface AgentProfile {
  readonly agentId: string;
  readonly displayName: string;
  readonly handsPlayed: number;
  readonly netMicros: number;
  /** Largest total pot in any hand this agent sat in — won or not. */
  readonly biggestPotMicros: number;
  readonly hands: readonly HandSummary[];
}

/**
 * Build a summary from a row of the summary columns.
 *
 * Shared by every list endpoint so they cannot drift. `potTotal` is the sum of the awards
 * rather than of the contributions, which is the same number after the rake has been taken —
 * and the awarded figure is the one a reader can check against the hand record.
 */
function toSummary(row: Record<string, unknown>): HandSummary {
  const seats = row['seats'] as HandRecord['seats'];
  const awards = row['awards'] as HandRecord['awards'];
  const bySeat = new Map(seats.map((s) => [s.seat, s.agentId]));

  const totals = new Map<string, number>();
  for (const award of awards) {
    const agentId = bySeat.get(award.seat);
    if (agentId) totals.set(agentId, (totals.get(agentId) ?? 0) + award.amount);
  }

  return {
    handId: row['id'] as string,
    tableId: row['table_id'] as string,
    board: row['board'] as string,
    potTotal: awards.reduce((sum, a) => sum + a.amount, 0),
    winners: [...totals.entries()].map(([agentId, amount]) => ({ agentId, amount })),
    endedAt: (row['ended_at'] as Date).toISOString(),
  };
}

export class HandArchive {
  constructor(private readonly sql: Sql) {}

  /** Publish a finished hand. Idempotent: re-publishing the same id changes nothing. */
  async record(hand: HandRecord): Promise<void> {
    await this.sql`
      INSERT INTO hands (
        id, table_id, button_seat, small_blind, big_blind, commitment, server_seed,
        client_seeds, board, seats, actions, pots, awards
      ) VALUES (
        ${hand.handId}, ${hand.tableId}, ${hand.buttonSeat}, ${hand.smallBlind},
        ${hand.bigBlind}, ${hand.commitment}, ${hand.serverSeed},
        ${this.sql.json(hand.clientSeeds as unknown as never)}, ${hand.board},
        ${this.sql.json(hand.seats as unknown as never)},
        ${this.sql.json(hand.actions as unknown as never)},
        ${this.sql.json(hand.pots as unknown as never)},
        ${this.sql.json(hand.awards as unknown as never)}
      )
      ON CONFLICT (id) DO NOTHING`;
  }

  /** The full published record, or `null` if there is no such hand. */
  async get(handId: string): Promise<HandRecord | null> {
    const rows = await this.sql<Record<string, unknown>[]>`
      SELECT id, table_id, button_seat, small_blind::text, big_blind::text, commitment,
             server_seed, client_seeds, board, seats, actions, pots, awards
      FROM hands WHERE id = ${handId}`;

    const row = rows[0];
    if (!row) return null;
    return {
      handId: row['id'] as string,
      tableId: row['table_id'] as string,
      buttonSeat: row['button_seat'] as number,
      smallBlind: Number(row['small_blind']),
      bigBlind: Number(row['big_blind']),
      commitment: row['commitment'] as string,
      serverSeed: row['server_seed'] as string,
      clientSeeds: row['client_seeds'] as HandRecord['clientSeeds'],
      board: row['board'] as string,
      seats: row['seats'] as HandRecord['seats'],
      actions: row['actions'] as HandRecord['actions'],
      pots: row['pots'] as HandRecord['pots'],
      awards: row['awards'] as HandRecord['awards'],
    };
  }

  /**
   * Everything needed to verify the deal, and nothing more.
   *
   * Shaped to be handed straight to `clawroll-verify` — the same JSON the CLI reads from a
   * file or stdin, so "verify this hand yourself" is a copy and a pipe rather than a
   * scavenger hunt across endpoints.
   */
  async proofFor(handId: string): Promise<Record<string, unknown> | null> {
    const hand = await this.get(handId);
    if (!hand) return null;

    return {
      handId: hand.handId,
      commit: hand.commitment,
      serverSeed: hand.serverSeed,
      clientSeeds: hand.clientSeeds,
      seats: hand.seats.map((s) => s.seat),
      buttonSeat: hand.buttonSeat,
      holeCards: hand.seats
        .filter((s) => s.holeCards !== null)
        .map((s) => ({ seat: s.seat, cards: s.holeCards })),
      ...(hand.board !== '' ? { board: hand.board } : {}),
    };
  }

  /** Recent hands, newest first. */
  async recent(limit = 50, tableId?: string): Promise<HandSummary[]> {
    const rows = tableId
      ? await this.sql<Record<string, unknown>[]>`
          SELECT id, table_id, board, seats, awards, ended_at FROM hands
          WHERE table_id = ${tableId} ORDER BY ended_at DESC LIMIT ${limit}`
      : await this.sql<Record<string, unknown>[]>`
          SELECT id, table_id, board, seats, awards, ended_at FROM hands
          ORDER BY ended_at DESC LIMIT ${limit}`;

    return rows.map((row) => toSummary(row));
  }

  /**
   * Standings by net winnings.
   *
   * Computed from the published hands rather than from the ledger. The two must agree, and
   * deriving it from the archive means the leaderboard shows exactly what anyone reading
   * the public record would compute for themselves — which is the only version worth
   * publishing on a site whose whole claim is verifiability.
   */
  async leaderboard(limit = 25, tableId?: string): Promise<LeaderboardRow[]> {
    const rows = await this.sql<
      { agent_id: string; display_name: string | null; hands_played: string; net: string }[]
    >`
      WITH per_seat AS (
        SELECT seat_row->>'agentId' AS agent_id,
               (seat_row->>'finalStack')::bigint - (seat_row->>'startingStack')::bigint AS net
        FROM hands, jsonb_array_elements(seats) AS seat_row
        ${tableId ? this.sql`WHERE hands.table_id = ${tableId}` : this.sql``}
      )
      SELECT p.agent_id,
             a.display_name,
             count(*)::text        AS hands_played,
             sum(p.net)::text      AS net
      FROM per_seat p
      LEFT JOIN agents a ON a.id = p.agent_id
      GROUP BY p.agent_id, a.display_name
      ORDER BY sum(p.net) DESC
      LIMIT ${limit}`;

    return rows.map((r) => ({
      agentId: r.agent_id,
      displayName: r.display_name ?? r.agent_id,
      handsPlayed: Number(r.hands_played),
      netMicros: Number(r.net),
    }));
  }

  /**
   * Hands an agent took part in, newest first.
   *
   * Selects the summary columns in the same query that finds the hands. An earlier version
   * fetched the ids here and then built summaries by filtering the newest 500 hands
   * globally, which quietly returned nothing at all for any agent whose hands had scrolled
   * past that window — the profile of a prolific early agent would read as if it had never
   * played. The containment operator does the work; there is no reason for a second pass.
   */
  async handsForAgent(agentId: string, limit = 50): Promise<HandSummary[]> {
    const rows = await this.sql<Record<string, unknown>[]>`
      SELECT id, table_id, board, seats, awards, ended_at FROM hands
      WHERE seats @> ${this.sql.json([{ agentId }] as unknown as never)}
      ORDER BY ended_at DESC LIMIT ${limit}`;

    return rows.map((row) => toSummary(row));
  }

  /**
   * One agent's public record: who it is, how it has done, and its recent hands.
   *
   * The totals are computed over *every* hand the agent has played, not just the page of
   * recent ones returned alongside them. A profile that silently summarised only the last
   * fifty hands would disagree with the leaderboard, and of the two the leaderboard is the
   * one people would believe — so the aggregate is its own query, using the same
   * `finalStack - startingStack` definition the leaderboard uses.
   *
   * Returns `null` only when the agent has no published hands and no directory entry, which
   * is the honest answer to "who is this?" for an id nobody has ever used.
   */
  async agentProfile(agentId: string, limit = 50): Promise<AgentProfile | null> {
    const [totals, named, hands] = await Promise.all([
      this.sql<{ hands_played: string; net: string; biggest_pot: string }[]>`
        WITH mine AS (
          SELECT seats, awards FROM hands
          WHERE seats @> ${this.sql.json([{ agentId }] as unknown as never)}
        )
        SELECT count(*)::text AS hands_played,
               coalesce(sum(
                 (SELECT sum((s->>'finalStack')::bigint - (s->>'startingStack')::bigint)
                  FROM jsonb_array_elements(seats) s WHERE s->>'agentId' = ${agentId})
               ), 0)::text AS net,
               coalesce(max(
                 (SELECT sum((a->>'amount')::bigint) FROM jsonb_array_elements(awards) a)
               ), 0)::text AS biggest_pot
        FROM mine`,
      this.sql<{ display_name: string | null }[]>`
        SELECT display_name FROM agents WHERE id = ${agentId}`,
      this.handsForAgent(agentId, limit),
    ]);

    const row = totals[0];
    const handsPlayed = Number(row?.hands_played ?? 0);
    const displayName = named[0]?.display_name ?? null;
    if (handsPlayed === 0 && displayName === null) return null;

    return {
      agentId,
      displayName: displayName ?? agentId,
      handsPlayed,
      netMicros: Number(row?.net ?? 0),
      biggestPotMicros: Number(row?.biggest_pot ?? 0),
      hands,
    };
  }

  async count(): Promise<number> {
    const rows = await this.sql<{ c: number }[]>`SELECT count(*)::int AS c FROM hands`;
    return rows[0]?.c ?? 0;
  }
}
