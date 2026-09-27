// Platform chat: one room for every signed-in player, over a WebSocket on /chat.
// Mounted by scripts/dev-server.mjs next to the game relay. Messages are broadcast
// instantly and saved to chat_messages (Aurora); a new connection gets the last 100.
//   client → {t:'hello', name, avatar}   identify (required before saying anything)
//   client → {t:'say', text}             post a message (≤500 chars, ~1 per 0.7s)
//   server → {t:'hist', msgs} · {t:'msg', m} · {t:'presence', names} · {t:'error', error}
import { WebSocketServer } from 'ws';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { getPool } = require('../api/_db.js');

const HISTORY = 100;
let history = null;                       // last HISTORY messages, oldest first (lazy-loaded)
async function loadHistory() {
  if (history) return history;
  try {
    const { rows } = await getPool().query(
      `SELECT id, name, avatar, body, created_at FROM chat_messages ORDER BY created_at DESC LIMIT ${HISTORY}`);
    history = rows.reverse().map(r => ({ id: r.id, name: r.name, avatar: r.avatar, text: r.body, ts: new Date(r.created_at).getTime() }));
  } catch (e) { console.error('chat history load failed:', e.message); history = []; }
  return history;
}

export function attachChat(server, path = '/chat') {
  const wss = new WebSocketServer({ noServer: true });
  const send = (ws, m) => { if (ws.readyState === 1) ws.send(JSON.stringify(m)); };
  const everyone = m => { const s = JSON.stringify(m); for (const c of wss.clients) if (c.readyState === 1) c.send(s); };
  const presence = () => {
    const names = [...new Map([...wss.clients].filter(c => c.who).map(c => [c.who.name.toLowerCase(), c.who])).values()];
    everyone({ t: 'presence', names: names.map(w => ({ name: w.name, avatar: w.avatar })) });
  };

  server.on('upgrade', (req, socket, head) => {
    if (new URL(req.url, 'http://x').pathname !== path) return;
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws));
  });

  wss.on('connection', async ws => {
    ws.lastSay = 0;
    send(ws, { t: 'hist', msgs: await loadHistory() });
    presence();
    ws.on('message', async raw => {
      let m; try { m = JSON.parse(raw); } catch { return; }
      if (m.t === 'hist') return send(ws, { t: 'hist', msgs: await loadHistory() });
      if (m.t === 'hello') {
        const name = String(m.name || '').trim().replace(/\s+/g, ' ').slice(0, 24);
        if (name.length < 2) return;
        ws.who = { name, avatar: String(m.avatar || '🎯').slice(0, 8) };
        return presence();
      }
      if (m.t === 'say') {
        if (!ws.who) return send(ws, { t: 'error', error: 'Sign in to chat.' });
        const text = String(m.text || '').replace(/\s+/g, ' ').trim().slice(0, 500);
        if (!text) return;
        const now = Date.now();
        if (now - ws.lastSay < 700) return send(ws, { t: 'error', error: 'Slow down a little.' });
        ws.lastSay = now;
        const msg = { id: `t${now}${Math.random().toString(36).slice(2, 6)}`, name: ws.who.name, avatar: ws.who.avatar, text, ts: now };
        (await loadHistory()).push(msg); if (history.length > HISTORY) history.shift();
        everyone({ t: 'msg', m: msg });
        getPool().query(`INSERT INTO chat_messages (name_key, name, avatar, body) VALUES (lower($1), $1, $2, $3)`,
          [msg.name, msg.avatar, text]).catch(e => console.error('chat save failed:', e.message));
      }
    });
    ws.on('close', presence);
  });
}
