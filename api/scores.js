// GET  /api/scores            — top leaderboard rows (default: best aggregate runs)
//       ?boardId=<id>          — top rows for one board
// POST /api/scores  {player_name, avatar?, board_id?, score, how_ended}
const { getPool } = require('./_db');

module.exports = async (req, res) => {
  const pool = getPool();

  if (req.method === 'GET') {
    try {
      const boardId = req.query.boardId ? parseInt(req.query.boardId, 10) : null;
      const limit = Math.min(parseInt(req.query.limit, 10) || 10, 50);
      const { rows } = boardId
        ? await pool.query(
            `SELECT player_name, avatar, board_id, score, how_ended, created_at
               FROM scores WHERE board_id = $1
               ORDER BY score DESC, created_at ASC LIMIT $2`, [boardId, limit])
        : await pool.query(
            `SELECT player_name, avatar, board_id, score, how_ended, created_at
               FROM scores
               ORDER BY score DESC, created_at ASC LIMIT $1`, [limit]);
      res.status(200).json({ scores: rows });
    } catch (e) {
      res.status(500).json({ error: 'db_error', detail: String(e.message || e) });
    }
    return;
  }

  if (req.method === 'POST') {
    try {
      const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
      const player_name = String(body.player_name || '').trim().slice(0, 24) || 'Player';
      const avatar = String(body.avatar || '🎯').slice(0, 8);
      const board_id = body.board_id != null ? parseInt(body.board_id, 10) : null;
      const score = Math.max(0, Math.min(10, parseInt(body.score, 10) || 0));
      const how_ended = ['banked', 'busted', 'clear'].includes(body.how_ended) ? body.how_ended : 'banked';
      const { rows } = await pool.query(
        `INSERT INTO scores (player_name, avatar, board_id, score, how_ended)
           VALUES ($1,$2,$3,$4,$5) RETURNING id, created_at`,
        [player_name, avatar, board_id, score, how_ended]
      );
      res.status(201).json({ ok: true, id: rows[0].id });
    } catch (e) {
      res.status(500).json({ error: 'db_error', detail: String(e.message || e) });
    }
    return;
  }

  res.status(405).json({ error: 'GET or POST only' });
};
