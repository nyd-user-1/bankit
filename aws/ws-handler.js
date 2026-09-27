// Lambda behind the API Gateway WebSocket API: the production twin of scripts/singit-relay.mjs
// (game rooms, ?ch=relay) and scripts/chat-server.mjs (platform chat, ?ch=chat), same messages.
// State lives in DynamoDB table WS_TABLE (pk):
//   c#<connectionId> → { ch, cid, room, name, avatar, lastSay }
//   r#<code>         → { host: cid, socks: { cid: connectionId } }
//   chat             → { conns: { connectionId: { name, avatar } } }
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand, DeleteCommand } = require('@aws-sdk/lib-dynamodb');
const { ApiGatewayManagementApiClient, PostToConnectionCommand, DeleteConnectionCommand } = require('@aws-sdk/client-apigatewaymanagementapi');
const { getPool } = require('./api/_db.js');

const T = process.env.WS_TABLE;
const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
let gw;
const get = async (pk) => (await db.send(new GetCommand({ TableName: T, Key: { pk } }))).Item;
const put = (Item) => db.send(new PutCommand({ TableName: T, Item }));
const del = (pk) => db.send(new DeleteCommand({ TableName: T, Key: { pk } }));

async function post(id, msg) {
  try { await gw.send(new PostToConnectionCommand({ ConnectionId: id, Data: JSON.stringify(msg) })); return true; }
  catch (e) { if (e.$metadata && e.$metadata.httpStatusCode === 410) return false; console.error('post', e.name); return true; }
}

//// ===== game rooms =====
async function relay(id, conn, m) {
  if (m.t === 'ping') return;
  if (m.t === 'create') {
    for (let i = 0; i < 50; i++) {
      const code = String(1000 + Math.floor(Math.random() * 9000));
      try {
        await db.send(new PutCommand({ TableName: T, Item: { pk: 'r#' + code, host: conn.cid, socks: { [conn.cid]: id }, ttl: now() + 86400 },
          ConditionExpression: 'attribute_not_exists(pk)' }));
        await db.send(new UpdateCommand({ TableName: T, Key: { pk: 'c#' + id }, UpdateExpression: 'SET room = :r', ExpressionAttributeValues: { ':r': code } }));
        return post(id, { t: 'created', room: code });
      } catch (e) { if (e.name !== 'ConditionalCheckFailedException') throw e; }
    }
    return post(id, { t: 'error', error: 'No free rooms — try again.' });
  }
  if (m.t === 'join') {
    const code = String(m.room || '');
    const r = /^\d{4}$/.test(code) && await get('r#' + code);
    if (!r) return post(id, { t: 'error', error: 'No room with that code — check the digits.' });
    const old = r.socks[conn.cid];
    await db.send(new UpdateCommand({ TableName: T, Key: { pk: 'r#' + code }, UpdateExpression: 'SET socks.#c = :id',
      ExpressionAttributeNames: { '#c': conn.cid }, ExpressionAttributeValues: { ':id': id } }));
    await db.send(new UpdateCommand({ TableName: T, Key: { pk: 'c#' + id }, UpdateExpression: 'SET room = :r', ExpressionAttributeValues: { ':r': code } }));
    if (old && old !== id) {                                  // same player, new tab/reload
      await db.send(new UpdateCommand({ TableName: T, Key: { pk: 'c#' + old }, UpdateExpression: 'REMOVE room' })).catch(() => {});
      await gw.send(new DeleteConnectionCommand({ ConnectionId: old })).catch(() => {});
    }
    return post(id, { t: 'joined', room: code, host: r.host });
  }
  const r = conn.room && await get('r#' + conn.room);
  if (!r) return;
  const out = { ...m, from: conn.cid };
  await Promise.all(Object.entries(r.socks).filter(([cid]) => cid !== conn.cid).map(([, sid]) => post(sid, out)));
}
async function relayLeft(id, conn) {
  const r = conn.room && await get('r#' + conn.room);
  if (!r || r.socks[conn.cid] !== id) return;
  if (conn.cid === r.host) {
    await Promise.all(Object.entries(r.socks).filter(([cid]) => cid !== conn.cid).map(([, sid]) => post(sid, { t: 'host-left' })));
    return del('r#' + conn.room);
  }
  await db.send(new UpdateCommand({ TableName: T, Key: { pk: 'r#' + conn.room }, UpdateExpression: 'REMOVE socks.#c', ExpressionAttributeNames: { '#c': conn.cid } }));
  await Promise.all(Object.entries(r.socks).filter(([cid]) => cid !== conn.cid).map(([, sid]) => post(sid, { t: 'left', from: conn.cid })));
}

//// ===== chat =====
async function everyone(msg) {
  const c = await get('chat'); if (!c || !c.conns) return;
  const gone = [];
  await Promise.all(Object.keys(c.conns).map(async (sid) => { if (!(await post(sid, msg))) gone.push(sid); }));
  for (const sid of gone) await chatDrop(sid);
}
async function presence() {
  const c = await get('chat'); const seen = new Map();
  Object.values((c && c.conns) || {}).forEach((w) => { if (w.name) seen.set(w.name.toLowerCase(), { name: w.name, avatar: w.avatar }); });
  await everyone({ t: 'presence', names: [...seen.values()] });
}
async function chatDrop(sid) {
  await db.send(new UpdateCommand({ TableName: T, Key: { pk: 'chat' }, UpdateExpression: 'REMOVE conns.#s', ExpressionAttributeNames: { '#s': sid } })).catch(() => {});
}
async function history() {
  const { rows } = await getPool().query(`SELECT id, name, avatar, body, created_at FROM chat_messages ORDER BY created_at DESC LIMIT 100`);
  return rows.reverse().map((r) => ({ id: r.id, name: r.name, avatar: r.avatar, text: r.body, ts: new Date(r.created_at).getTime() }));
}
async function chat(id, conn, m) {
  if (m.t === 'hist') return post(id, { t: 'hist', msgs: await history().catch(() => []) });
  if (m.t === 'hello') {
    const name = String(m.name || '').trim().replace(/\s+/g, ' ').slice(0, 24);
    if (name.length < 2) return;
    const who = { name, avatar: String(m.avatar || '🎯').slice(0, 8) };
    await db.send(new UpdateCommand({ TableName: T, Key: { pk: 'c#' + id }, UpdateExpression: 'SET #n = :n, avatar = :a', ExpressionAttributeNames: { '#n': 'name' }, ExpressionAttributeValues: { ':n': who.name, ':a': who.avatar } }));
    await db.send(new UpdateCommand({ TableName: T, Key: { pk: 'chat' }, UpdateExpression: 'SET conns.#s = :w', ExpressionAttributeNames: { '#s': id }, ExpressionAttributeValues: { ':w': who } }));
    return presence();
  }
  if (m.t === 'say') {
    if (!conn.name) return post(id, { t: 'error', error: 'Sign in to chat.' });
    const text = String(m.text || '').replace(/\s+/g, ' ').trim().slice(0, 500);
    if (!text) return;
    const t = Date.now();
    if (t - (conn.lastSay || 0) < 700) return post(id, { t: 'error', error: 'Slow down a little.' });
    await db.send(new UpdateCommand({ TableName: T, Key: { pk: 'c#' + id }, UpdateExpression: 'SET lastSay = :t', ExpressionAttributeValues: { ':t': t } }));
    const msg = { id: `t${t}${Math.random().toString(36).slice(2, 6)}`, name: conn.name, avatar: conn.avatar, text, ts: t };
    await everyone({ t: 'msg', m: msg });
    await getPool().query(`INSERT INTO chat_messages (name_key, name, avatar, body) VALUES (lower($1), $1, $2, $3)`, [msg.name, msg.avatar, text])
      .catch((e) => console.error('chat save failed:', e.message));
  }
}

const now = () => Math.floor(Date.now() / 1000);
exports.handler = async (event) => {
  const { routeKey, connectionId: id, domainName, stage } = event.requestContext;
  gw ||= new ApiGatewayManagementApiClient({ endpoint: `https://${domainName}/${stage}` });
  if (routeKey === '$connect') {
    const q = event.queryStringParameters || {};
    const ch = q.ch === 'chat' ? 'chat' : 'relay';
    const cid = String(q.cid || '').replace(/[^a-z0-9]/gi, '').slice(0, 24);
    if (ch === 'relay' && !cid) return { statusCode: 400 };
    await put({ pk: 'c#' + id, ch, cid, ttl: now() + 3 * 3600 });
    if (ch === 'chat') await db.send(new UpdateCommand({ TableName: T, Key: { pk: 'chat' },
      UpdateExpression: 'SET conns = if_not_exists(conns, :e)', ExpressionAttributeValues: { ':e': {} } }));
    return { statusCode: 200 };
  }
  const conn = await get('c#' + id);
  if (routeKey === '$disconnect') {
    if (conn && conn.ch === 'chat') { await chatDrop(id); await presence(); }
    else if (conn) await relayLeft(id, conn);
    await del('c#' + id);
    return { statusCode: 200 };
  }
  if (!conn) return { statusCode: 200 };
  let m; try { m = JSON.parse(event.body); } catch { return { statusCode: 200 }; }
  if (!m || typeof m.t !== 'string') return { statusCode: 200 };
  if (conn.ch === 'chat') await chat(id, conn, m); else await relay(id, conn, m);
  return { statusCode: 200 };
};
