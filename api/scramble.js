// Scramble's shared word pool.
// GET  /api/scramble        → { words:[...] } every word (the 500 seeds + any the AI added)
// POST /api/scramble {by}   → { words:[...] } fresh words from Claude Haiku on Bedrock, saved for
//   everyone. The client only asks once a player has seen the whole pool, so the pool grows
//   slowly and the next player gets the new words for free.
const { AnthropicBedrock } = require('@anthropic-ai/bedrock-sdk');
const { getPool } = require('./_db');
const BEDROCK_MODEL = 'us.anthropic.claude-haiku-4-5-20251001-v1:0';
const OK = /^[a-z]{5,7}$/;

async function invent(avoid) {
  const client = new AnthropicBedrock({ awsRegion: process.env.AWS_REGION || 'us-east-1' });
  const response = await client.messages.create({
    model: BEDROCK_MODEL,
    max_tokens: 600,
    temperature: 1,
    system:
      'You supply words for a family word-unscrambling game. Give everyday English words that most ' +
      'ten-year-olds know: nouns, verbs or adjectives, 5 to 7 letters, lowercase, no proper nouns, ' +
      'no abbreviations, nothing rude, scary, about alcohol or about death. Reply with ONLY a JSON array of strings.',
    messages: [{ role: 'user', content: `40 new words. Not any of these: ${avoid.join(' ')}` }],
  });
  const block = response.content.find((x) => x.type === 'text');
  const text = String((block && block.text) || '');
  const s = text.indexOf('['), e = text.lastIndexOf(']');
  const arr = JSON.parse(s >= 0 && e > s ? text.slice(s, e + 1) : '[]');
  return [...new Set(arr.map((w) => String(w).trim().toLowerCase()).filter((w) => OK.test(w)))];
}

module.exports = async (req, res) => {
  const pool = getPool();
  try {
    if (req.method === 'GET') {
      const { rows } = await pool.query(`SELECT word FROM scramble_words ORDER BY created_at, word`);
      res.status(200).json({ words: rows.map((r) => r.word) });
      return;
    }
    if (req.method !== 'POST') { res.status(405).json({ error: 'GET or POST only' }); return; }
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
    const by = String((body && body.by) || '').trim().slice(0, 24) || null;
    const { rows } = await pool.query(`SELECT word FROM scramble_words ORDER BY created_at DESC LIMIT 700`);
    const made = await invent(rows.map((r) => r.word));
    const { rows: added } = made.length ? await pool.query(
      `INSERT INTO scramble_words (word, source, added_by) SELECT unnest($1::text[]), 'ai', $2
       ON CONFLICT DO NOTHING RETURNING word`, [made, by]) : { rows: [] };
    res.status(200).json({ words: added.map((r) => r.word) });
  } catch (e) {
    console.error('scramble route error:', e);
    res.status(500).json({ error: 'Could not load words.' });
  }
};
