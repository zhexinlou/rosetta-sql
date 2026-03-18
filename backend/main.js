import 'dotenv/config';
import express from 'express';
import mysql from 'mysql2/promise';
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

// ── Middleware ──────────────────────────────────────────────────────────────

// Disable CSP so Google Fonts and CDN scripts work; all other helmet protections stay on
app.use(helmet({ contentSecurityPolicy: false }));
app.use(morgan('dev'));
app.use(express.json({ limit: '1mb' }));

// ── Rate limiting ───────────────────────────────────────────────────────────

const aiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests — please wait a moment and try again.' },
});

// ── OpenAI ──────────────────────────────────────────────────────────────────

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ── DB state ────────────────────────────────────────────────────────────────

let dbConfig = null;
let pool = null;

// Schema cache keyed by database name: { schema: string, expiresAt: number }
const schemaCache = new Map();
const SCHEMA_TTL_MS = 5 * 60 * 1000; // 5 minutes

function createPool(config) {
  return mysql.createPool({
    ...config,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    enableKeepAlive: true,
    keepAliveInitialDelay: 0,
  });
}

async function getSchema(conn, dbName) {
  const cached = schemaCache.get(dbName);
  if (cached && Date.now() < cached.expiresAt) return cached.schema;

  const [tables] = await conn.query('SHOW TABLES');
  const tableSchema = {};

  for (const row of tables) {
    const tableName = row[`Tables_in_${dbName}`];
    const [columns] = await conn.query(`SHOW COLUMNS FROM \`${tableName}\``);
    tableSchema[tableName] = columns;
  }

  const schema = Object.entries(tableSchema)
    .map(([table, cols]) => {
      const colList = cols.map(c => `${c.Field} ${c.Type}`).join(', ');
      return `Table ${table}: ${colList}`;
    })
    .join('\n');

  schemaCache.set(dbName, { schema, expiresAt: Date.now() + SCHEMA_TTL_MS });
  return schema;
}

// ── Static files ─────────────────────────────────────────────────────────────

app.use(express.static(path.join(__dirname, '../frontend')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend', 'index.html'));
});

// ── Health & status ───────────────────────────────────────────────────────────

app.get('/health', (req, res) => {
  res.json({ status: 'ok', dbConnected: pool !== null });
});

app.get('/db-status', (req, res) => {
  res.json({ connected: pool !== null, database: dbConfig?.database ?? null });
});

// ── Configure DB ──────────────────────────────────────────────────────────────

app.post('/configure-db', async (req, res) => {
  const { dbHost, dbPort, dbName, dbUser, dbPassword } = req.body;

  if (!dbHost || !dbName || !dbUser) {
    return res.status(400).json({ success: false, error: 'Host, database name, and user are required.' });
  }

  const config = {
    host: dbHost.trim(),
    port: parseInt(dbPort, 10) || 3306,
    database: dbName.trim(),
    user: dbUser.trim(),
    password: dbPassword ?? '',
  };

  // Validate connection before accepting config (5 s timeout for fast failure)
  let testConn;
  try {
    testConn = await mysql.createConnection({ ...config, connectTimeout: 5000 });
    await testConn.end();
  } catch (err) {
    const msg = err.code === 'ETIMEDOUT'
      ? `Connection timed out — check that ${config.host}:${config.port} is reachable and the port is correct.`
      : err.message;
    return res.status(400).json({ success: false, error: msg });
  }

  // Tear down existing pool if any
  if (pool) {
    try { await pool.end(); } catch (_) { /* ignore */ }
  }

  dbConfig = config;
  pool = createPool(config);
  schemaCache.clear();

  res.json({ success: true, database: config.database });
});

// ── Natural language → SQL ────────────────────────────────────────────────────

const ALLOWED_SQL_STARTS = ['select', 'insert', 'update', 'delete'];
const FORBIDDEN_SQL_KEYWORDS = ['drop', 'truncate', 'alter', 'create', 'grant', 'revoke'];

app.post('/submit-query', aiLimiter, async (req, res) => {
  const { userInput } = req.body;

  if (!userInput || typeof userInput !== 'string' || userInput.trim().length === 0) {
    return res.status(400).json({ error: 'Query cannot be empty.' });
  }
  if (!pool) {
    return res.status(400).json({ error: 'No database connected. Please configure your database first.' });
  }

  let conn;
  try {
    conn = await pool.getConnection();
    const schemaDescription = await getSchema(conn, dbConfig.database);

    const completion = await openai.chat.completions.create({
      model: 'gpt-4-turbo',
      messages: [
        {
          role: 'system',
          content: [
            'You are an expert SQL assistant.',
            `Database schema:\n${schemaDescription}`,
            'Rules:',
            '- Return ONLY the raw SQL query — no explanation, no markdown, no code fences.',
            '- Prefer SELECT unless the user explicitly requests data modification.',
            '- Never use DROP, TRUNCATE, ALTER, CREATE, GRANT, or REVOKE.',
          ].join('\n'),
        },
        { role: 'user', content: userInput.trim() },
      ],
      max_tokens: 500,
    });

    let sqlQuery = completion.choices[0].message.content.trim();
    // Strip markdown code fences in case the model wraps anyway
    sqlQuery = sqlQuery.replace(/```(?:sql)?[\s\S]*?```/gi, s =>
      s.replace(/```(?:sql)?/gi, '').replace(/```/g, '')
    ).trim();

    const lower = sqlQuery.toLowerCase();

    if (!ALLOWED_SQL_STARTS.some(k => lower.startsWith(k))) {
      return res.status(400).json({ error: 'The model did not return a valid SQL query. Please rephrase.' });
    }
    if (FORBIDDEN_SQL_KEYWORDS.some(k => new RegExp(`\\b${k}\\b`).test(lower))) {
      return res.status(400).json({ error: 'Query contains a forbidden operation.' });
    }

    const [results] = await conn.query(sqlQuery);
    res.json({ data: results, query_generated: sqlQuery });
  } catch (err) {
    console.error('[submit-query]', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    if (conn) conn.release();
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

  let conn;
  try {
    conn = await pool.getConnection();

    const [tables] = await conn.execute('SHOW TABLES');
    const tableName = tables[0][Object.keys(tables[0])[0]];

    const [columns] = await conn.execute(`SHOW COLUMNS FROM \`${tableName}\``);
    const columnNames = columns.map(c => c.Field);

    if (!['stock_code', 'date', 'close'].every(c => columnNames.includes(c))) {
      return res.status(400).json({ error: 'Table must have columns: stock_code, date, close.' });
    }

    const [rows] = await conn.execute(
      `SELECT date, close FROM \`${tableName}\`
       WHERE stock_code = ? AND date BETWEEN ? AND ?
       ORDER BY date`,
      [symbol, startDate, endDate]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: `No data found for ${symbol} between ${startDate} and ${endDate}.` });
    }

    const csvData =
      'date,close\n' +
      rows.map(r => `${new Date(r.date).toISOString().split('T')[0]},${r.close}`).join('\n');

    const csvPath = path.join(os.tmpdir(), `stock_${Date.now()}.csv`);
    await fs.writeFile(csvPath, csvData);

    const plotDir = path.join(__dirname, 'public');
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

    await fs.unlink(csvPath).catch(() => { /* ignore cleanup errors */ });
    res.sendFile(plotPath);
  } catch (err) {
    console.error('[plot-stock]', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    if (conn) conn.release();
  }
});

// ── General AI chat ───────────────────────────────────────────────────────────

app.post('/gpt-chat', aiLimiter, async (req, res) => {
  const { userInput } = req.body;

  if (!userInput || typeof userInput !== 'string' || userInput.trim().length === 0) {
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

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM received — shutting down gracefully...');
  server.close(async () => {
    if (pool) await pool.end().catch(() => { /* ignore */ });
    process.exit(0);
  });
});
