// /api/requests — the hub's "Request new" form, from the first submit to a built game.
//   POST {name, description, links, by}                → a new request + round 1 of questions    (status 'asking')
//   POST {action:'answer', id, by, answers:[{id,q,a}]} → the next round, or the write-up           (status 'proposed')
//   POST {action:'revise', id, by, note}               → "Not quite": one more round from the note
//   POST {action:'build',  id, by}                     → "Yes, build it": kicks the builder         (status 'building')
//   GET  ?by=name                                      → that player's requests + built games (My Games, the menu badge)
//   GET                                                → the latest 100 requests (admin)
// The interview runs on Claude Haiku (Bedrock). The build runs in api/_builder.js: a separate Lambda in
// prod (BUILDER_FUNCTION, invoked asynchronously), in-process on the dev server.
const { getPool } = require('./_db');
const { ask, json, MODELS } = require('./_ai');

const MAX_ROUNDS = 3, MAX_TURNS = 6;
const PALETTE = ['#ff7a3c', '#8b5cf6', '#1fc7b6', '#ff4d8d', '#2d6fd6', '#37c871', '#ffd23f', '#a64ca6', '#0e6fa8', '#c9713c', '#475569', '#84cc16'];

const SYSTEM = `You turn a kid's half-formed game idea into a clear plan for a small browser party game, by asking a few good questions and then writing the plan up as the kid's own invention. Keep it theirs: sharpen what they said, never swap in a different game, keep their name for it and their words where you can.

The platform: games run in a phone browser, all by tapping. A game is either solo against the computer, or two friends on their own phones over the internet (a host and a guest), or both. Rounds are short (one to five minutes). No video, mic, camera, drawing, heavy typing, or physics. Grids, cards, shapes, colors, numbers, words, emoji, timers, turns and scores are all easy.

Each round, ask 2 to 4 short questions, only about things you genuinely need to build the game: solo, with a friend, or both; what the board or screen looks like; what one turn or one moment of play is; how you score; how a game ends and who wins. Write for a kid of about ten: plain words, one idea per question, each question under 25 words. Never say I, me, we or let me: no chatter, no recap of what the kid said, just the question. Prefer "choice" (pick one), "multi" (pick any) and "bool" (yes or no) questions with 2 to 5 short options, the most likely option first; use "text" only when options can't cover it. Never ask what the kid already told you. Before writing the plan, check that the game can actually be won: no guaranteed ties, no unwinnable or endless games, nothing that needs a second screen the player can't see. If the kid's rules have a hole, spend one question on it and offer 2 to 4 ways to close it. At most 3 rounds; when you know enough, stop asking and write the plan.

Reply with JSON only: no prose, no code fences.
While asking: {"done":false,"questions":[{"id":"q1","q":"...","type":"choice","options":["...","..."]}]}
When done: {"done":true,"spec":{"title":"...","emoji":"one emoji","color":"one hex from the palette","pitch":"one sentence about the game, in the kid's voice","players":"solo|friend|both","how":["3 to 6 short steps of how it plays"],"win":"how a game ends and who wins","builder_notes":["every precise rule the builder needs: grid size, counts, timers, turn order, scoring, what the computer does if solo, edge cases"]}}
Palette: ${PALETTE.join(' ')}`;

const clean = (v, max) => String(v || '').replace(/\r\n?/g, '\n').trim().slice(0, max);
const key = (name) => clean(name, 24).replace(/\s+/g, ' ').toLowerCase();
const parseBody = (b) => { if (typeof b === 'string') { try { return JSON.parse(b); } catch (e) { return {}; } } return b || {}; };
const jsonb = (v) => (typeof v === 'string' ? JSON.parse(v) : v);

function tidyQuestions(qs) {
  const out = [];
  for (const q of Array.isArray(qs) ? qs : []) {
    const type = ['choice', 'multi', 'bool', 'text'].includes(q.type) ? q.type : 'text';
    const text = clean(q.q || q.question, 300);
    if (!text) continue;
    let options = (Array.isArray(q.options) ? q.options : []).map((o) => clean(o, 60)).filter(Boolean).slice(0, 6);
    if (type === 'bool') options = ['Yes', 'No'];
    if ((type === 'choice' || type === 'multi') && options.length < 2) continue;
    out.push({ id: clean(q.id, 12) || 'q' + (out.length + 1), q: text, type, options: type === 'text' ? [] : options });
    if (out.length === 4) break;
  }
  return out;
}
function tidySpec(s, fallbackTitle) {
  if (!s || typeof s !== 'object') return null;
  const list = (a, n, max) => (Array.isArray(a) ? a : []).map((x) => clean(x, max)).filter(Boolean).slice(0, n);
  const spec = {
    title: clean(s.title, 40) || fallbackTitle,
    emoji: clean(s.emoji, 8) || '🎮',
    color: PALETTE.includes(String(s.color || '').toLowerCase()) ? String(s.color).toLowerCase() : PALETTE[fallbackTitle.length % PALETTE.length],
    pitch: clean(s.pitch, 240),
    players: ['solo', 'friend', 'both'].includes(s.players) ? s.players : 'both',
    how: list(s.how, 6, 200),
    win: clean(s.win, 300),
    builder_notes: list(s.builder_notes, 20, 300),
  };
  return spec.how.length && spec.win ? spec : null;
}

// the referee: a stronger model reads a finished plan before the kid sees it and closes the holes
const REFEREE = `You check a kid's plan for a small browser party game before it goes to the builder. The platform: phone browser, all by tapping; solo against the computer and/or two friends on their own phones (host and guest); short rounds. Keep the kid's idea, title and words; change as little as possible.
Check that: the game can be won and always ends (no stalls, no guaranteed ties, no shared pool that runs out before anyone can finish, no turn without a legal move); each player's own actions move THAT player toward winning (a move that only helps the opponent, or does nothing, means the incentives are broken and the rule needs a real fix, not a note); a player never needs information they can't see; solo play and two-player play both work as described; the rules are precise enough to code (sizes, counts, timers, turn order, scoring, how it ends).
Fix each hole with the smallest change, reflect it in "how" and "win", and add a builder_notes entry starting with "Fix:" that says what changed and why. If the plan is sound, return it unchanged.
Reply with JSON only, no prose, no code fences, in exactly this shape: {"title":"...","emoji":"...","color":"#hex","pitch":"...","players":"solo|friend|both","how":["..."],"win":"...","builder_notes":["..."]}`;
async function referee(spec, fallbackTitle) {
  try {
    const r = await ask({ model: MODELS.build, system: REFEREE, messages: [{ role: 'user', content: JSON.stringify(spec, null, 2) }], max_tokens: 2500, timeout: 60000 });
    return tidySpec(json(r.text), fallbackTitle) || spec;
  } catch (e) { console.error('referee skipped:', e.message); return spec; }
}

// one model turn over the transcript so far → { questions } or { spec }
async function interview(row, transcript, mustFinish) {
  const messages = transcript.map((t) => ({ role: t.role, content: t.text }));
  if (mustFinish) messages[messages.length - 1] = { role: 'user', content: messages[messages.length - 1].content + '\n\nThis is the final round: do not ask anything more, return the plan now (done: true).' };
  const r = await ask({ model: MODELS.fast, system: SYSTEM, messages, max_tokens: 1500 });
  const out = json(r.text);
  if (!out) throw new Error('The model did not answer in JSON.');
  if (out.done || mustFinish) {
    const spec = tidySpec(out.spec, row.name);
    if (!spec) throw new Error('The model returned an unusable plan.');
    return { spec: await referee(spec, row.name), raw: r.text };
  }
  const questions = tidyQuestions(out.questions);
  if (!questions.length) throw new Error('The model returned no questions.');
  return { questions, raw: r.text };
}

async function step(pool, row, transcript, userText, res) {
  transcript.push({ role: 'user', text: userText });
  const mustFinish = row.round >= MAX_ROUNDS || transcript.length >= MAX_TURNS * 2;
  const turn = await interview(row, transcript, mustFinish);
  transcript.push({ role: 'assistant', text: turn.raw });
  if (turn.spec) {
    await pool.query(`UPDATE game_requests SET status='proposed', spec=$2::jsonb, transcript=$3::jsonb, updated_at=now() WHERE id=$1`, [row.id, JSON.stringify(turn.spec), JSON.stringify(transcript)]);
    res.status(200).json({ id: row.id, status: 'proposed', spec: turn.spec });
  } else {
    await pool.query(`UPDATE game_requests SET status='asking', round=$2, transcript=$3::jsonb, updated_at=now() WHERE id=$1`, [row.id, row.round + 1, JSON.stringify(transcript)]);
    res.status(200).json({ id: row.id, status: 'asking', round: row.round + 1, questions: turn.questions });
  }
}

async function kickBuild(id) {
  if (process.env.BUILDER_FUNCTION) {
    const { LambdaClient, InvokeCommand } = require('@aws-sdk/client-lambda');
    await new LambdaClient({ region: process.env.AWS_REGION || 'us-east-1' }).send(new InvokeCommand({
      FunctionName: process.env.BUILDER_FUNCTION, InvocationType: 'Event', Payload: Buffer.from(JSON.stringify({ id })) }));
  } else {
    setImmediate(() => require('./_builder').build(id).catch((e) => console.error('build failed:', e)));
  }
}

module.exports = async (req, res) => {
  const pool = getPool();
  try {
    if (req.method === 'GET') {
      const by = key(req.query && req.query.by);
      if (by) {
        const [reqs, games] = await Promise.all([
          pool.query(`SELECT id, name, status, round, spec->>'title' AS title, spec->>'emoji' AS emoji, game_id, error, created_at
                        FROM game_requests WHERE lower(requested_by) = $1 AND status <> 'new' ORDER BY id DESC LIMIT 20`, [by]),
          pool.query(`SELECT id, slug, title, emoji, color, is_public, created_at FROM player_games WHERE owner_key = $1 ORDER BY id DESC LIMIT 12`, [by]),
        ]);
        res.status(200).json({ requests: reqs.rows, games: games.rows });
        return;
      }
      const { rows } = await pool.query(
        `SELECT id, name, description, links, requested_by, status, round, spec, game_id, error, created_at FROM game_requests ORDER BY id DESC LIMIT 100`);
      res.status(200).json({ rows });
      return;
    }
    if (req.method !== 'POST') { res.status(405).json({ error: 'GET or POST only' }); return; }
    const body = parseBody(req.body);
    const by = clean(body.by, 24).replace(/\s+/g, ' ');
    if (by.length < 2) { res.status(401).json({ error: 'Sign in first.' }); return; }
    const action = String(body.action || 'create');

    if (action === 'create') {
      const name = clean(body.name, 60).replace(/\s+/g, ' ');
      const description = clean(body.description, 2000);
      const links = clean(body.links, 1000);
      if (name.length < 2) { res.status(400).json({ error: 'Give the game a name.' }); return; }
      if (description.length < 10) { res.status(400).json({ error: 'Tell us a bit about how it plays.' }); return; }
      const { rows } = await pool.query(
        `INSERT INTO game_requests (name, description, links, requested_by, status) VALUES ($1, $2, $3, $4, 'asking') RETURNING id, name, round`,
        [name, description, links, by]);
      const row = rows[0];
      const first = `Game name: ${name}\nThe kid's description: ${description}${links ? `\nExample links: ${links}` : ''}`;
      await step(pool, row, [], first, res);
      return;
    }

    const id = parseInt(body.id, 10);
    const { rows } = await pool.query(`SELECT id, name, status, round, transcript, spec, requested_by FROM game_requests WHERE id = $1`, [id]);
    const row = rows[0];
    if (!row || String(row.requested_by || '').toLowerCase() !== by.toLowerCase()) { res.status(404).json({ error: 'No such request.' }); return; }
    const transcript = jsonb(row.transcript) || [];

    if (action === 'answer') {
      if (row.status !== 'asking') { res.status(409).json({ error: 'No questions are waiting.' }); return; }
      const answers = (Array.isArray(body.answers) ? body.answers : []).map((a) => ({ q: clean(a.q, 240), a: clean(a.a, 300) })).filter((a) => a.q && a.a).slice(0, 4);
      if (!answers.length) { res.status(400).json({ error: 'Answer at least one question.' }); return; }
      await step(pool, row, transcript, 'The kid answers:\n' + answers.map((a) => `- ${a.q} → ${a.a}`).join('\n'), res);
      return;
    }
    if (action === 'revise') {
      if (row.status !== 'proposed') { res.status(409).json({ error: 'There is no plan to change yet.' }); return; }
      const note = clean(body.note, 500);
      if (note.length < 3) { res.status(400).json({ error: 'Say what should change.' }); return; }
      row.round = Math.max(row.round, MAX_ROUNDS - 1);      // one round of follow-ups at most, then the revised plan
      await step(pool, row, transcript, `The kid says the plan isn't quite right: "${note}"\nAsk 1 to 3 follow-up questions only if you truly need them; otherwise return the revised plan (done: true).`, res);
      return;
    }
    if (action === 'build') {
      if (!['proposed', 'failed'].includes(row.status) || !row.spec) { res.status(409).json({ error: 'Nothing to build yet.' }); return; }
      await pool.query(`UPDATE game_requests SET status='building', error=NULL, updated_at=now() WHERE id=$1`, [id]);
      await kickBuild(id);
      res.status(200).json({ id, status: 'building' });
      return;
    }
    res.status(400).json({ error: 'Unknown action.' });
  } catch (e) {
    console.error('requests error:', e);
    res.status(500).json({ error: 'Something went wrong. Try again.' });
  }
};
