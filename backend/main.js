import 'dotenv/config';
import express from 'express';
import mysql from 'mysql2/promise';
import pg from 'pg';
import mssql from 'mssql';
import Database from 'better-sqlite3';
import helmet from 'helmet';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import path from 'path';
import { fileURLToPath } from 'url';
import { execFile } from 'child_process';
import OpenAI from 'openai';
import fs from 'fs/promises';
import os from 'os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3005;

// ── Middleware ────────────────────────────────────────────────────────────────

app.use(helmet({ contentSecurityPolicy: false }));
app.use(morgan('dev'));
app.use(express.json({ limit: '1mb' }));

// ── Rate limiting ─────────────────────────────────────────────────────────────

const aiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests — please wait a moment and try again.' },
});

// ── OpenAI ────────────────────────────────────────────────────────────────────

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ── DB state ──────────────────────────────────────────────────────────────────

let dbType = null;   // 'mysql' | 'postgres' | 'mssql' | 'sqlite'
let dbConfig = null;
let pool = null;

const schemaCache = new Map();
const SCHEMA_TTL_MS = 5 * 60 * 1000;

// ── Adapters ──────────────────────────────────────────────────────────────────
//
// Each adapter exposes a uniform interface:
//   test(cfg)              — throw on connection failure
//   createPool(cfg)        — returns pool/connection (may be async)
//   getConn(pool)          — borrow a connection
//   releaseConn(conn)      — return it
//   endPool(pool)          — tear down
//   getTables(conn, cfg)   — string[]
//   getColumns(conn, table)— { Field, Type }[]
//   query(conn, sql)       — row[]

const ADAPTERS = {
  // ── MySQL ──────────────────────────────────────────────────────────────────
  mysql: {
    label: 'MySQL',
    defaultPort: 3306,

    async test(cfg) {
      const conn = await mysql.createConnection({ ...cfg, connectTimeout: 5000 });
      await conn.end();
    },
    createPool(cfg) {
      return mysql.createPool({
        ...cfg,
        waitForConnections: true,
        connectionLimit: 10,
        enableKeepAlive: true,
      });
    },
    async getConn(p) { return p.getConnection(); },
    releaseConn(c)   { c.release(); },
    async endPool(p) { await p.end(); },

    async getTables(conn, cfg) {
      const [rows] = await conn.query('SHOW TABLES');
      return rows.map(r => r[`Tables_in_${cfg.database}`]);
    },
    async getColumns(conn, table) {
      const [rows] = await conn.query(`SHOW COLUMNS FROM \`${table}\``);
      return rows.map(r => ({ Field: r.Field, Type: r.Type }));
    },
    async query(conn, sql) {
      const [rows] = await conn.query(sql);
      return rows;
    },
  },

  // ── PostgreSQL ─────────────────────────────────────────────────────────────
  postgres: {
    label: 'PostgreSQL',
    defaultPort: 5432,

    async test(cfg) {
      const client = new pg.Client({ ...cfg, connectionTimeoutMillis: 5000 });
      await client.connect();
      await client.end();
    },
    createPool(cfg) {
      return new pg.Pool({ ...cfg, connectionTimeoutMillis: 5000, max: 10 });
    },
    async getConn(p) { return p.connect(); },
    releaseConn(c)   { c.release(); },
    async endPool(p) { await p.end(); },

    async getTables(conn) {
      const res = await conn.query(`
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      `);
      return res.rows.map(r => r.table_name);
    },
    async getColumns(conn, table) {
      const res = await conn.query(`
        SELECT column_name AS "Field", data_type AS "Type"
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1
        ORDER BY ordinal_position
      `, [table]);
      return res.rows;
    },
    async query(conn, sql) {
      const res = await conn.query(sql);
      return res.rows;
    },
  },

  // ── SQL Server ─────────────────────────────────────────────────────────────
  mssql: {
    label: 'SQL Server',
    defaultPort: 1433,

    _cfg(cfg) {
      return {
        server:   cfg.host,
        port:     cfg.port,
        database: cfg.database,
        user:     cfg.user,
        password: cfg.password,
        options:  { encrypt: false, trustServerCertificate: true },
        connectionTimeout: 5000,
      };
    },
    async test(cfg) {
      const p = await mssql.connect(this._cfg(cfg));
      await p.close();
    },
    async createPool(cfg) {
      return mssql.connect(this._cfg(cfg));
    },
    async getConn(p) { return p; },   // mssql manages connections internally
    releaseConn()    {},
    async endPool(p) { await p.close(); },

    async getTables(conn) {
      const res = await conn.request().query(
        `SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_TYPE = 'BASE TABLE'`
      );
      return res.recordset.map(r => r.TABLE_NAME);
    },
    async getColumns(conn, table) {
      const res = await conn.request()
        .input('table', mssql.NVarChar, table)
        .query(`
          SELECT COLUMN_NAME AS Field, DATA_TYPE AS Type
          FROM INFORMATION_SCHEMA.COLUMNS
          WHERE TABLE_NAME = @table
          ORDER BY ORDINAL_POSITION
        `);
      return res.recordset;
    },
    async query(conn, sql) {
      const res = await conn.request().query(sql);
      return res.recordset;
    },
  },

  // ── SQLite ─────────────────────────────────────────────────────────────────
  sqlite: {
    label: 'SQLite',
    defaultPort: null,

    async test(cfg) {
      const db = new Database(cfg.filename);
      db.close();
    },
    createPool(cfg) {
      return new Database(cfg.filename);  // sync; no pool needed
    },
    async getConn(p) { return p; },
    releaseConn()    {},
    async endPool(p) { p.close(); },

    async getTables(conn) {
      return conn
        .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`)
        .all()
        .map(r => r.name);
    },
    async getColumns(conn, table) {
      return conn
        .prepare(`PRAGMA table_info("${table}")`)
        .all()
        .map(r => ({ Field: r.name, Type: r.type }));
    },
    async query(conn, sql) {
      return conn.prepare(sql).all();
    },
  },
};

// Build a driver-native config object from the frontend form body
function buildConfig(type, body) {
  const { dbHost, dbPort, dbName, dbUser, dbPassword } = body;
  if (type === 'sqlite') return { filename: dbName };
  return {
    host:     dbHost.trim(),
    port:     parseInt(dbPort, 10) || ADAPTERS[type].defaultPort,
    database: dbName.trim(),
    user:     dbUser.trim(),
    password: dbPassword ?? '',
  };
}

// Shared schema introspection with per-database caching
async function getSchema(conn, cacheKey) {
  const cached = schemaCache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) return cached.schema;

  const adapter = ADAPTERS[dbType];
  const tables  = await adapter.getTables(conn, dbConfig);

  const schema = (
    await Promise.all(
      tables.map(async table => {
        const cols = await adapter.getColumns(conn, table);
        return `Table ${table}: ${cols.map(c => `${c.Field} ${c.Type}`).join(', ')}`;
      })
    )
  ).join('\n');

  schemaCache.set(cacheKey, { schema, expiresAt: Date.now() + SCHEMA_TTL_MS });
  return schema;
}

// ── Static files ──────────────────────────────────────────────────────────────

app.use(express.static(path.join(__dirname, '../frontend')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend', 'index.html'));
});

// ── Health & status ───────────────────────────────────────────────────────────

app.get('/health', (req, res) => {
  res.json({ status: 'ok', dbConnected: pool !== null });
});

app.get('/db-status', (req, res) => {
  const name =
    dbConfig?.database ??
    (dbConfig?.filename ? path.basename(dbConfig.filename) : null);
  res.json({ connected: pool !== null, database: name, type: dbType });
});

// ── Configure DB ──────────────────────────────────────────────────────────────

app.post('/configure-db', async (req, res) => {
  const { dbType: type, dbHost, dbPort, dbName, dbUser, dbPassword } = req.body;

  if (!ADAPTERS[type]) {
    return res.status(400).json({ success: false, error: `Unknown database type: ${type}` });
  }
  if (!dbName) {
    return res.status(400).json({ success: false, error: 'Database name / file path is required.' });
  }
  if (type !== 'sqlite' && (!dbHost || !dbUser)) {
    return res.status(400).json({ success: false, error: 'Host and user are required.' });
  }

  const config   = buildConfig(type, req.body);
  const adapter  = ADAPTERS[type];

  // Test connection before committing
  try {
    await adapter.test(config);
  } catch (err) {
    const msg = err.code === 'ETIMEDOUT'
      ? `Connection timed out — check that ${config.host}:${config.port} is reachable.`
      : err.message;
    return res.status(400).json({ success: false, error: msg });
  }

  // Tear down old pool
  if (pool) {
    try { await ADAPTERS[dbType].endPool(pool); } catch (_) { /* ignore */ }
  }

  dbType   = type;
  dbConfig = config;
  pool     = await adapter.createPool(config);
  schemaCache.clear();

  const displayName = config.database ?? path.basename(config.filename);
  res.json({ success: true, database: displayName, type });
});

// ── Natural language → SQL ────────────────────────────────────────────────────

const ALLOWED_SQL_STARTS  = ['select', 'insert', 'update', 'delete'];
const FORBIDDEN_KEYWORDS  = ['drop', 'truncate', 'alter', 'create', 'grant', 'revoke'];

app.post('/submit-query', aiLimiter, async (req, res) => {
  const { userInput } = req.body;

  if (!userInput?.trim()) {
    return res.status(400).json({ error: 'Query cannot be empty.' });
  }
  if (!pool) {
    return res.status(400).json({ error: 'No database connected.' });
  }

  const adapter  = ADAPTERS[dbType];
  const cacheKey = dbConfig.database ?? dbConfig.filename;
  let conn;

  try {
    conn = await adapter.getConn(pool);

    const schemaDescription = await getSchema(conn, cacheKey);

    const completion = await openai.chat.completions.create({
      model: 'gpt-4-turbo',
      messages: [
        {
          role: 'system',
          content: [
            `You are an expert ${adapter.label} SQL assistant.`,
            `Database schema:\n${schemaDescription}`,
            'Rules:',
            '- Return ONLY the raw SQL query — no explanation, no markdown, no code fences.',
            `- Use ${adapter.label}-compatible syntax and dialect.`,
            '- Prefer SELECT unless the user explicitly requests data modification.',
            '- Never use DROP, TRUNCATE, ALTER, CREATE, GRANT, or REVOKE.',
          ].join('\n'),
        },
        { role: 'user', content: userInput.trim() },
      ],
      max_tokens: 500,
    });

    let sqlQuery = completion.choices[0].message.content.trim();
    sqlQuery = sqlQuery.replace(/```(?:sql)?[\s\S]*?```/gi, s =>
      s.replace(/```(?:sql)?/gi, '').replace(/```/g, '')
    ).trim();

    const lower = sqlQuery.toLowerCase();

    if (!ALLOWED_SQL_STARTS.some(k => lower.startsWith(k))) {
      return res.status(400).json({ error: 'The model did not return a valid SQL query. Please rephrase.' });
    }
    if (FORBIDDEN_KEYWORDS.some(k => new RegExp(`\\b${k}\\b`).test(lower))) {
      return res.status(400).json({ error: 'Query contains a forbidden operation.' });
    }

    const results = await adapter.query(conn, sqlQuery);
    res.json({ data: results, query_generated: sqlQuery });
  } catch (err) {
    console.error('[submit-query]', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    if (conn) adapter.releaseConn(conn);
  }
});

// ── Stock chart ───────────────────────────────────────────────────────────────

app.post('/plot-stock', async (req, res) => {
  const { symbol, startDate, endDate } = req.body;

  if (!symbol || !startDate || !endDate) {
    return res.status(400).json({ error: 'symbol, startDate, and endDate are required.' });
  }
  if (!/^[\w.]+$/.test(symbol)) {
    return res.status(400).json({ error: 'Invalid stock symbol.' });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
    return res.status(400).json({ error: 'Dates must be in YYYY-MM-DD format.' });
  }
  if (!pool) {
    return res.status(400).json({ error: 'No database connected.' });
  }

  const adapter = ADAPTERS[dbType];
  let conn;

  try {
    conn = await adapter.getConn(pool);

    const tables    = await adapter.getTables(conn, dbConfig);
    const tableName = tables[0];
    const columns   = await adapter.getColumns(conn, tableName);
    const colNames  = columns.map(c => c.Field);

    if (!['stock_code', 'date', 'close'].every(c => colNames.includes(c))) {
      return res.status(400).json({ error: 'Table must have columns: stock_code, date, close.' });
    }

    // Use a simple SELECT — quoting varies by DB but unquoted identifiers work for this schema
    const rows = await adapter.query(
      conn,
      `SELECT date, close FROM ${tableName} WHERE stock_code = '${symbol}' AND date BETWEEN '${startDate}' AND '${endDate}' ORDER BY date`
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: `No data for ${symbol} between ${startDate} and ${endDate}.` });
    }

    const csvData =
      'date,close\n' +
      rows.map(r => `${new Date(r.date).toISOString().split('T')[0]},${r.close}`).join('\n');

    const csvPath = path.join(os.tmpdir(), `stock_${Date.now()}.csv`);
    await fs.writeFile(csvPath, csvData);

    const plotDir  = path.join(__dirname, 'public');
    await fs.mkdir(plotDir, { recursive: true });
    const plotPath = path.join(plotDir, 'stock_plot.png');

    await new Promise((resolve, reject) => {
      execFile(
        'python3',
        [path.join(__dirname, 'plot_stock.py'), csvPath, symbol, startDate, endDate],
        { cwd: __dirname },
        (err, _stdout, stderr) => {
          if (err) return reject(new Error(stderr || err.message));
          resolve();
        }
      );
    });

    await fs.unlink(csvPath).catch(() => { /* ignore */ });
    res.sendFile(plotPath);
  } catch (err) {
    console.error('[plot-stock]', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    if (conn) adapter.releaseConn(conn);
  }
});

// ── General AI chat ───────────────────────────────────────────────────────────

app.post('/gpt-chat', aiLimiter, async (req, res) => {
  const { userInput } = req.body;

  if (!userInput?.trim()) {
    return res.status(400).json({ error: 'Message cannot be empty.' });
  }

  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: userInput.trim() }],
      max_tokens: 4000,
    });
    res.json({ response: completion.choices[0].message.content.trim() });
  } catch (err) {
    console.error('[gpt-chat]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Global error handler ──────────────────────────────────────────────────────

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[unhandled error]', err);
  res.status(500).json({ error: 'Internal server error.' });
});

// ── Start server ──────────────────────────────────────────────────────────────

const server = app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});

process.on('SIGTERM', async () => {
  console.log('SIGTERM received — shutting down gracefully...');
  server.close(async () => {
    if (pool && dbType) {
      await ADAPTERS[dbType].endPool(pool).catch(() => { /* ignore */ });
    }
    process.exit(0);
  });
});
