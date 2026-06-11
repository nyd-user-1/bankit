// POST /api/match-tap — one duel move. Two bodies:
//   tap:   {id, key, idx, version}     — tap a tile on your turn
//   solve: {id, key, answer, version}  — answer the sudden-death tiebreak question
// The server is the referee: validates it's your turn and the tile is free, applies
// +3/+2/+1 by turn speed (first/second/third 10s window) for a correct tap, 0 for a
// wrong one (count still recorded), locks the tile for both, flips the turn. The 30s
// turn clock is enforced here too (32s with network grace): a tap on an expired turn
// passes the turn instead of scoring.
// A board ends when all 10 real answers are found; higher score wins it. A TIED board
// goes to sudden death: a generated mental-math question, first correct typed answer
// takes the board (one try per player per question; both miss → a fresh question).
// Best 2 of 3: first to 2 board wins (or the 3rd board) ends the match. Board points
// accumulate into matches.points_* — the cumulative match score. The next board's
// opening turn alternates (board 0 host, board 1 guest, …).
const { getPool, keyOf, buildTiles, matchPayload, genTiebreak, TURN_LIMIT_MS } = require('./_match');

// a board has a winner — bank its points, move the series, deal the next board or end
async function advanceSeries(client, m, s, boardWinner, scoreHost, scoreGuest, wrongHost, wrongGuest, tiles) {
  const seriesHost = m.series_host + (boardWinner === 1 ? 1 : 0);
  const seriesGuest = m.series_guest + (boardWinner === 2 ? 1 : 0);
  const lastBoard = m.current_board_idx === m.board_ids.length - 1;
  const matchOver = seriesHost === 2 || seriesGuest === 2 || lastBoard;
  const pointsHost = m.points_host + scoreHost;
  const pointsGuest = m.points_guest + scoreGuest;

  if (matchOver) {
    const winner = seriesHost === seriesGuest ? 0 : seriesHost > seriesGuest ? 1 : 2;
    await client.query(
      `UPDATE matches SET status='done', winner=$2, series_host=$3, series_guest=$4,
         points_host=$5, points_guest=$6 WHERE id=$1`,
      [m.id, winner, seriesHost, seriesGuest, pointsHost, pointsGuest]
    );
    await client.query(
      `UPDATE match_state SET tiles_json=$2, score_host=$3, score_guest=$4,
         wrong_host=$5, wrong_guest=$6, board_status='done', tb_question=NULL, tb_answer=NULL,
         tb_tried_host=FALSE, tb_tried_guest=FALSE, version=version+1, updated_at=now()
       WHERE match_id=$1`,
      [m.id, JSON.stringify(tiles), scoreHost, scoreGuest, wrongHost, wrongGuest]
    );
  } else {
    const nextIdx = m.current_board_idx + 1;
    const nextTiles = await buildTiles(client, m.board_ids[nextIdx]);
    await client.query(
      `UPDATE matches SET series_host=$2, series_guest=$3, current_board_idx=$4,
         points_host=$5, points_guest=$6 WHERE id=$1`,
      [m.id, seriesHost, seriesGuest, nextIdx, pointsHost, pointsGuest]
    );
    await client.query(
      `UPDATE match_state SET tiles_json=$2, turn=$3, score_host=0, score_guest=0,
         wrong_host=0, wrong_guest=0, board_status='playing', tb_question=NULL, tb_answer=NULL,
         tb_tried_host=FALSE, tb_tried_guest=FALSE, version=version+1, updated_at=now()
       WHERE match_id=$1`,
      [m.id, JSON.stringify(nextTiles), (nextIdx % 2) + 1]
    );
  }
  return { boardWinner, scoreHost, scoreGuest, wrongHost, wrongGuest };
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.status(405).json({ error: 'POST only' }); return; }
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  body = body || {};

  const id = parseInt(body.id, 10);
  const key = keyOf(body.key);
  const isSolve = body.answer !== undefined && body.answer !== null;
  const idx = parseInt(body.idx, 10);
  if (!Number.isFinite(id) || (!isSolve && !Number.isFinite(idx))) { res.status(400).json({ error: 'Bad tap.' }); return; }

  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [m] } = await client.query(`SELECT * FROM matches WHERE id=$1 FOR UPDATE`, [id]);
    const { rows: [s] } = await client.query(`SELECT * FROM match_state WHERE match_id=$1 FOR UPDATE`, [id]);
    const fail = async (code, error) => { await client.query('ROLLBACK'); res.status(code).json({ error }); };

    if (!m || !s) return fail(404, 'Match not found.');
    if (m.status !== 'playing') return fail(409, 'This match is over.');
    const role = key === m.host_key ? 1 : key === m.guest_key ? 2 : 0;
    if (!role) return fail(403, 'You are not in this match.');

    // ===== sudden-death solve =====
    if (isSolve) {
      if (s.board_status !== 'tiebreak') return fail(409, 'No tiebreak running.');
      const tried = role === 1 ? s.tb_tried_host : s.tb_tried_guest;
      if (tried) return fail(409, 'Already tried — wait for a fresh question.');
      const correct = parseInt(body.answer, 10) === s.tb_answer;

      if (correct) {
        const result = await advanceSeries(client, m, s, role,
          s.score_host, s.score_guest, s.wrong_host, s.wrong_guest, s.tiles_json);
        await client.query('COMMIT');
        const payload = await matchPayload(pool, id);
        payload.solve = { correct: true, boardResult: result };
        res.status(200).json(payload);
        return;
      }

      // wrong: lock this player out of the current question; both wrong → fresh question
      let triedHost = s.tb_tried_host || role === 1;
      let triedGuest = s.tb_tried_guest || role === 2;
      let q = null;
      if (triedHost && triedGuest) { q = genTiebreak(); triedHost = false; triedGuest = false; }
      await client.query(
        `UPDATE match_state SET tb_tried_host=$2, tb_tried_guest=$3,
           tb_question=COALESCE($4, tb_question), tb_answer=COALESCE($5, tb_answer),
           version=version+1, updated_at=now()
         WHERE match_id=$1`,
        [id, triedHost, triedGuest, q && q.q, q && q.ans]
      );
      await client.query('COMMIT');
      const payload = await matchPayload(pool, id);
      payload.solve = { correct: false };
      res.status(200).json(payload);
      return;
    }

    // ===== regular tap =====
    if (s.board_status !== 'playing') return fail(409, 'This board is over.');

    // shot clock: a tap on an expired turn doesn't score — the turn passes instead
    const turnAge = Date.now() - new Date(s.updated_at).getTime();
    if (turnAge > TURN_LIMIT_MS) {
      await client.query(
        `UPDATE match_state SET turn = 3 - turn, version=version+1, updated_at=now() WHERE match_id=$1`, [id]
      );
      await client.query('COMMIT');
      res.status(409).json({ error: "Time's up — the turn passed." });
      return;
    }

    if (s.turn !== role) return fail(409, 'Not your turn.');
    if (body.version != null && +body.version !== s.version) return fail(409, 'Out of date — hold on.');

    const tiles = s.tiles_json;
    const tile = tiles[idx];
    if (!tile || tile.by) return fail(409, 'That tile is taken.');

    // apply the tap — speed pays: a correct tap in the first 10s of the turn scores 3,
    // the next 10s scores 2, the final 10s scores 1. Wrong = 0 (count kept for stats).
    tile.by = role;
    let scoreHost = s.score_host, scoreGuest = s.score_guest;
    let wrongHost = s.wrong_host, wrongGuest = s.wrong_guest;
    let pts = 0;
    if (tile.on) {
      pts = turnAge < 10000 ? 3 : turnAge < 20000 ? 2 : 1;
      if (role === 1) scoreHost += pts; else scoreGuest += pts;
      tile.n = tiles.filter((t) => t.on && t.by).length;   // found-order badge (1–10)
    }
    else { if (role === 1) wrongHost++; else wrongGuest++; }

    const found = tiles.filter((t) => t.on && t.by).length;
    const boardDone = found === 10;
    const turn = role === 1 ? 2 : 1;
    let result = null;   // this tap's board outcome, for the client's interstitial

    if (boardDone) {
      if (scoreHost === scoreGuest) {
        // tied board → sudden death: generated math question, first correct answer wins
        const q = genTiebreak();
        await client.query(
          `UPDATE match_state SET tiles_json=$2, score_host=$3, score_guest=$4,
             wrong_host=$5, wrong_guest=$6, board_status='tiebreak',
             tb_question=$7, tb_answer=$8, tb_tried_host=FALSE, tb_tried_guest=FALSE,
             version=version+1, updated_at=now()
           WHERE match_id=$1`,
          [id, JSON.stringify(tiles), scoreHost, scoreGuest, wrongHost, wrongGuest, q.q, q.ans]
        );
      } else {
        const boardWinner = scoreHost > scoreGuest ? 1 : 2;
        result = await advanceSeries(client, m, s, boardWinner, scoreHost, scoreGuest, wrongHost, wrongGuest, tiles);
      }
    } else {
      await client.query(
        `UPDATE match_state SET tiles_json=$2, turn=$3, score_host=$4, score_guest=$5,
           wrong_host=$6, wrong_guest=$7, version=version+1, updated_at=now()
         WHERE match_id=$1`,
        [id, JSON.stringify(tiles), turn, scoreHost, scoreGuest, wrongHost, wrongGuest]
      );
    }

    await client.query('COMMIT');
    const payload = await matchPayload(pool, id);
    payload.tap = { idx, hit: !!tile.on, by: role, pts, boardResult: result };
    res.status(200).json(payload);
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('match-tap error:', e);
    res.status(500).json({ error: 'Tap lost in the mail — try again.' });
  } finally {
    client.release();
  }
};
