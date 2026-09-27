// POST /api/mix — combine two items. Body: { a, b, by? }.
// GET /api/mix?item=Steam — every saved recipe for one item: { recipes:[{a,ae,b,be}] }.
// Returns { name, emoji, first } — first = nobody had ever made this item before.
// A pair's result is saved forever the first time anyone tries it, so every later player
// gets the same answer instantly; only never-tried pairs reach the model (Claude Haiku on
// Bedrock, ~$0.001). Both inputs must already exist as items, so the route can't be used
// to generate arbitrary text.
const { AnthropicBedrock } = require('@anthropic-ai/bedrock-sdk');
const { getPool } = require('./_db');
const BEDROCK_MODEL = 'us.anthropic.claude-haiku-4-5-20251001-v1:0';

const keyOf = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 40);
const titleCase = (s) => s.replace(/\b([a-z])/g, (m) => m.toUpperCase());

async function invent(a, b) {
  const client = new AnthropicBedrock({ awsRegion: process.env.AWS_REGION || 'us-east-1' });
  const response = await client.messages.create({
    model: BEDROCK_MODEL,
    max_tokens: 60,
    temperature: 0.7,
    system:
      'You are the crafting engine of a combining game. Players merge two things and you say what they make together. ' +
      'Be intuitive and a little clever, the way people would guess: Water + Fire = Steam, Earth + Water = Mud, ' +
      'Fire + Earth = Lava, Wind + Water = Wave, Plant + Time = Tree. ' +
      'Rules: ONE thing; 1-3 words; Title Case; a noun anyone would recognize (objects, materials, creatures, places, ' +
      'foods, jobs, well-known characters and brands are all fine); family-friendly; return one of the inputs only when ' +
      'nothing better fits. Pick one emoji that shows it. ' +
      'Reply with ONLY a JSON object {"result":"...","emoji":"..."} — no prose, no code fences.',
    messages: [{ role: 'user', content: `${a} + ${b}` }],
  });
  const block = response.content.find((x) => x.type === 'text');
  const text = String((block && block.text) || '').replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  const s = text.indexOf('{'), e = text.lastIndexOf('}');
  const parsed = JSON.parse(s >= 0 && e > s ? text.slice(s, e + 1) : text);
  const name = titleCase(String(parsed.result || '').replace(/[^\p{L}\p{N}' &.-]/gu, ' ').replace(/\s+/g, ' ').trim()).slice(0, 40);
  const emoji = String(parsed.emoji || '').trim().slice(0, 8) || '✨';
  if (!name) throw new Error('empty result');
  return { name, emoji };
}

module.exports = async (req, res) => {
  if (req.method === 'GET') {
    try {
      const k = keyOf(req.query && req.query.item);
      if (!k) { res.status(400).json({ error: 'Which item?' }); return; }
      const { rows } = await getPool().query(
        `SELECT ia.name AS a, ia.emoji AS ae, ib.name AS b, ib.emoji AS be FROM mix_recipes r
           JOIN mix_items ia ON ia.name_key = r.a_key JOIN mix_items ib ON ib.name_key = r.b_key
          WHERE r.result_key = $1 LIMIT 300`, [k]);
      res.status(200).json({ recipes: rows });
    } catch (e) {
      console.error('mix recipes error:', e);
      res.status(500).json({ error: 'Could not load recipes.' });
    }
    return;
  }
  if (req.method !== 'POST') { res.status(405).json({ error: 'GET or POST only' }); return; }
  try {
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
    body = body || {};
    const [ka, kb] = [keyOf(body.a), keyOf(body.b)].sort();
    const by = String(body.by || '').trim().slice(0, 24) || null;
    if (!ka || !kb) { res.status(400).json({ error: 'Two items, please.' }); return; }
    const pool = getPool();

    // 1) a pair someone already tried: the saved answer
    const hit = await pool.query(
      `SELECT i.name, i.emoji FROM mix_recipes r JOIN mix_items i ON i.name_key = r.result_key
        WHERE r.a_key = $1 AND r.b_key = $2`, [ka, kb]);
    if (hit.rows[0]) { res.status(200).json({ ...hit.rows[0], first: false }); return; }

    // 2) both inputs must be real items
    const { rows: inputs } = await pool.query(
      `SELECT name_key, name FROM mix_items WHERE name_key = ANY($1::text[])`, [[ka, kb]]);
    const names = Object.fromEntries(inputs.map((r) => [r.name_key, r.name]));
    if (!names[ka] || !names[kb]) { res.status(400).json({ error: 'Unknown item.' }); return; }

    // 3) a never-tried pair: invent it, then save the item (if new) and the recipe
    const made = await invent(names[ka], names[kb]);
    const rk = keyOf(made.name);
    const ins = await pool.query(
      `INSERT INTO mix_items (name_key, name, emoji, first_by) VALUES ($1, $2, $3, $4)
       ON CONFLICT (name_key) DO NOTHING RETURNING name_key`, [rk, made.name, made.emoji, by]);
    const first = ins.rows.length > 0;
    const rec = await pool.query(
      `INSERT INTO mix_recipes (a_key, b_key, result_key) VALUES ($1, $2, $3)
       ON CONFLICT (a_key, b_key) DO NOTHING RETURNING result_key`, [ka, kb, rk]);
    if (!rec.rows.length) {
      // someone else saved this pair a moment earlier: theirs wins, everyone agrees
      const again = await pool.query(
        `SELECT i.name, i.emoji FROM mix_recipes r JOIN mix_items i ON i.name_key = r.result_key
          WHERE r.a_key = $1 AND r.b_key = $2`, [ka, kb]);
      res.status(200).json({ ...again.rows[0], first: false }); return;
    }
    const item = first ? made : (await pool.query(`SELECT name, emoji FROM mix_items WHERE name_key = $1`, [rk])).rows[0];
    res.status(200).json({ ...item, first });
  } catch (e) {
    console.error('mix route error:', e);
    res.status(500).json({ error: 'Could not mix those — try again.' });
  }
};
