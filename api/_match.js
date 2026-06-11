// Shared duel helpers for the match routes. (Underscore prefix = not a lambda.)
const { getPool } = require('./_db');

const keyOf = (name) => String(name || '').trim().toLowerCase();

// build the shared 20-tile board both phones will see: 10 answers + 10 decoys,
// shuffled once server-side and stored, so the order matches everywhere.
async function buildTiles(client, boardId) {
  const { rows } = await client.query(
    `SELECT text, on_list FROM board_answers WHERE board_id=$1 ORDER BY on_list DESC, sort_order`,
    [boardId]
  );
  const pool = rows.map((r) => ({ t: r.text, on: r.on_list, by: 0 }));
  for (let k = pool.length - 1; k > 0; k--) {
    const j = Math.floor(Math.random() * (k + 1));
    [pool[k], pool[j]] = [pool[j], pool[k]];
  }
  return pool;
}

// the 30-second turn clock, server-enforced with a 2s network grace. A turn older
// than this is flipped (no point change) by the next poll or tap that notices.
// Speed pays: a correct tap in the first 10s scores 3, the next 10s scores 2, the
// final 10s scores 1 (see match-tap).
const TURN_LIMIT_MS = 32000;

// sudden-death math question: two-step mental arithmetic, answer in 10–99-ish range.
// Unbiased (no trivia), always answerable, infinite supply.
function genTiebreak() {
  const r = (lo, hi) => lo + Math.floor(Math.random() * (hi - lo + 1));
  const a = r(11, 48), b = r(11, 48), c = r(2, 9), d = r(3, 12);
  const forms = [
    { q: `${a} + ${b} − ${c}`, ans: a + b - c },
    { q: `${a} − ${c} + ${b}`, ans: a - c + b },
    { q: `${c} × ${d} + ${a}`, ans: c * d + a },
    { q: `${a} + ${c} × ${d}`, ans: a + c * d },
  ];
  return forms[Math.floor(Math.random() * forms.length)];
}

// flip a turn that ran past the shot clock (atomic conditional update — safe against
// a concurrent tap because match-tap holds FOR UPDATE on the row).
async function expireStaleTurn(client, matchId) {
  await client.query(
    `UPDATE match_state SET turn = 3 - turn, version = version + 1, updated_at = now()
      WHERE match_id = $1 AND board_status = 'playing'
        AND updated_at < now() - make_interval(secs => ${TURN_LIMIT_MS / 1000})`,
    [matchId]
  );
}

// the poll payload. Answers are NOT leaked mid-board: an untapped tile carries no
// `on`; a tapped tile reveals only its own outcome. Once the board is done (or in
// tiebreak, or the match is over) everything is revealed for the gold/dud reveal.
// The tiebreak ANSWER is never sent — only the question text + who has tried.
async function matchPayload(client, matchId) {
  const { rows: [m] } = await client.query(`SELECT * FROM matches WHERE id=$1`, [matchId]);
  if (!m) return null;
  const { rows: [s] } = await client.query(`SELECT * FROM match_state WHERE match_id=$1`, [matchId]);
  let board = null, state = null;
  if (s) {
    const boardId = m.board_ids[m.current_board_idx];
    const { rows: [b] } = await client.query(
      `SELECT id, title, icon, color_slot FROM boards WHERE id=$1`, [boardId]
    );
    board = b ? { id: b.id, title: b.title, icon: b.icon, colorSlot: b.color_slot } : null;
    const revealAll = s.board_status !== 'playing' || m.status === 'done';
    const tiles = s.tiles_json.map((t) =>
      revealAll ? { t: t.t, by: t.by, on: t.on, n: t.n }
        : t.by ? { t: t.t, by: t.by, hit: !!t.on, n: t.n }
        : { t: t.t, by: 0 }
    );
    state = {
      tiles, turn: s.turn, boardStatus: s.board_status, version: s.version,
      scoreHost: s.score_host, scoreGuest: s.score_guest,
      wrongHost: s.wrong_host, wrongGuest: s.wrong_guest,
      turnMs: Math.max(0, Date.now() - new Date(s.updated_at).getTime()),
      tbQuestion: s.board_status === 'tiebreak' ? s.tb_question : null,
      tbTriedHost: !!s.tb_tried_host, tbTriedGuest: !!s.tb_tried_guest,
    };
  }
  return {
    ok: true,
    match: {
      id: m.id, room: m.room_code, mode: m.mode, status: m.status,
      host: { key: m.host_key, name: m.host_name, avatar: m.host_avatar },
      guest: m.guest_key ? { key: m.guest_key, name: m.guest_name, avatar: m.guest_avatar } : null,
      boardIdx: m.current_board_idx, boardCount: m.board_ids.length,
      seriesHost: m.series_host, seriesGuest: m.series_guest, winner: m.winner,
      pointsHost: m.points_host, pointsGuest: m.points_guest,
    },
    board, state,
  };
}

module.exports = { getPool, keyOf, buildTiles, matchPayload, genTiebreak, expireStaleTurn, TURN_LIMIT_MS };
