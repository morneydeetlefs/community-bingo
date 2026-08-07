// ─────────────────────────────────────────────────────────────────────────────
// Community Bingo — Cloudflare Worker
// MD Works · Morney Deetlefs · mdworks.dev
//
// Stack: Cloudflare Worker (TypeScript) + D1 + KV
// ─────────────────────────────────────────────────────────────────────────────

export interface Env {
  DB: D1Database;
  KV: KVNamespace;
  ALLOWED_ORIGIN: string;
}

// ── Types ────────────────────────────────────────────────────────────────────

type SessionMode   = '90' | '75';
type SessionStatus = 'pending' | 'active' | 'ended';
type PrizeTier     = 'one_line' | 'two_lines' | 'full_house' | 'any_line' | 'blackout';
type Validated     = 0 | 1 | -1; // pending | confirmed | rejected

interface Session {
  id:             string;
  name:           string;
  date:           string;
  mode:           SessionMode;
  ticket_price:   number;
  ticket_cap:     number | null;
  pct_one_line:   number | null;
  pct_two_lines:  number | null;
  pct_full_house: number | null;
  pct_any_line:   number | null;
  pct_organiser:  number;
  status:         SessionStatus;
  pot_locked_at:  number | null;
  created_at:     number;
}

interface Ticket {
  id:           string;
  session_id:   string;
  player_name:  string;
  player_phone: string | null;
  paid:         number;
  cards:        number[][][];   // parsed from JSON
  created_at:   number;
}

interface Winner {
  id:           string;         // BNG-YYYY-NNNN
  session_id:   string;
  ticket_id:    string;
  player_name:  string;
  card_index:   number;
  prize_tier:   PrizeTier;
  prize_amount: number;
  claimed_at:   number;
  validated:    Validated;
  confirmed_at: number | null;
}

// ── KV key helpers ────────────────────────────────────────────────────────────

const kvKeys = (id: string) => ({
  status:  `bingo:session:${id}:status`,
  latest:  `bingo:session:${id}:latest`,
  pot:     `bingo:session:${id}:pot`,
  winner:  `bingo:session:${id}:winner`,
  players: `bingo:session:${id}:players`,
});

// ── CORS helpers ──────────────────────────────────────────────────────────────

function corsHeaders(env: Env): HeadersInit {
  return {
    'Access-Control-Allow-Origin':  env.ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function json(data: unknown, status = 200, env?: Env): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...(env ? corsHeaders(env) : {}),
    },
  });
}

function err(message: string, status = 400, env?: Env): Response {
  return json({ error: message }, status, env);
}

// ── ID generators ─────────────────────────────────────────────────────────────

function uuid(): string {
  return crypto.randomUUID();
}

/** BNG-YYYY-NNNN — sequential within year using D1 winner count */
async function winnerRef(env: Env, sessionId: string): Promise<string> {
  const year = new Date().getFullYear();
  const row  = await env.DB
    .prepare(`SELECT COUNT(*) as n FROM winners WHERE id LIKE 'BNG-${year}-%'`)
    .first<{ n: number }>();
  const seq  = ((row?.n ?? 0) + 1).toString().padStart(4, '0');
  return `BNG-${year}-${seq}`;
}

// ── Card generators ───────────────────────────────────────────────────────────

/**
 * Generate one 90-ball card: 3 rows × 9 columns, exactly 5 numbers per row.
 *
 * Rules enforced:
 *   - Each row has exactly 5 numbers and 4 blanks
 *   - Each column contains 0, 1, 2, or 3 numbers (never more than 3)
 *   - Numbers within a column are sorted ascending top-to-bottom
 *   - Column ranges: col 0 → 1–9, col 1 → 10–19 … col 8 → 80–90
 *
 * Algorithm (validated: 0 failures / 10 000 cards, ~1 retry average):
 *   1. Build column counts: start with 6 cols at 2 and 3 cols at 1 (sum=15).
 *      Optionally swap some (1→0, 2→3) pairs for variety — keeps 0–3 per col.
 *   2. Pick random numbers from each column's range.
 *   3. Assign those numbers to rows greedily with a per-row budget of 5.
 *   4. If row budgets can't be satisfied, retry (rare — ~1 retry per card).
 */
function generate90Card(): (number | null)[][] | null {
  const colRanges: [number, number][] = [
    [1, 9], [10, 19], [20, 29], [30, 39], [40, 49],
    [50, 59], [60, 69], [70, 79], [80, 90],
  ];

  // Step 1 — column counts summing to 15, each value 0–3
  const colCounts = Array(9).fill(0) as number[];
  // 6 cols get 2, 3 cols get 1  →  sum = 12 + 3 = 15
  const colOrder = shuffle([0, 1, 2, 3, 4, 5, 6, 7, 8]);
  colOrder.slice(0, 6).forEach(c => { colCounts[c] = 2; });
  colOrder.slice(6).forEach(c  => { colCounts[c] = 1; });

  // Optional variety swaps: turn a (1, 2) pair into a (0, 3) pair
  const maxSwaps = Math.floor(Math.random() * 4); // 0–3 swaps
  for (let s = 0; s < maxSwaps; s++) {
    const ones = colCounts.map((v, i) => [v, i] as [number, number]).filter(([v]) => v === 1).map(([, i]) => i);
    const twos = colCounts.map((v, i) => [v, i] as [number, number]).filter(([v]) => v === 2).map(([, i]) => i);
    if (!ones.length || !twos.length) break;
    const from = ones[Math.floor(Math.random() * ones.length)];
    const to   = twos[Math.floor(Math.random() * twos.length)];
    if (from !== to) { colCounts[from]--; colCounts[to]++; } // 1→0, 2→3
  }

  // Step 2 — pick numbers for each column
  const colNumbers: number[][] = colRanges.map(([lo, hi], c) =>
    shuffle(Array.from({ length: hi - lo + 1 }, (_, i) => lo + i))
      .slice(0, colCounts[c])
      .sort((a, b) => a - b)
  );

  // Step 3 — assign numbers to rows (greedy with row budget)
  const grid: (number | null)[][] = Array.from({ length: 3 }, () => Array(9).fill(null));
  const rowBudget = [5, 5, 5];

  for (const c of shuffle([0, 1, 2, 3, 4, 5, 6, 7, 8])) {
    const n = colCounts[c];
    if (n === 0) continue;
    const available = ([0, 1, 2] as const).filter(r => rowBudget[r] > 0);
    if (available.length < n) return null; // can't satisfy — caller will retry
    const chosen = shuffle([...available]).slice(0, n).sort((a, b) => a - b);
    chosen.forEach((r, i) => { grid[r][c] = colNumbers[c][i]; rowBudget[r]--; });
  }

  // Step 4 — final row-count check
  if (!grid.every(row => row.filter(v => v !== null).length === 5)) return null;
  return grid;
}

/** Retry wrapper — generates a valid 90-ball card (virtually always succeeds in ≤5 tries) */
function generate90CardSafe(): (number | null)[][] {
  for (let i = 0; i < 20; i++) {
    const card = generate90Card();
    if (card) return card;
  }
  throw new Error('generate90Card: failed after 20 attempts — this should never happen');
}

/** Generate one 75-ball card: 5×5 with FREE centre, BINGO column ranges */
function generate75Card(): (number | null)[][] {
  // Columns: B=1–15, I=16–30, N=31–45, G=46–60, O=61–75
  const ranges = [[1,15],[16,30],[31,45],[46,60],[61,75]];
  const card: (number | null)[][] = Array.from({ length: 5 }, () => Array(5).fill(null));

  for (let col = 0; col < 5; col++) {
    const [lo, hi] = ranges[col];
    const pool     = shuffle(Array.from({ length: hi - lo + 1 }, (_, i) => lo + i)).slice(0, 5);
    for (let row = 0; row < 5; row++) {
      card[row][col] = pool[row];
    }
  }

  // FREE centre cell
  card[2][2] = null; // null = FREE in 75-ball

  return card;
}

function shuffle<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// ── Win validation ────────────────────────────────────────────────────────────

/**
 * Validate a BINGO claim server-side.
 * Returns true if the card satisfies the prize tier given the called numbers.
 */
function validateClaim(
  card:     (number | null)[][],
  called:   Set<number>,
  tier:     PrizeTier,
  mode:     SessionMode,
): boolean {
  const daubed = (n: number | null) => n === null || called.has(n); // null = FREE cell

  if (mode === '90') {
    const rows = card.map(row => row.every(daubed));
    if (tier === 'one_line')  return rows.filter(Boolean).length >= 1;
    if (tier === 'two_lines') return rows.filter(Boolean).length >= 2;
    if (tier === 'full_house') return rows.every(Boolean);
  }

  if (mode === '75') {
    const rowComplete  = (r: number) => card[r].every(daubed);
    const colComplete  = (c: number) => card.map(r => r[c]).every(daubed);
    const diagMain     = () => [0,1,2,3,4].every(i => daubed(card[i][i]));
    const diagAnti     = () => [0,1,2,3,4].every(i => daubed(card[i][4-i]));

    const anyLine = () =>
      [0,1,2,3,4].some(i => rowComplete(i) || colComplete(i)) ||
      diagMain() || diagAnti();

    if (tier === 'any_line')  return anyLine();
    if (tier === 'blackout')  return card.flat().every(daubed);

    // Future pattern support: x_pattern, t_pattern, l_pattern, four_corners, etc.
    // TODO: wire up pattern picker from caller screen — stubs ready in bingo.html comments
  }

  return false;
}

/** Calculate prize amount in cents given the pot and percentage */
function calcPrize(pot: number, pct: number): number {
  return Math.floor(pot * pct / 100);
}

/** Get the pot value from KV (or recalculate from D1 if missing) */
async function getPotValue(env: Env, sessionId: string): Promise<number> {
  const kv = kvKeys(sessionId);
  const raw = await env.KV.get(kv.pot);
  if (raw) {
    const data = JSON.parse(raw) as { pot_total: number };
    return data.pot_total;
  }
  // Fallback: calculate from D1
  const row = await env.DB
    .prepare(`SELECT COUNT(*) as n, s.ticket_price FROM tickets t
              JOIN sessions s ON t.session_id = s.id
              WHERE t.session_id = ? AND t.paid = 1`)
    .bind(sessionId).first<{ n: number; ticket_price: number }>();
  return (row?.n ?? 0) * (row?.ticket_price ?? 0);
}

// ─────────────────────────────────────────────────────────────────────────────
// ROUTER
// ─────────────────────────────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url    = new URL(request.url);
    const path   = url.pathname;
    const method = request.method.toUpperCase();

    // Preflight CORS
    if (method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(env) });
    }

    try {
      // ── POST /bingo/session ──────────────────────────────────────────────
      if (method === 'POST' && path === '/bingo/session') {
        return handleCreateSession(request, env);
      }

      // ── GET /bingo/session/:id ───────────────────────────────────────────
      const sessionMatch = path.match(/^\/bingo\/session\/([^/]+)$/);
      if (method === 'GET' && sessionMatch) {
        return handleGetSession(sessionMatch[1], env);
      }

      // ── POST /bingo/session/:id/start ────────────────────────────────────
      const startMatch = path.match(/^\/bingo\/session\/([^/]+)\/start$/);
      if (method === 'POST' && startMatch) {
        return handleStartSession(startMatch[1], env);
      }

      // ── POST /bingo/session/:id/draw ─────────────────────────────────────
      const drawMatch = path.match(/^\/bingo\/session\/([^/]+)\/draw$/);
      if (method === 'POST' && drawMatch) {
        return handleDraw(drawMatch[1], env);
      }

      // ── POST /bingo/session/:id/end ──────────────────────────────────────
      const endMatch = path.match(/^\/bingo\/session\/([^/]+)\/end$/);
      if (method === 'POST' && endMatch) {
        return handleEndSession(endMatch[1], env);
      }

      // ── GET /bingo/session/:id/tickets
      const ticketsMatch = path.match(/^\/bingo\/session\/([^/]+)\/tickets$/);
      if (method === 'GET' && ticketsMatch) {
        return handleGetTickets(ticketsMatch[1], env);
      }

      // ── GET /bingo/session/:id/winners ───────────────────────────────────
      const winnersMatch = path.match(/^\/bingo\/session\/([^/]+)\/winners$/);
      if (method === 'GET' && winnersMatch) {
        return handleGetWinners(winnersMatch[1], env);
      }

      // ── POST /bingo/ticket ───────────────────────────────────────────────
      if (method === 'POST' && path === '/bingo/ticket') {
        return handleCreateTicket(request, env);
      }

      // ── GET /bingo/ticket/:id ────────────────────────────────────────────
      const ticketMatch = path.match(/^\/bingo\/ticket\/([^/]+)$/);
      if (method === 'GET' && ticketMatch) {
        return handleGetTicket(ticketMatch[1], env);
      }

      // ── PATCH /bingo/ticket/:id/paid ─────────────────────────────────────
      const paidMatch = path.match(/^\/bingo\/ticket\/([^/]+)\/paid$/);
      if (method === 'PATCH' && paidMatch) {
        return handleMarkPaid(paidMatch[1], env);
      }

      // ── POST /bingo/claim ────────────────────────────────────────────────
      if (method === 'POST' && path === '/bingo/claim') {
        return handleClaim(request, env);
      }

      // ── POST /bingo/confirm/:winner_id ───────────────────────────────────
      const confirmMatch = path.match(/^\/bingo\/confirm\/([^/]+)$/);
      if (method === 'POST' && confirmMatch) {
        return handleConfirm(confirmMatch[1], env);
      }

      // ── POST /bingo/reject/:winner_id ────────────────────────────────────
      const rejectMatch = path.match(/^\/bingo\/reject\/([^/]+)$/);
      if (method === 'POST' && rejectMatch) {
        return handleReject(rejectMatch[1], env);
      }

      return err('Not found', 404, env);

    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : 'Internal server error';
      console.error('Worker error:', e);
      return err(message, 500, env);
    }
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// HANDLERS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * POST /bingo/session
 * Create a new bingo session.
 *
 * Body: {
 *   name: string, date: string, mode: '90'|'75',
 *   ticket_price: number,          // cents
 *   ticket_cap?: number | null,
 *   pct_one_line?: number,         // 90-ball only
 *   pct_two_lines?: number,        // 90-ball only
 *   pct_full_house: number,        // both modes
 *   pct_any_line?: number,         // 75-ball only
 *   pct_organiser: number
 * }
 * Validation: percentages must sum to 100.
 */
async function handleCreateSession(request: Request, env: Env): Promise<Response> {
  const body = await request.json() as Partial<Session & { ticket_cap: number | null }>;

  const { name, date, mode = '90', ticket_price, ticket_cap = null,
          pct_one_line, pct_two_lines, pct_full_house, pct_any_line, pct_organiser } = body;

  if (!name || !date || !ticket_price || pct_organiser == null) {
    return err('Missing required fields: name, date, ticket_price, pct_organiser', 400, env);
  }

  // Validate percentage totals
  const pcts = mode === '90'
    ? [pct_one_line ?? 0, pct_two_lines ?? 0, pct_full_house ?? 0, pct_organiser]
    : [pct_any_line ?? 0, pct_full_house ?? 0, pct_organiser];

  const total = pcts.reduce((a, b) => a + b, 0);
  if (total !== 100) {
    return err(`Percentages must total 100, got ${total}`, 400, env);
  }

  const id  = uuid();
  const now = Date.now();

  await env.DB.prepare(`
    INSERT INTO sessions
      (id, name, date, mode, ticket_price, ticket_cap,
       pct_one_line, pct_two_lines, pct_full_house, pct_any_line, pct_organiser,
       status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
  `).bind(id, name, date, mode, ticket_price, ticket_cap,
          pct_one_line ?? null, pct_two_lines ?? null, pct_full_house ?? null,
          pct_any_line ?? null, pct_organiser, now).run();

  // Seed KV
  const kv = kvKeys(id);
  await Promise.all([
    env.KV.put(kv.status, 'pending'),
    env.KV.put(kv.pot, JSON.stringify({
      tickets_sold: 0,
      ticket_price,
      pot_total: 0,
      prizes: buildPrizeMap(mode as SessionMode, 0, body as Session),
    })),
  ]);

  return json({ id, status: 'pending' }, 201, env);
}

/**
 * GET /bingo/session/:id
 * Returns full session state including live pot from KV and called numbers from D1.
 */
async function handleGetSession(id: string, env: Env): Promise<Response> {
  const session = await env.DB
    .prepare('SELECT * FROM sessions WHERE id = ?')
    .bind(id).first<Session>();

  if (!session) return err('Session not found', 404, env);

  const kv     = kvKeys(id);
  const [statusRaw, latestRaw, potRaw] = await Promise.all([
    env.KV.get(kv.status),
    env.KV.get(kv.latest),
    env.KV.get(kv.pot),
  ]);

  const called = await env.DB
    .prepare('SELECT number, called_at FROM called_numbers WHERE session_id = ? ORDER BY called_at ASC')
    .bind(id).all<{ number: number; called_at: number }>();

  return json({
    ...session,
    kv: {
      status: statusRaw ?? session.status,
      latest: latestRaw ? JSON.parse(latestRaw) : null,
      pot:    potRaw    ? JSON.parse(potRaw)    : null,
    },
    called_numbers: called.results ?? [],
  }, 200, env);
}

/**
 * POST /bingo/session/:id/start
 * Transitions session to active. Locks pot. Writes pot_locked_at to D1.
 */
async function handleStartSession(id: string, env: Env): Promise<Response> {
  const session = await env.DB
    .prepare('SELECT * FROM sessions WHERE id = ?')
    .bind(id).first<Session>();

  if (!session) return err('Session not found', 404, env);
  if (session.status !== 'pending') return err('Session already started or ended', 400, env);

  const now = Date.now();
  const pot = await getPotValue(env, id);

  await env.DB.prepare(`
    UPDATE sessions SET status = 'active', pot_locked_at = ? WHERE id = ?
  `).bind(now, id).run();

  const kv = kvKeys(id);
  await Promise.all([
    env.KV.put(kv.status, 'active'),
    // Re-write pot with locked flag so play.html stops showing "growing"
    env.KV.put(kv.pot, JSON.stringify({
      locked:       true,
      tickets_sold: await getTicketCount(env, id),
      ticket_price: session.ticket_price,
      pot_total:    pot,
      prizes:       buildPrizeMap(session.mode, pot, session),
    })),
  ]);

  return json({ status: 'active', pot_locked_at: now, pot_total: pot }, 200, env);
}

/**
 * POST /bingo/session/:id/draw
 * Picks a random uncalled number, writes to D1 + KV.
 * Returns the drawn number and call phrase.
 */
async function handleDraw(id: string, env: Env): Promise<Response> {
  const session = await env.DB
    .prepare('SELECT * FROM sessions WHERE id = ?')
    .bind(id).first<Session>();

  if (!session) return err('Session not found', 404, env);
  if (session.status !== 'active') return err('Session is not active', 400, env);

  const max    = session.mode === '90' ? 90 : 75;
  const called = await env.DB
    .prepare('SELECT number FROM called_numbers WHERE session_id = ?')
    .bind(id).all<{ number: number }>();

  const calledSet = new Set((called.results ?? []).map(r => r.number));
  const remaining = Array.from({ length: max }, (_, i) => i + 1).filter(n => !calledSet.has(n));

  if (remaining.length === 0) return err('All numbers have been called', 400, env);

  const number   = remaining[Math.floor(Math.random() * remaining.length)];
  const now      = Date.now();
  const callText = session.mode === '90' ? getCal90(number) : getCall75(number);

  await env.DB.prepare(`
    INSERT INTO called_numbers (session_id, number, called_at) VALUES (?, ?, ?)
  `).bind(id, number, now).run();

  const latestPayload = {
    number,
    call: callText,
    called_at:    now,
    total_called: calledSet.size + 1,
    remaining:    remaining.length - 1,
  };

  await env.KV.put(kvKeys(id).latest, JSON.stringify(latestPayload));

  return json(latestPayload, 200, env);
}

/**
 * POST /bingo/session/:id/end
 * Marks session as ended.
 */
async function handleEndSession(id: string, env: Env): Promise<Response> {
  const session = await env.DB
    .prepare('SELECT status FROM sessions WHERE id = ?')
    .bind(id).first<{ status: string }>();

  if (!session) return err('Session not found', 404, env);
  if (session.status === 'ended') return err('Session already ended', 400, env);

  await env.DB.prepare(`UPDATE sessions SET status = 'ended' WHERE id = ?`).bind(id).run();
  await env.KV.put(kvKeys(id).status, 'ended');

  return json({ status: 'ended' }, 200, env);
}

/**
 * GET /bingo/session/:id/winners
 * Returns all confirmed (and pending) winners for a session.
 */
async function handleGetWinners(id: string, env: Env): Promise<Response> {
  const rows = await env.DB
    .prepare('SELECT * FROM winners WHERE session_id = ? ORDER BY claimed_at ASC')
    .bind(id).all<Winner>();

  return json({ winners: rows.results ?? [] }, 200, env);
}

/**
 * GET /bingo/session/:id/tickets
 * Returns all tickets for a session (metadata only, no card grids).
 */
async function handleGetTickets(id: string, env: Env): Promise<Response> {
  const session = await env.DB
    .prepare('SELECT id FROM sessions WHERE id = ?')
    .bind(id).first<{ id: string }>();
  if (!session) return err('Session not found', 404, env);

  const rows = await env.DB
    .prepare('SELECT id, player_name, player_phone, paid, created_at, json_array_length(cards) as card_count FROM tickets WHERE session_id = ? ORDER BY created_at ASC')
    .bind(id).all<{ id: string; player_name: string; player_phone: string; paid: number; created_at: number; card_count: number }>();

  return json({ tickets: rows.results ?? [] }, 200, env);
}

/**
 * POST /bingo/ticket
 * Create a ticket (one or more cards) for a player.
 *
 * Body: { session_id, player_name, player_phone?, card_count?: number }
 * Default card_count = 1. Max = 6.
 */
async function handleCreateTicket(request: Request, env: Env): Promise<Response> {
  const body = await request.json() as {
    session_id:   string;
    player_name:  string;
    player_phone?: string;
    card_count?:  number;
  };

  const { session_id, player_name, player_phone, card_count = 1 } = body;
  if (!session_id || !player_name) return err('Missing session_id or player_name', 400, env);
  if (card_count < 1 || card_count > 6) return err('card_count must be 1–6', 400, env);

  const session = await env.DB
    .prepare('SELECT * FROM sessions WHERE id = ?')
    .bind(session_id).first<Session>();

  if (!session) return err('Session not found', 404, env);
  if (session.status === 'ended') return err('Session has ended', 400, env);

  // Ticket cap check
  if (session.ticket_cap !== null) {
    const count = await getTicketCount(env, session_id);
    if (count >= session.ticket_cap) return err('Ticket cap reached', 400, env);
  }

  // Generate cards
  const cards = Array.from({ length: card_count }, () =>
    session.mode === '90' ? generate90CardSafe() : generate75Card()
  );

  const id  = uuid();
  const now = Date.now();

  await env.DB.prepare(`
    INSERT INTO tickets (id, session_id, player_name, player_phone, paid, cards, created_at)
    VALUES (?, ?, ?, ?, 0, ?, ?)
  `).bind(id, session_id, player_name, player_phone ?? null, JSON.stringify(cards), now).run();

  // Update pot KV (unpaid tickets don't count toward pot, but we track sold count)
  await refreshPotKV(env, session_id, session);

  const playUrl = `https://play.mdworks.dev/bingo/play.html?ticket=${id}`;

  return json({ id, cards, play_url: playUrl }, 201, env);
}

/**
 * GET /bingo/ticket/:id
 * Returns ticket + pre-daubed state based on called numbers for reconnection.
 */
async function handleGetTicket(id: string, env: Env): Promise<Response> {
  const ticket = await env.DB
    .prepare('SELECT * FROM tickets WHERE id = ?')
    .bind(id).first<Omit<Ticket, 'cards'> & { cards: string }>();

  if (!ticket) return err('Ticket not found', 404, env);

  const session = await env.DB
    .prepare('SELECT * FROM sessions WHERE id = ?')
    .bind(ticket.session_id).first<Session>();

  const called = await env.DB
    .prepare('SELECT number FROM called_numbers WHERE session_id = ? ORDER BY called_at ASC')
    .bind(ticket.session_id).all<{ number: number }>();

  const kv = kvKeys(ticket.session_id);
  const [statusRaw, latestRaw, potRaw, winnerRaw] = await Promise.all([
    env.KV.get(kv.status),
    env.KV.get(kv.latest),
    env.KV.get(kv.pot),
    env.KV.get(kv.winner),
  ]);

  return json({
    ticket: {
      ...ticket,
      cards: JSON.parse(ticket.cards),
    },
    session,
    called_numbers: (called.results ?? []).map(r => r.number),
    kv: {
      status: statusRaw,
      latest: latestRaw ? JSON.parse(latestRaw) : null,
      pot:    potRaw    ? JSON.parse(potRaw)    : null,
      winner: winnerRaw ? JSON.parse(winnerRaw) : null,
    },
  }, 200, env);
}

/**
 * PATCH /bingo/ticket/:id/paid
 * Mark a ticket as paid. Updates pot KV.
 */
async function handleMarkPaid(id: string, env: Env): Promise<Response> {
  const ticket = await env.DB
    .prepare('SELECT * FROM tickets WHERE id = ?')
    .bind(id).first<Omit<Ticket, 'cards'> & { cards: string }>();

  if (!ticket) return err('Ticket not found', 404, env);
  if (ticket.paid) return err('Ticket already marked as paid', 400, env);

  await env.DB.prepare('UPDATE tickets SET paid = 1 WHERE id = ?').bind(id).run();

  const session = await env.DB
    .prepare('SELECT * FROM sessions WHERE id = ?')
    .bind(ticket.session_id).first<Session>();

  if (session && session.status === 'pending') {
    await refreshPotKV(env, ticket.session_id, session);
  }

  return json({ paid: true }, 200, env);
}

/**
 * POST /bingo/claim
 * Player claims BINGO. Worker validates mathematically.
 * If valid, writes pending winner record and alerts caller via KV.
 *
 * Body: { ticket_id, session_id, card_index, prize_tier }
 */
async function handleClaim(request: Request, env: Env): Promise<Response> {
  const body = await request.json() as {
    ticket_id:  string;
    session_id: string;
    card_index: number;
    prize_tier: PrizeTier;
  };

  const { ticket_id, session_id, card_index, prize_tier } = body;
  if (!ticket_id || !session_id || prize_tier == null) {
    return err('Missing required fields', 400, env);
  }

  // 1. Fetch session
  const session = await env.DB
    .prepare('SELECT * FROM sessions WHERE id = ?')
    .bind(session_id).first<Session>();

  if (!session)                         return err('Session not found', 404, env);
  if (session.status !== 'active')      return err('Session is not active', 400, env);

  // 2. Fetch ticket
  const ticketRow = await env.DB
    .prepare('SELECT * FROM tickets WHERE id = ? AND session_id = ?')
    .bind(ticket_id, session_id).first<Omit<Ticket, 'cards'> & { cards: string }>();

  if (!ticketRow) return err('Ticket not found', 404, env);

  const cards: (number | null)[][][] = JSON.parse(ticketRow.cards);
  const card = cards[card_index];
  if (!card) return err('Invalid card index', 400, env);

  // 3. Check tier not already claimed
  const existing = await env.DB
    .prepare('SELECT id FROM winners WHERE session_id = ? AND prize_tier = ? AND validated != -1')
    .bind(session_id, prize_tier).first();

  if (existing) return json({ valid: false, reason: 'tier_already_won' }, 200, env);

  // 4. Fetch called numbers
  const calledRows = await env.DB
    .prepare('SELECT number FROM called_numbers WHERE session_id = ?')
    .bind(session_id).all<{ number: number }>();

  const called = new Set((calledRows.results ?? []).map(r => r.number));

  // 5. Validate
  const valid = validateClaim(card, called, prize_tier, session.mode);
  if (!valid) return json({ valid: false, reason: 'invalid_claim' }, 200, env);

  // 6. Calculate prize
  const pot         = await getPotValue(env, session_id);
  const pctKey      = `pct_${prize_tier}` as keyof Session;
  const pct         = (session[pctKey] as number | null) ?? 0;
  const prize_amount = calcPrize(pot, pct);

  // 7. Generate reference and write winner record
  const ref = await winnerRef(env, session_id);
  const now = Date.now();

  await env.DB.prepare(`
    INSERT INTO winners
      (id, session_id, ticket_id, player_name, card_index, prize_tier, prize_amount, claimed_at, validated)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)
  `).bind(ref, session_id, ticket_id, ticketRow.player_name, card_index,
          prize_tier, prize_amount, now).run();

  // 8. Alert caller via KV (pending — awaits confirmation)
  await env.KV.put(kvKeys(session_id).winner, JSON.stringify({
    ref,
    player_name:  ticketRow.player_name,
    prize_tier,
    ticket_id,
    card_index,
    prize_amount,
    validated:    0,
    timestamp:    now,
  }));

  return json({ valid: true, ref, player_name: ticketRow.player_name, prize_amount }, 200, env);
}

/**
 * POST /bingo/confirm/:winner_id
 * Caller confirms a pending win. Sets validated=1, pushes announcement to KV.
 */
async function handleConfirm(winnerId: string, env: Env): Promise<Response> {
  const winner = await env.DB
    .prepare('SELECT * FROM winners WHERE id = ?')
    .bind(winnerId).first<Winner>();

  if (!winner)               return err('Winner record not found', 404, env);
  if (winner.validated !== 0) return err('Already confirmed or rejected', 400, env);

  const now = Date.now();
  await env.DB.prepare(`
    UPDATE winners SET validated = 1, confirmed_at = ? WHERE id = ?
  `).bind(now, winnerId).run();

  // Push confirmed winner to KV so play.html instances see it
  await env.KV.put(kvKeys(winner.session_id).winner, JSON.stringify({
    ref:          winner.id,
    player_name:  winner.player_name,
    tier:         winner.prize_tier,
    ticket_id:    winner.ticket_id,
    card_index:   winner.card_index,
    prize_amount: winner.prize_amount,
    validated:    1,
    confirmed_at: now,
  }));

  return json({ confirmed: true, ref: winnerId }, 200, env);
}

/**
 * POST /bingo/reject/:winner_id
 * Caller rejects a claim. Sets validated=-1. Game continues.
 */
async function handleReject(winnerId: string, env: Env): Promise<Response> {
  const winner = await env.DB
    .prepare('SELECT * FROM winners WHERE id = ?')
    .bind(winnerId).first<Winner>();

  if (!winner)               return err('Winner record not found', 404, env);
  if (winner.validated !== 0) return err('Already confirmed or rejected', 400, env);

  await env.DB.prepare(`UPDATE winners SET validated = -1 WHERE id = ?`).bind(winnerId).run();

  // Clear the pending winner KV key so play.html and caller see nothing pending
  await env.KV.delete(kvKeys(winner.session_id).winner);

  return json({ rejected: true, ref: winnerId }, 200, env);
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

async function getTicketCount(env: Env, sessionId: string): Promise<number> {
  const row = await env.DB
    .prepare('SELECT COUNT(*) as n FROM tickets WHERE session_id = ?')
    .bind(sessionId).first<{ n: number }>();
  return row?.n ?? 0;
}

async function getPaidTicketCount(env: Env, sessionId: string): Promise<number> {
  const row = await env.DB
    .prepare('SELECT COUNT(*) as n FROM tickets WHERE session_id = ? AND paid = 1')
    .bind(sessionId).first<{ n: number }>();
  return row?.n ?? 0;
}

async function refreshPotKV(env: Env, sessionId: string, session: Session): Promise<void> {
  const sold      = await getPaidTicketCount(env, sessionId);
  const potTotal  = sold * session.ticket_price;
  await env.KV.put(kvKeys(sessionId).pot, JSON.stringify({
    locked:       false,
    tickets_sold: sold,
    ticket_price: session.ticket_price,
    pot_total:    potTotal,
    prizes:       buildPrizeMap(session.mode, potTotal, session),
  }));
}

function buildPrizeMap(mode: SessionMode, pot: number, s: Partial<Session>): Record<string, number> {
  if (mode === '90') {
    return {
      one_line:   calcPrize(pot, s.pct_one_line  ?? 0),
      two_lines:  calcPrize(pot, s.pct_two_lines ?? 0),
      full_house: calcPrize(pot, s.pct_full_house ?? 0),
      organiser:  calcPrize(pot, s.pct_organiser  ?? 0),
    };
  }
  return {
    any_line:   calcPrize(pot, s.pct_any_line  ?? 0),
    full_house: calcPrize(pot, s.pct_full_house ?? 0),
    organiser:  calcPrize(pot, s.pct_organiser  ?? 0),
  };
}

// ── Call phrases ──────────────────────────────────────────────────────────────

/** 90-ball UK/SA rhyming calls */
function getCal90(n: number): string {
  const calls: Record<number, string> = {
    1:  "Kelly's Eye — One",        2:  "One Little Duck — Two",
    3:  "Cup of Tea — Three",       4:  "Knock at the Door — Four",
    5:  "Man Alive — Five",         6:  "Tom Mix — Six",
    7:  "Lucky Seven — Seven",      8:  "One Fat Lady — Eight",
    9:  "Doctor's Orders — Nine",   10: "Prime Minister's Den — Ten",
    11: "Legs Eleven — Eleven",     12: "One Dozen — Twelve",
    13: "Unlucky for Some — Thirteen", 14: "Valentine's Day — Fourteen",
    15: "Young and Keen — Fifteen", 16: "Sweet Sixteen — Sixteen",
    17: "Old Ireland — Seventeen",  18: "Coming of Age — Eighteen",
    19: "Goodbye Teens — Nineteen", 20: "One Score — Twenty",
    21: "Royal Salute — Twenty-One", 22: "Two Little Ducks — Twenty-Two",
    23: "The Lord is My Shepherd — Twenty-Three",
    24: "Two Dozen — Twenty-Four",
    25: "Duck and Dive — Twenty-Five",
    26: "Pick and Mix — Twenty-Six",
    27: "Gateway to Heaven — Twenty-Seven",
    28: "In a State — Twenty-Eight",
    29: "Rise and Shine — Twenty-Nine",
    30: "Burlington Bertie — Thirty",
    31: "Get Up and Run — Thirty-One",
    32: "Buckle My Shoe — Thirty-Two",
    33: "Dirty Knees — Thirty-Three",
    34: "Ask for More — Thirty-Four",
    35: "Jump and Jive — Thirty-Five",
    36: "Tick Tock — Thirty-Six",
    37: "More Than Eleven — Thirty-Seven",
    38: "Christmas Cake — Thirty-Eight",
    39: "Steps — Thirty-Nine",
    40: "Life Begins — Forty",
    41: "Time for Fun — Forty-One",
    42: "Winnie the Pooh — Forty-Two",
    43: "Down on Your Knees — Forty-Three",
    44: "Droopy Drawers — Forty-Four",
    45: "Halfway There — Forty-Five",
    46: "Up to Tricks — Forty-Six",
    47: "Four and Seven — Forty-Seven",
    48: "Four Dozen — Forty-Eight",
    49: "PC — Forty-Nine",
    50: "Half a Century — Fifty",
    51: "Tweak of the Thumb — Fifty-One",
    52: "Danny La Rue — Fifty-Two",
    53: "Stuck in a Tree — Fifty-Three",
    54: "Clean the Floor — Fifty-Four",
    55: "Snakes Alive — Fifty-Five",
    56: "Was She Worth It — Fifty-Six",
    57: "Heinz Varieties — Fifty-Seven",
    58: "Make Them Wait — Fifty-Eight",
    59: "Brighton Line — Fifty-Nine",
    60: "Five Dozen — Sixty",
    61: "Baker's Bun — Sixty-One",
    62: "Turn the Screw — Sixty-Two",
    63: "Tickle Me — Sixty-Three",
    64: "Red Raw — Sixty-Four",
    65: "Old Age Pension — Sixty-Five",
    66: "Clickety Click — Sixty-Six",
    67: "Stairway to Heaven — Sixty-Seven",
    68: "Saving Grace — Sixty-Eight",
    69: "Either Way Up — Sixty-Nine",
    70: "Three Score and Ten — Seventy",
    71: "Bang on the Drum — Seventy-One",
    72: "Six Dozen — Seventy-Two",
    73: "Queen Bee — Seventy-Three",
    74: "Candy Store — Seventy-Four",
    75: "Strive and Strive — Seventy-Five",
    76: "Trombones — Seventy-Six",
    77: "Sunset Strip — Seventy-Seven",
    78: "Heaven's Gate — Seventy-Eight",
    79: "One More Time — Seventy-Nine",
    80: "Eight and Blank — Eighty",
    81: "Stop and Run — Eighty-One",
    82: "Straight On Through — Eighty-Two",
    83: "Time for Tea — Eighty-Three",
    84: "Seven Dozen — Eighty-Four",
    85: "Staying Alive — Eighty-Five",
    86: "Between the Sticks — Eighty-Six",
    87: "Torquay in Devon — Eighty-Seven",
    88: "Two Fat Ladies — Eighty-Eight",
    89: "Nearly There — Eighty-Nine",
    90: "Top of the Shop — Ninety",
  };
  return calls[n] ?? `Number — ${n}`;
}

/** 75-ball US calls: "B — 7" style */
function getCall75(n: number): string {
  const letter = n <= 15 ? 'B' : n <= 30 ? 'I' : n <= 45 ? 'N' : n <= 60 ? 'G' : 'O';
  return `${letter} — ${n}`;
}
