// GET /api/boards — all active boards with their answers (replaces the hardcoded BOARDS array)
const { getPool } = require('./_db');

const COLORS = ['purple', 'teal', 'pink', 'green'];

module.exports = async (req, res) => {
  if (req.method !== 'GET') { res.status(405).json({ error: 'GET only' }); return; }
  try {
    const pool = getPool();
    const { rows: boards } = await pool.query(
      `SELECT id, slug, title, icon, color_slot
         FROM boards
        WHERE is_active = TRUE
          AND (owner_key IS NULL OR (is_public AND is_approved))
        ORDER BY sort_order, id`
    );
    const { rows: answers } = await pool.query(
      `SELECT board_id, text, on_list
         FROM board_answers
         ORDER BY board_id, sort_order`
    );
    const byBoard = {};
    for (const a of answers) (byBoard[a.board_id] ||= []).push(a);

    const out = boards.map((b) => {
      const tiles = byBoard[b.id] || [];
      return {
        id: b.id,
        slug: b.slug,
        title: b.title,
        icon: b.icon,
        color: COLORS[b.color_slot] || 'purple',
        colorSlot: b.color_slot,
        answers: tiles.filter((t) => t.on_list).map((t) => t.text),
        decoys: tiles.filter((t) => !t.on_list).map((t) => t.text),
      };
    });
    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300');
    res.status(200).json({ boards: out });
  } catch (e) {
    res.status(500).json({ error: 'db_error', detail: String(e.message || e) });
  }
};
