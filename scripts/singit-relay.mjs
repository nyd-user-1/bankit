// Sing It relay: a dumb WebSocket room fan-out. The HOST's browser referees the game
// (turns, race, timers, track); this only groups sockets by room code and forwards
// messages, stamping `from` with the sender's client id so nobody can speak for
// someone else. Nothing is stored. Mounted on /ws by scripts/dev-server.mjs.
//   client → {t:'create'}            → {t:'created', room}
//   client → {t:'join', room}        → {t:'joined', room} | {t:'error', error}
//   client → anything else           → forwarded to everyone else in the room
//   host socket closes               → {t:'host-left'} to the room, room removed
//   player socket closes             → {t:'left', from} to the room
import { WebSocketServer } from 'ws';

const rooms = new Map();   // code → { host: cid, socks: Map(cid → ws) }

function newCode() {
  for (let i = 0; i < 50; i++) {
    const c = String(1000 + Math.floor(Math.random() * 9000));
    if (!rooms.has(c)) return c;
  }
  return null;
}

const send = (ws, msg) => { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); };

export function attachRelay(server, path = '/ws') {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname !== path) return;   // not ours (e.g. /chat) — another handler takes it
    const cid = (url.searchParams.get('cid') || '').replace(/[^a-z0-9]/gi, '').slice(0, 24);
    if (!cid) { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => { ws.cid = cid; wss.emit('connection', ws); });
  });

  wss.on('connection', (ws) => {
    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      if (!msg || typeof msg.t !== 'string' || msg.t === 'ping') return;   // ping = keep-alive

      if (msg.t === 'create') {
        const code = newCode();
        if (!code) { send(ws, { t: 'error', error: 'No free rooms — try again.' }); return; }
        rooms.set(code, { host: ws.cid, socks: new Map([[ws.cid, ws]]) });
        ws.room = code;
        send(ws, { t: 'created', room: code });
        return;
      }
      if (msg.t === 'join') {
        const r = rooms.get(String(msg.room || ''));
        if (!r) { send(ws, { t: 'error', error: 'No room with that code — check the digits.' }); return; }
        const old = r.socks.get(ws.cid);
        if (old && old !== ws) { old.room = null; old.close(); }   // same player, new tab/reload
        r.socks.set(ws.cid, ws);
        ws.room = String(msg.room);
        send(ws, { t: 'joined', room: ws.room, host: r.host });
        return;
      }

      const r = ws.room && rooms.get(ws.room);
      if (!r) return;
      const out = JSON.stringify({ ...msg, from: ws.cid });
      for (const [cid, s] of r.socks) if (cid !== ws.cid && s.readyState === 1) s.send(out);
    });

    ws.on('close', () => {
      const r = ws.room && rooms.get(ws.room);
      if (!r || r.socks.get(ws.cid) !== ws) return;
      r.socks.delete(ws.cid);
      if (ws.cid === r.host) {
        for (const s of r.socks.values()) send(s, { t: 'host-left' });
        rooms.delete(ws.room);
      } else {
        for (const s of r.socks.values()) send(s, { t: 'left', from: ws.cid });
      }
    });
  });
}
