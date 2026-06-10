// POST /api/decoys — generate 10 plausible decoys for a custom set via Claude Haiku.
// Body: { title, answers[10], existing[] (decoys the user already typed) }.
// Returns { decoys: [10 strings] } that don't collide with answers or existing decoys.
// Costs ~$0.001 per call (Haiku, ~300 tokens in / ~150 out). Needs ANTHROPIC_API_KEY.
const Anthropic = require('@anthropic-ai/sdk');

const DECOY_SCHEMA = {
  type: 'object',
  properties: {
    decoys: { type: 'array', items: { type: 'string' } },
  },
  required: ['decoys'],
  additionalProperties: false,
};

module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.status(405).json({ error: 'POST only' }); return; }
  if (!process.env.ANTHROPIC_API_KEY) {
    res.status(503).json({ error: 'Decoy magic is not set up yet.' }); return;
  }
  try {
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
    body = body || {};
    const clean = (a) => Array.isArray(a)
      ? a.map((t) => String(t).trim().replace(/\s+/g, ' ').slice(0, 40)).filter(Boolean) : [];
    const title = String(body.title || '').trim().replace(/\s+/g, ' ').slice(0, 60);
    const answers = clean(body.answers).slice(0, 10);
    const existing = clean(body.existing).slice(0, 10);
    if (title.length < 2 || answers.length !== 10) {
      res.status(400).json({ error: 'Need a title and all 10 answers first.' }); return;
    }

    const client = new Anthropic();
    const taken = [...answers, ...existing];
    const response = await client.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 600,
      system:
        'You write decoy tiles for a party game board. The board names a category and hides a list of 10 real answers; ' +
        'players see 20 tiles (the 10 answers + 10 decoys) and must tap only real answers. ' +
        'Good decoys sit at REASONABLE PROXIMITY to the answers: same category/family, entirely plausible, so an average ' +
        'player scores 7-9 out of 10 — tempting near-misses, never absurd, never giveaway-wrong. ' +
        'Example: for "Girls\' Names With 4 Letters" the decoys are OTHER real 4-letter girls\' names — the trick is which ' +
        'names made the list, not name length. ' +
        'Rules: short Title-Case labels (under 40 characters), each distinct, and none may duplicate or trivially restate ' +
        'anything on the taken list you are given.',
      messages: [{
        role: 'user',
        content:
          `Category: ${title}\n` +
          `Taken (the real answers + decoys already in use — produce nothing that matches these): ${taken.join('; ')}\n\n` +
          'Produce exactly 14 candidate decoys for this category.',
      }],
      output_config: { format: { type: 'json_schema', schema: DECOY_SCHEMA } },
    });

    const block = response.content.find((b) => b.type === 'text');
    let parsed = null;
    try { parsed = JSON.parse(block && block.text); } catch (e) {}
    const seen = new Set(taken.map((t) => t.toLowerCase()));
    const decoys = [];
    for (const raw of (parsed && parsed.decoys) || []) {
      const t = String(raw).trim().replace(/\s+/g, ' ').slice(0, 40);
      const k = t.toLowerCase();
      if (!t || seen.has(k)) continue;
      seen.add(k);
      decoys.push(t);
      if (decoys.length === 10) break;
    }
    if (decoys.length < 10 - existing.length) {
      res.status(502).json({ error: 'Could not conjure enough decoys — try again.' }); return;
    }
    res.status(200).json({ decoys });
  } catch (e) {
    res.status(500).json({ error: 'decoy_error', detail: String(e.message || e) });
  }
};
