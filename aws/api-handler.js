// Lambda entry for every api/*.js route (Function URL, payload v2). Amplify proxies /api/* here.
// Each route is written Vercel-style (req.method/query/body, res.status().json()); this shims
// the Lambda event into that shape so the route files run unchanged here and in the dev server.
const ROUTES = {};
for (const n of ['boards','decoys','game-scores','leaderboard','match-join','match-tap','match','mix','play','players','requests','scores','scramble','sets'])
  ROUTES[n] = require(`./api/${n}.js`);

exports.handler = async (event) => {
  const name = (event.rawPath || '').replace(/^\/api\//, '').replace(/\/$/, '');
  const route = ROUTES[name];
  if (!route) return { statusCode: 404, headers: { 'content-type': 'application/json' }, body: '{"error":"Not found"}' };
  let body = event.body || '';
  if (event.isBase64Encoded) body = Buffer.from(body, 'base64').toString('utf8');
  try { body = body ? JSON.parse(body) : {}; } catch (e) { /* leave as text */ }
  const req = {
    method: event.requestContext.http.method,
    query: Object.fromEntries(new URLSearchParams(event.rawQueryString || '')),
    headers: event.headers || {},
    body,
  };
  return new Promise((resolve) => {
    const out = { statusCode: 200, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }, body: '' };
    const res = {
      status(c) { out.statusCode = c; return res; },
      setHeader(k, v) { out.headers[String(k).toLowerCase()] = String(v); return res; },
      json(o) { out.body = JSON.stringify(o); resolve(out); return res; },
      send(s) { out.body = typeof s === 'string' ? s : JSON.stringify(s); resolve(out); return res; },
      end(s) { out.body = s || ''; resolve(out); return res; },
    };
    Promise.resolve(route(req, res)).catch((e) => { console.error(e); resolve({ statusCode: 500, body: '{"error":"Server error"}' }); });
  });
};
