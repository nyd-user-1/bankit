// GET /api/play?g=<slug>&by=<name> → the generated page of a player-built game (text/html).
// A game is owner-only until an admin flips is_public; the invite link carries by=<owner>, so a
// friend joining through it gets in too (the link is the secret, in the spirit of username-only auth).
const { getPool } = require('./_db');

const page = (title, text) => `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /><title>${title}</title>
<link rel="stylesheet" href="/shell.css" /><style>body{margin:0;min-height:100dvh;display:grid;place-items:center;background:#ff7a3c;font-family:Nunito,system-ui,sans-serif;font-weight:800;color:#2a1a3e}
.c{background:#fffaf2;border-radius:24px;padding:32px 36px;max-width:420px;text-align:center;box-shadow:0 10px 0 #a8320a}.c a{color:#7a6385}</style></head>
<body><div class="c"><h2 style="font-family:'Luckiest Guy',system-ui;font-weight:400;font-size:28px;margin:0 0 10px">${title}</h2><p>${text}</p><a href="/games.html">Games</a></div></body></html>`;

module.exports = async (req, res) => {
  if (req.method !== 'GET') { res.status(405).json({ error: 'GET only' }); return; }
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  try {
    const slug = String((req.query && req.query.g) || '').trim().toLowerCase();
    const by = String((req.query && req.query.by) || '').trim().replace(/\s+/g, ' ').toLowerCase();
    if (!/^[a-z0-9-]{1,80}$/.test(slug)) { res.status(400).send(page('No such game', 'That link is missing the game.')); return; }
    const { rows } = await getPool().query(`SELECT html, owner_key, is_public FROM player_games WHERE slug = $1`, [slug]);
    const g = rows[0];
    if (!g) { res.status(404).send(page('No such game', 'This game does not exist, or it was removed.')); return; }
    if (!g.is_public && g.owner_key !== by) { res.status(403).send(page('Not yet', 'This game is private until its maker shares an invite link.')); return; }
    res.status(200).send(g.html);
  } catch (e) {
    console.error('play error:', e);
    res.status(500).send(page('Something went wrong', 'Try again in a moment.'));
  }
};
