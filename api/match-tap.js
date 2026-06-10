// POST /api/match-tap — one duel tap. Body: {id, key, idx, version}.
// The server is the referee: validates it's your turn and the tile is free, applies
// +1 (correct) / −1 (wrong, negatives OK), locks the tile for both, flips the turn.
// A board ends when all 10 real answers are found; higher score wins it, tie goes to
// fewer wrong taps, dead-equal is a drawn board. First to 3 boards wins the series;
// the next board's opening turn alternates (board 0 host, board 1 guest, …).
const { getPool, keyOf, buildTiles, matchPayload } = require('./_match');

module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.status(405).json({ error: 'POST only' }); return; }
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  body = body || {};

  const id = parseInt(body.id, 10);
  const idx = parseInt(body.idx, 10);
  const key = keyOf(body.key);
  if (!Number.isFinite(id) || !Number.isFinite(idx)) { res.status(400).json({ error: 'Bad tap.' }); return; }

  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [m] } = await client.query(`SELECT * FROM matches WHERE id=$1 FOR UPDATE`, [id]);
    const { rows: [s] } = await client.query(`SELECT * FROM match_state WHERE match_id=$1 FOR UPDATE`, [id]);
    const fail = async (code, error) => { await client.query('ROLLBACK'); res.status(code).json({ error }); };

    if (!m || !s) return fail(404, 'Match not found.');
    if (m.status !== 'playing' || s.board_status !== 'playing') return fail(409, 'This board is over.');
    const role = key === m.host_key ? 1 : key === m.guest_key ? 2 : 0;
    if (!role) return fail(403, 'You are not in this match.');
    if (s.turn !== role) return fail(409, 'Not your turn.');
    if (body.version != null && +body.version !== s.version) return fail(409, 'Out of date — hold on.');

    const tiles = s.tiles_json;
    const tile = tiles[idx];
    if (!tile || tile.by) return fail(409, 'That tile is taken.');

    // apply the tap
    tile.by = role;
    let scoreHost = s.score_host, scoreGuest = s.score_guest;
    let wrongHost = s.wrong_host, wrongGuest = s.wrong_guest;
    if (tile.on) { if (role === 1) scoreHost++; else scoreGuest++; }
    else { if (role === 1) { scoreHost--; wrongHost++; } else { scoreGuest--; wrongGuest++; } }

    const found = tiles.filter((t) => t.on && t.by).length;
    const boardDone = found === 10;
    let turn = role === 1 ? 2 : 1;
    let boardStatus = 'playing';
    let result = null;   // this tap's board outcome, for the client's interstitial

    if (boardDone) {
      boardStatus = 'done';
      let boardWinner = 0; // drawn board
      if (scoreHost !== scoreGuest) boardWinner = scoreHost > scoreGuest ? 1 : 2;
      else if (wrongHost !== wrongGuest) boardWinner = wrongHost < wrongGuest ? 1 : 2;
      let seriesHost = m.series_host + (boardWinner === 1 ? 1 : 0);
      let seriesGuest = m.series_guest + (boardWinner === 2 ? 1 : 0);
      const lastBoard = m.current_board_idx === m.board_ids.length - 1;
      const matchOver = seriesHost === 3 || seriesGuest === 3 || lastBoard;
      result = { boardWinner, scoreHost, scoreGuest, wrongHost, wrongGuest };

      if (matchOver) {
        const winner = seriesHost === seriesGuest ? 0 : seriesHost > seriesGuest ? 1 : 2;
        await client.query(
          `UPDATE matches SET status='done', winner=$2, series_host=$3, series_guest=$4 WHERE id=$1`,
          [id, winner, seriesHost, seriesGuest]
        );
        await client.query(
          `UPDATE match_state SET tiles_json=$2, turn=$3, score_host=$4, score_guest=$5,
             wrong_host=$6, wrong_guest=$7, board_status='done', version=version+1, updated_at=now()
           WHERE match_id=$1`,
          [id, JSON.stringify(tiles), turn, scoreHost, scoreGuest, wrongHost, wrongGuest]
        );
      } else {
        // advance the series: fresh tiles, scores reset, opening turn alternates
        const nextIdx = m.current_board_idx + 1;
        const nextTiles = await buildTiles(client, m.board_ids[nextIdx]);
        await client.query(
          `UPDATE matches SET series_host=$2, series_guest=$3, current_board_idx=$4 WHERE id=$1`,
          [id, seriesHost, seriesGuest, nextIdx]
        );
        await client.query(
          `UPDATE match_state SET tiles_json=$2, turn=$3, score_host=0, score_guest=0,
             wrong_host=0, wrong_guest=0, board_status='playing', version=version+1, updated_at=now()
           WHERE match_id=$1`,
          [id, JSON.stringify(nextTiles), (nextIdx % 2) + 1]
        );
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
    payload.tap = { idx, hit: !!tile.on, by: role, boardResult: result };
    res.status(200).json(payload);
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('match-tap error:', e);
    res.status(500).json({ error: 'Tap lost in the mail — try again.' });
  } finally {
    client.release();
  }
};
