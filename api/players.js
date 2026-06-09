// GET /api/players?name=<username>
//   → { player: { name, avatar, total_points, runs, sweeps, best }, sweptBoards: [{title, icon}] }
//   Returns a zeroed player (and empty sweeps) if the name has never played.
const { getPool } = require('./_db');

module.exports = async (req, res) => {
  if (req.method !== 'GET') { res.status(405).json({ error: 'GET only' }); return; }
  const name = String(req.query.name || '').trim();
  if (!name) { res.status(400).json({ error: 'name required' }); return; }
  const key = name.toLowerCase();
  try {
    const pool = getPool();
    const { rows } = await pool.query(
      `SELECT name, avatar, total_points, runs, sweeps, best FROM players WHERE name_key = $1`, [key]
    );
    const player = rows[0] || { name, avatar: '🎯', total_points: 0, runs: 0, sweeps: 0, best: 0 };

    // the distinct boards this player has swept (10/10 clears), newest first
    const { rows: swept } = await pool.query(
      `SELECT DISTINCT b.title, b.icon, b.color_slot
         FROM scores s JOIN boards b ON b.id = s.board_id
        WHERE lower(btrim(s.player_name)) = $1 AND s.how_ended = 'clear'
        ORDER BY b.title`, [key]
    );
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({ player, sweptBoards: swept });
  } catch (e) {
    res.status(500).json({ error: 'db_error', detail: String(e.message || e) });
  }
};
