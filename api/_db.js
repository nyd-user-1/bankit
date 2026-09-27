// Shared database access for the API routes: Aurora PostgreSQL over the RDS Data API
// (HTTPS + IAM, so it works from a laptop, Lambda or Amplify without VPC plumbing).
// getPool() returns a small pg-compatible facade — pool.query(sql, params) and
// pool.connect() → client.query / client.release, with BEGIN/COMMIT/ROLLBACK mapped to
// Data API transactions — so route SQL keeps its $1-style params unchanged.
// Differences from pg: string params arrive typed as text, so jsonb / int[] targets
// need an explicit cast in the SQL ($2::jsonb, $1::int[]).
// Env: BANKIT_DB_CLUSTER_ARN, BANKIT_DB_SECRET_ARN, BANKIT_DB_NAME (default 'bankit').
// AWS credentials come from the default chain (~/.aws locally, the IAM role in prod).
const {
  RDSDataClient, ExecuteStatementCommand, BeginTransactionCommand,
  CommitTransactionCommand, RollbackTransactionCommand,
} = require('@aws-sdk/client-rds-data');

let rds;
const cfg = () => ({
  resourceArn: process.env.BANKIT_DB_CLUSTER_ARN,
  secretArn: process.env.BANKIT_DB_SECRET_ARN,
  database: process.env.BANKIT_DB_NAME || 'bankit',
});

// Serverless v2 auto-pauses when idle; the first call after a pause gets
// DatabaseResumingException for ~15s. Retry through it.
async function send(cmd) {
  rds ||= new RDSDataClient({ region: process.env.BANKIT_DB_REGION || 'us-east-1' });
  for (let attempt = 0; ; attempt++) {
    try { return await rds.send(cmd); }
    catch (e) {
      if (e.name !== 'DatabaseResumingException' || attempt >= 12) throw pgError(e);
      await new Promise((r) => setTimeout(r, 2500));
    }
  }
}

// surface the Postgres SQLSTATE as e.code, like pg does (routes check '23505')
function pgError(e) {
  const m = /SQLState: (\w{5})/.exec(e.message || '');
  if (m) e.code = m[1];
  return e;
}

const pgArray = (a) => '{' + a.map((v) =>
  v === null ? 'NULL' : typeof v === 'number' ? v : '"' + String(v).replace(/(["\\])/g, '\\$1') + '"'
).join(',') + '}';

function toParam(v, i) {
  const name = 'p' + (i + 1);
  if (v === null || v === undefined) return { name, value: { isNull: true } };
  if (typeof v === 'boolean') return { name, value: { booleanValue: v } };
  if (typeof v === 'number') {
    return Number.isInteger(v) ? { name, value: { longValue: v } } : { name, value: { doubleValue: v } };
  }
  if (v instanceof Date) return { name, value: { stringValue: v.toISOString() } };
  if (Array.isArray(v)) return { name, value: { stringValue: pgArray(v) } };
  if (typeof v === 'object') return { name, value: { stringValue: JSON.stringify(v) } };
  return { name, value: { stringValue: String(v) } };
}

function fromField(f, type) {
  if (f.isNull) return null;
  if ('stringValue' in f) {
    const s = f.stringValue;
    if (type === 'timestamptz' || type === 'timestamp') return new Date(s.replace(' ', 'T') + 'Z');
    if (type === 'json' || type === 'jsonb') return JSON.parse(s);
    return s;
  }
  if ('longValue' in f) return type === 'int8' ? String(f.longValue) : f.longValue;
  if ('doubleValue' in f) return f.doubleValue;
  if ('booleanValue' in f) return f.booleanValue;
  if ('arrayValue' in f) {
    const a = f.arrayValue;
    return a.longValues || a.doubleValues || a.booleanValues || a.stringValues
      || (a.arrayValues || []).map((x) => fromField({ arrayValue: x }));
  }
  return null;
}

async function run(sql, params = [], transactionId) {
  // $12 before $1, so '$1' never eats the prefix of '$12'
  const text = sql.replace(/\$(\d+)/g, ':p$1');
  const out = await send(new ExecuteStatementCommand({
    ...cfg(), sql: text, transactionId,
    parameters: params.map(toParam),
    includeResultMetadata: true,
  }));
  const cols = out.columnMetadata || [];
  const rows = (out.records || []).map((rec) => {
    const row = {};
    rec.forEach((f, i) => { row[cols[i].label || cols[i].name] = fromField(f, cols[i].typeName); });
    return row;
  });
  return { rows, rowCount: out.records ? rows.length : out.numberOfRecordsUpdated };
}

function makeClient() {
  let tx = null;
  return {
    async query(sql, params) {
      const verb = sql.trim().toUpperCase();
      if (verb === 'BEGIN') {
        tx = (await send(new BeginTransactionCommand(cfg()))).transactionId;
        return { rows: [], rowCount: 0 };
      }
      if (verb === 'COMMIT' || verb === 'ROLLBACK') {
        if (!tx) return { rows: [], rowCount: 0 };
        const id = tx; tx = null;
        const { resourceArn, secretArn } = cfg();
        const Cmd = verb === 'COMMIT' ? CommitTransactionCommand : RollbackTransactionCommand;
        try { await send(new Cmd({ resourceArn, secretArn, transactionId: id })); }
        catch (e) { if (verb === 'COMMIT') throw e; }
        return { rows: [], rowCount: 0 };
      }
      return run(sql, params, tx || undefined);
    },
    release() {
      if (tx) this.query('ROLLBACK').catch(() => {});
    },
  };
}

const pool = {
  query: (sql, params) => run(sql, params),
  connect: async () => makeClient(),
};

function getPool() { return pool; }

module.exports = { getPool };
