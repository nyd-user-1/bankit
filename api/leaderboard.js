// GET /api/leaderboard?game=bankit|singit|ttt|four|memory|mix → { rows:[{name, avatar, value}] } (top 10)
// GET /api/leaderboard?name=Frogman → { stats:{ bankit:{…}, singit:n, ttt:n, four:n, memory:n, mix:n } }
// Every game keeps its own measure: Bank It lifetime points, Mix It first discoveries,
// the rest the sum of their game_scores rows (wins, or points for Memory).
const { getPool } = require('./_db');

const SUMMED = new Set(['singit', 'ttt', 'four', 'memory', 'vault', 'dots', 'mancala', 'rps', 'battle', 'checkers', 'reversi', 'scramble', 'echo', 'react']);

module.exports = async (req, res) => {
  if (req.method !== 'GET') { res.status(405).json({ error: 'GET only' }); return; }
  const pool = getPool();
  try {
    const name = String((req.query && req.query.name) || '').trim();
    if (name) {
      const key = name.toLowerCase();
      const [bank, sums, mix] = await Promise.all([
        pool.query(`SELECT total_points, runs, sweeps, best FROM players WHERE name_key = $1`, [key]),
        pool.query(`SELECT game, SUM(score)::int AS v FROM game_scores WHERE name_key = $1 GROUP BY game`, [key]),
        pool.query(`SELECT count(*)::int AS v FROM mix_items WHERE lower(first_by) = $1`, [key]),
      ]);
      const stats = { bankit: bank.rows[0] || null, mix: mix.rows[0] ? mix.rows[0].v : 0 };
      for (const g of SUMMED) stats[g] = 0;
      sums.rows.forEach(r => { stats[r.game] = r.v; });
      res.status(200).json({ stats });
      return;
    }
    const game = String((req.query && req.query.game) || '');
    let rows;
    if (game === 'bankit') {
      rows = (await pool.query(
        `SELECT name, avatar, total_points AS value FROM players WHERE total_points > 0 ORDER BY total_points DESC, updated_at LIMIT 10`)).rows;
    } else if (game === 'mix') {
      rows = (await pool.query(
        `SELECT max(m.first_by) AS name, coalesce(max(p.avatar), '🧪') AS avatar, count(*)::int AS value
           FROM mix_items m LEFT JOIN players p ON p.name_key = lower(m.first_by)
          WHERE m.first_by IS NOT NULL GROUP BY lower(m.first_by) ORDER BY value DESC LIMIT 10`)).rows;
    } else if (SUMMED.has(game)) {
      rows = (await pool.query(
        `SELECT max(name) AS name, (array_agg(avatar ORDER BY created_at DESC))[1] AS avatar, SUM(score)::int AS value
           FROM game_scores WHERE game = $1 GROUP BY name_key HAVING SUM(score) > 0 ORDER BY value DESC LIMIT 10`, [game])).rows;
    } else { res.status(400).json({ error: 'Unknown game.' }); return; }
    res.status(200).json({ rows });
  } catch (e) {
    console.error('leaderboard error:', e);
    res.status(500).json({ error: 'Could not load the leaderboard.' });
  }
};
