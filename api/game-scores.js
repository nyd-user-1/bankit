// POST /api/game-scores — record one finished game. Body: { game, name, avatar, score }.
// Bank It posts to /api/scores instead; Mix It's leaderboard is its First Discoveries.
// Vault posts each night's take (coins).
const { getPool } = require('./_db');

const GAMES = new Set(['singit', 'ttt', 'four', 'memory', 'vault', 'dots', 'mancala', 'rps', 'battle', 'checkers', 'reversi', 'scramble', 'echo']);

module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.status(405).json({ error: 'POST only' }); return; }
  try {
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
    body = body || {};
    const game = String(body.game || '');
    const name = String(body.name || '').trim().replace(/\s+/g, ' ').slice(0, 24);
    const avatar = String(body.avatar || '🎯').slice(0, 8);
    const score = Math.max(0, Math.min(1000, parseInt(body.score, 10) || 0));
    if (!GAMES.has(game) || name.length < 2) { res.status(400).json({ error: 'Bad score.' }); return; }
    await getPool().query(
      `INSERT INTO game_scores (game, name_key, name, avatar, score) VALUES ($1, lower($2), $2, $3, $4)`,
      [game, name, avatar, score]);
    res.status(201).json({ ok: true });
  } catch (e) {
    console.error('game-scores error:', e);
    res.status(500).json({ error: 'Could not save the score.' });
  }
};
