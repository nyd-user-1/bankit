// The builder: turns an approved plan (game_requests.spec) into a playable page in player_games.
// Runs in the bankit-builder Lambda (aws/builder-handler.js) in prod, in-process on the dev server.
//   build(id) → { gameId, slug } or throws (and marks the request 'failed')
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { getPool } = require('./_db');
const { ask, MODELS } = require('./_ai');

const AWS_DIR = path.join(__dirname, '..', 'aws');
const read = (f) => fs.readFileSync(path.join(AWS_DIR, f), 'utf8');
const jsonb = (v) => (typeof v === 'string' ? JSON.parse(v) : v);
const slugify = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'game';

function extractHtml(text) {
  const m = text.match(/```html\s*([\s\S]*?)```/i);
  let h = m ? m[1] : text;
  const s = h.indexOf('<!DOCTYPE'), e = h.lastIndexOf('</html>');
  if (s >= 0 && e > s) h = h.slice(s, e + 7);
  return h.trim();
}
// what must be true of a page before it is served
function check(html) {
  const problems = [];
  if (!/<script src="\/shell\.js"><\/script>/.test(html)) problems.push('the page must load <script src="/shell.js"></script>');
  if (!/href="\/shell\.css"/.test(html)) problems.push('the page must load <link rel="stylesheet" href="/shell.css" />');
  if (!/Shell\.init\(/.test(html)) problems.push('Shell.init(...) is never called');
  if (!/id="introGo"/.test(html)) problems.push('the intro card needs the #introGo button');
  const srcs = [...html.matchAll(/<script[^>]*\ssrc="([^"]+)"/g)].map((m) => m[1]).filter((s) => s !== '/shell.js');
  if (srcs.length) problems.push('no other scripts are allowed: ' + srcs.join(', '));
  if (/\b(fetch|XMLHttpRequest|WebSocket|eval)\s*\(/.test(html.replace(/Shell\.[a-zA-Z]+\(/g, ''))) problems.push('no fetch/XMLHttpRequest/WebSocket/eval calls');
  if (/[A-Z ]{4,}\.<\/span>|GAME TITLE|RULE ONE/.test(html)) problems.push('placeholder text from the skeleton is still in the page');
  for (const m of html.matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/g)) {
    try { new vm.Script(m[1]); } catch (e) { problems.push('JavaScript syntax error: ' + e.message); }
  }
  return problems;
}

async function build(id) {
  const pool = getPool();
  const { rows } = await pool.query(`SELECT id, name, requested_by, spec FROM game_requests WHERE id = $1`, [id]);
  const r = rows[0];
  if (!r || !r.spec) throw new Error('no plan to build');
  const spec = jsonb(r.spec);
  const slug = `${slugify(spec.title)}-${r.id}`;
  const system = read('game-playbook.md') + '\n\n## The skeleton\n\n```html\n' + read('game-skeleton.html') + '\n```';
  const messages = [{ role: 'user', content:
    `Build this game as one complete HTML page.\n\nThe plan the kid approved:\n${JSON.stringify(spec, null, 2)}\n\n` +
    `Use "${slug}" as the FRIEND.game tag. The kid's name for the game is "${spec.title}"; the maker is ${r.requested_by}.` }];
  const usage = { input: 0, output: 0 };
  let html = '', problems = [];
  try {
    for (let attempt = 1; attempt <= 2; attempt++) {
      const out = await ask({ model: MODELS.build, system, messages, max_tokens: 24000, timeout: 780000 });
      usage.input += out.usage.input; usage.output += out.usage.output;
      html = extractHtml(out.text);
      problems = html.length < 2000 ? ['the page came back empty or truncated'] : check(html);
      if (!problems.length) break;
      console.log(`build ${id}: attempt ${attempt} problems:`, problems);
      messages.push({ role: 'assistant', content: out.text });
      messages.push({ role: 'user', content: 'Fix these problems and return the complete page again, in one ```html fence:\n- ' + problems.join('\n- ') });
    }
    if (problems.length) throw new Error(problems.join('; '));
    const g = await pool.query(
      `INSERT INTO player_games (request_id, owner_key, owner, slug, title, emoji, color, html, model, tokens_in, tokens_out)
         VALUES ($1, lower($2), $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (slug) DO UPDATE SET title = EXCLUDED.title, emoji = EXCLUDED.emoji, color = EXCLUDED.color, html = EXCLUDED.html,
           model = EXCLUDED.model, tokens_in = EXCLUDED.tokens_in, tokens_out = EXCLUDED.tokens_out, created_at = now()
         RETURNING id`,
      [r.id, r.requested_by, slug, spec.title, spec.emoji || '🎮', spec.color || '#8b5cf6', html, MODELS.build, usage.input, usage.output]);
    await pool.query(`UPDATE game_requests SET status='built', game_id=$2, error=NULL, updated_at=now() WHERE id=$1`, [id, g.rows[0].id]);
    console.log(`build ${id}: built ${slug} (${html.length} chars, ${usage.input} in / ${usage.output} out, ${MODELS.build})`);
    return { gameId: g.rows[0].id, slug, usage };
  } catch (e) {
    await pool.query(`UPDATE game_requests SET status='failed', error=$2, updated_at=now() WHERE id=$1`, [id, String(e.message || e).slice(0, 500)]).catch(() => {});
    throw e;
  }
}

module.exports = { build, check, extractHtml };
