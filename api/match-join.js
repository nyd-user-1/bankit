// POST /api/match-join — join a lobby by 4-digit room code. Body: {room, name, avatar}.
const { getPool, keyOf, matchPayload } = require('./_match');

module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.status(405).json({ error: 'POST only' }); return; }
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  body = body || {};

  const room = String(body.room || '').trim().slice(0, 4);
  const name = String(body.name || '').trim().replace(/\s+/g, ' ').slice(0, 20);
  const avatar = String(body.avatar || '🎯').slice(0, 8);
  if (!/^\d{4}$/.test(room)) { res.status(400).json({ error: 'Enter the 4-digit room code.' }); return; }
  if (name.length < 2) { res.status(400).json({ error: 'Sign in first.' }); return; }

  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [m] } = await client.query(
      `SELECT * FROM matches WHERE room_code=$1 AND status<>'done' ORDER BY id DESC LIMIT 1 FOR UPDATE`,
      [room]
    );
    if (!m) { await client.query('ROLLBACK'); res.status(404).json({ error: 'No game with that code — check the digits.' }); return; }
    const key = keyOf(name);
    if (m.host_key === key) { await client.query('ROLLBACK'); res.status(409).json({ error: "That's your own room — share the code with a friend." }); return; }
    // rejoining the same lobby (e.g. after a refresh) is fine; a third player is not
    if (m.guest_key && m.guest_key !== key) {
      await client.query('ROLLBACK'); res.status(409).json({ error: 'That room is already full.' }); return;
    }
    await client.query(
      `UPDATE matches SET guest_key=$2, guest_name=$3, guest_avatar=$4 WHERE id=$1`,
      [m.id, key, name, avatar]
    );
    await client.query('COMMIT');
    res.status(200).json(await matchPayload(pool, m.id));
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('match-join error:', e);
    res.status(500).json({ error: 'Could not join — try again.' });
  } finally {
    client.release();
  }
};
