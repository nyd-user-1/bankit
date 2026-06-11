// /api/match — host & poll a multiplayer duel.
//   POST {action:'create', name, avatar}            → new lobby, returns room code
//   POST {action:'start',  id, key}                 → host starts the match (needs a guest)
//   GET  ?id=  (or ?room=)                          → THE POLL: full match + current board state
const { getPool, keyOf, buildTiles, matchPayload, expireStaleTurn } = require('./_match');

module.exports = async (req, res) => {
  const pool = getPool();

  if (req.method === 'GET') {
    try {
      const id = parseInt(req.query.id, 10);
      let matchId = Number.isFinite(id) ? id : null;
      if (!matchId && req.query.room) {
        const { rows: [m] } = await pool.query(
          `SELECT id FROM matches WHERE room_code=$1 AND status<>'done' ORDER BY id DESC LIMIT 1`,
          [String(req.query.room).slice(0, 4)]
        );
        matchId = m && m.id;
      }
      if (!matchId) { res.status(404).json({ error: 'Match not found.' }); return; }
      await expireStaleTurn(pool, matchId);   // shot clock: pass any turn that ran out
      const payload = await matchPayload(pool, matchId);
      if (!payload) { res.status(404).json({ error: 'Match not found.' }); return; }
      res.status(200).json(payload);
    } catch (e) {
      console.error('match GET error:', e);
      res.status(500).json({ error: 'Could not load the match.' });
    }
    return;
  }

  if (req.method !== 'POST') { res.status(405).json({ error: 'GET or POST only' }); return; }
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  body = body || {};

  try {
    if (body.action === 'start') {
      const id = parseInt(body.id, 10);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const { rows: [m] } = await client.query(`SELECT * FROM matches WHERE id=$1 FOR UPDATE`, [id]);
        if (!m) { await client.query('ROLLBACK'); res.status(404).json({ error: 'Match not found.' }); return; }
        if (keyOf(body.key) !== m.host_key) { await client.query('ROLLBACK'); res.status(403).json({ error: 'Only the host can start.' }); return; }
        if (m.status !== 'lobby') { await client.query('ROLLBACK'); res.status(409).json({ error: 'Already started.' }); return; }
        if (!m.guest_key) { await client.query('ROLLBACK'); res.status(409).json({ error: 'Waiting for a challenger.' }); return; }
        const tiles = await buildTiles(client, m.board_ids[0]);
        await client.query(
          `INSERT INTO match_state (match_id, tiles_json) VALUES ($1, $2)
           ON CONFLICT (match_id) DO UPDATE SET tiles_json=$2, turn=1, score_host=0, score_guest=0,
             wrong_host=0, wrong_guest=0, board_status='playing', version=match_state.version+1, updated_at=now()`,
          [id, JSON.stringify(tiles)]
        );
        await client.query(`UPDATE matches SET status='playing' WHERE id=$1`, [id]);
        await client.query('COMMIT');
      } catch (e) { await client.query('ROLLBACK'); throw e; }
      finally { client.release(); }
      res.status(200).json(await matchPayload(pool, id));
      return;
    }

    // default action: create a lobby
    // sweep stale games first so abandoned lobbies don't hold room codes hostage
    await pool.query(`UPDATE matches SET status='done' WHERE status<>'done' AND created_at < now() - interval '24 hours'`);
    const name = String(body.name || '').trim().replace(/\s+/g, ' ').slice(0, 20);
    const avatar = String(body.avatar || '🎯').slice(0, 8);
    if (name.length < 2) { res.status(400).json({ error: 'Sign in first.' }); return; }

    // the match list: 3 random official boards — best 2 of 3
    const { rows: boards } = await pool.query(
      `SELECT id FROM boards WHERE is_active AND owner_key IS NULL ORDER BY random() LIMIT 3`
    );
    if (boards.length < 3) { res.status(503).json({ error: 'Not enough boards to duel.' }); return; }
    const boardIds = boards.map((b) => b.id);

    // 4-digit room code, retried if a live match already holds it
    let match = null;
    for (let tries = 0; tries < 8 && !match; tries++) {
      const code = String(1000 + Math.floor(Math.random() * 9000));
      try {
        const { rows: [m] } = await pool.query(
          `INSERT INTO matches (room_code, host_key, host_name, host_avatar, board_ids)
           VALUES ($1,$2,$3,$4,$5) RETURNING id`,
          [code, keyOf(name), name, avatar, boardIds]
        );
        match = m;
      } catch (e) { if (e.code !== '23505') throw e; }
    }
    if (!match) { res.status(503).json({ error: 'Could not find a free room — try again.' }); return; }
    res.status(200).json(await matchPayload(pool, match.id));
  } catch (e) {
    console.error('match POST error:', e);
    res.status(500).json({ error: 'Could not set up the match.' });
  }
};
