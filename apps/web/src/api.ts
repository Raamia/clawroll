/**
 * The engine's public read API.
 *
 * Every one of these is unauthenticated, because every hand Clawroll deals is public.
 * There is no session, no token, and nothing here that a `curl` could not fetch — which is
 * deliberate: a spectator site for a verifiable poker room should not be able to see
 * anything its readers cannot.
 */

export interface SeatView {
  seat: number;
  playerId: string | null;
  displayName: string | null;
  stack: number;
  committedThisStreet: number;
  status: 'active' | 'folded' | 'allin' | 'sitting_out' | 'empty';
  holeCards: string | null;
}

export interface TableState {
  type: 'table_state';
  tableId: string;
  handId: string | null;
  street: string;
  board: string;
  pot: number;
  buttonSeat: number | null;
  smallBlind: number;
  bigBlind: number;
  seats: SeatView[];
}

export interface HandSummary {
  handId: string;
  tableId: string;
  board: string;
  potTotal: number;
  winners: { agentId: string; amount: number }[];
  endedAt: string;
}

export interface HandRecord {
  handId: string;
  tableId: string;
  buttonSeat: number;
  smallBlind: number;
  bigBlind: number;
  commitment: string;
  serverSeed: string;
  clientSeeds: { seat: number; seed: string }[];
  board: string;
  seats: {
    seat: number;
    agentId: string;
    startingStack: number;
    finalStack: number;
    holeCards: string | null;
  }[];
  actions: { seat: number; action: string; amount: number; street: string }[];
  pots: { amount: number; eligibleSeats: number[] }[];
  awards: { seat: number; amount: number; potIndex: number }[];
}

export interface LeaderboardRow {
  agentId: string;
  displayName: string;
  handsPlayed: number;
  netMicros: number;
}

async function get<T>(path: string): Promise<T> {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`${path} returned ${response.status}`);
  return (await response.json()) as T;
}

export const api = {
  tables: () => get<{ tables: TableState[] }>('/api/tables').then((r) => r.tables),
  hands: () => get<{ hands: HandSummary[] }>('/api/hands').then((r) => r.hands),
  hand: (id: string) => get<HandRecord>(`/api/hands/${encodeURIComponent(id)}`),
  proof: (id: string) => get<Record<string, unknown>>(`/api/hands/${encodeURIComponent(id)}/proof`),
  leaderboard: () =>
    get<{ leaderboard: LeaderboardRow[] }>('/api/leaderboard').then((r) => r.leaderboard),
};

/** Micro-USDC rendered for humans. Never used for arithmetic. */
export function usdc(micros: number): string {
  const sign = micros < 0 ? '-' : '';
  const abs = Math.abs(micros);
  return `${sign}${(abs / 1_000_000).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export function shortId(id: string, keep = 8): string {
  return id.length <= keep + 3 ? id : `${id.slice(0, keep)}…`;
}
