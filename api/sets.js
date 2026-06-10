// Custom sets (player-created boards).
// POST /api/sets        — create one (10 answers + 10 decoys), owned by a username.
// GET  /api/sets?owner= — that player's sets, shaped like /api/boards entries so the
//                         client can drop them straight into BOARDS and play them.
// Custom sets are stored is_public=TRUE + is_approved=FALSE: submitted for everyone,
// hidden from the global catalog until a later moderation pass approves them.
const { getPool } = require('./_db');

function slugify(s) {
  return String(s).toLowerCase().replace(/[‘’']/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'set';
}

module.exports = async (req, res) => {
  const pool = getPool();
  try {
    if (req.method === 'GET') {
      const owner = String((req.query && req.query.owner) || '').trim().toLowerCase();
      if (!owner) { res.status(400).json({ error: 'owner required' }); return; }
      const { rows: boards } = await pool.query(
        `SELECT id, slug, title, icon, color_slot, is_approved
           FROM boards WHERE owner_key = $1 AND is_active
          ORDER BY created_at DESC, id DESC`, [owner]
      );
      const byBoard = {};
      if (boards.length) {
        const { rows: answers } = await pool.query(
          `SELECT board_id, text, on_list FROM board_answers
            WHERE board_id = ANY($1) ORDER BY board_id, sort_order`,
          [boards.map((b) => b.id)]
        );
        for (const a of answers) (byBoard[a.board_id] ||= []).push(a);
      }
      res.status(200).json({
        sets: boards.map((b) => ({
          id: b.id, slug: b.slug, title: b.title, icon: b.icon,
          colorSlot: b.color_slot, isApproved: b.is_approved,
          answers: (byBoard[b.id] || []).filter((t) => t.on_list).map((t) => t.text),
          decoys: (byBoard[b.id] || []).filter((t) => !t.on_list).map((t) => t.text),
        })),
      });
      return;
    }

    if (req.method === 'POST') {
      let body = req.body;
      if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
      body = body || {};
      const ownerName = String(body.owner_name || '').trim();
      const ownerKey = ownerName.toLowerCase();
      const title = String(body.title || '').trim().replace(/\s+/g, ' ').slice(0, 60);
      const icon = String(body.icon || '🎯').slice(0, 8);
      const colorSlot = [0, 1, 2, 3, 4, 5, 6].includes(+body.color_slot) ? +body.color_slot : 0;
      const clean = (a) => Array.isArray(a)
        ? a.map((t) => String(t).trim().replace(/\s+/g, ' ').slice(0, 40)).filter(Boolean) : [];
      const answers = clean(body.answers), decoys = clean(body.decoys);

      if (ownerKey.length < 2) { res.status(400).json({ error: 'Sign in first.' }); return; }
      if (title.length < 2) { res.status(400).json({ error: 'Title needs at least 2 letters.' }); return; }
      if (answers.length !== 10 || decoys.length !== 10) {
        res.status(400).json({ error: 'Need exactly 10 answers and 10 decoys.' }); return;
      }
      const seen = new Set();
      for (const t of [...answers, ...decoys]) {
        const k = t.toLowerCase();
        if (seen.has(k)) { res.status(400).json({ error: `"${t}" appears twice.` }); return; }
        seen.add(k);
      }

      const base = `custom-${slugify(ownerKey)}-${slugify(title)}`;
      let slug = base;
      for (let n = 2; n <= 50; n++) {
        const { rows } = await pool.query(`SELECT 1 FROM boards WHERE slug = $1`, [slug]);
        if (!rows.length) break;
        slug = `${base}-${n}`;
      }
      const { rows: [b] } = await pool.query(
        `INSERT INTO boards (slug, title, icon, color_slot, sort_order, owner_key, is_public, is_approved)
         VALUES ($1, $2, $3, $4, 0, $5, TRUE, FALSE) RETURNING id`,
        [slug, title, icon, colorSlot, ownerKey]
      );
      const tiles = [
        ...answers.map((t, j) => [b.id, t, true, j]),
        ...decoys.map((t, j) => [b.id, t, false, 100 + j]),
      ];
      for (const [bid, text, on, ord] of tiles) {
        await pool.query(
          `INSERT INTO board_answers (board_id, text, on_list, sort_order) VALUES ($1, $2, $3, $4)`,
          [bid, text, on, ord]
        );
      }
      res.status(200).json({
        ok: true,
        set: { id: b.id, slug, title, icon, colorSlot, isApproved: false, answers, decoys },
      });
      return;
    }

    res.status(405).json({ error: 'GET or POST only' });
  } catch (e) {
    res.status(500).json({ error: 'db_error', detail: String(e.message || e) });
  }
};
