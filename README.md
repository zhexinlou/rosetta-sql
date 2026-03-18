<div align="center">

# Rosetta

**Talk to your database in plain English.**

Rosetta translates natural language into SQL using GPT-4 Turbo, executes the query against your database, and presents the results as a clean data table — no SQL knowledge required. Supports MySQL, PostgreSQL, SQL Server, and SQLite.


</div>

---

## Features

- **Natural language → SQL** — describe what you want in English; GPT-4 Turbo writes the query
- **Live results table** — query results rendered as a formatted, scrollable table
- **4 database engines** — MySQL, PostgreSQL, SQL Server (MSSQL), and SQLite
- **Schema auto-discovery** — introspects tables/columns automatically on connect (cached for 5 minutes)
- **AI chat mode** — switch to free-form GPT-4o chat for general questions
- **Stock chart visualisation** — plot ASX stock price history directly from your database
- **Copy SQL** — one-click copy of every generated query
- **Safe by default** — `DROP`, `TRUNCATE`, `ALTER`, `CREATE`, `GRANT`, and `REVOKE` are blocked at the API layer; rate limiting on all AI endpoints

## Tech stack

| Layer | Technology |
|---|---|
| Backend | Node.js · Express · connection pool per engine |
| Databases | MySQL (mysql2) · PostgreSQL (pg) · SQL Server (mssql) · SQLite (better-sqlite3) |
| AI | OpenAI API — GPT-4 Turbo (SQL), GPT-4o (chat) |
| Security | helmet · express-rate-limit · morgan |
| Visualisation | Python · matplotlib · pandas |
| Frontend | Vanilla HTML/CSS/JS · marked.js |

## Getting started

### Prerequisites

- Node.js 18+
- At least one of: MySQL 5.7+, PostgreSQL 13+, SQL Server 2017+, or a SQLite file
- Python 3 with `matplotlib` and `pandas` (only required for stock charts)
- An OpenAI API key

### Installation

```bash
# 1. Clone the repository
git clone https://github.com/zhexinlou/rosetta-sql.git
cd rosetta-sql

# 2. Install Node dependencies
npm install

# 3. Create your environment file
cp .env.example .env
```

Open `.env` and add your OpenAI API key:

```env
OPENAI_API_KEY=sk-...
PORT=3005
```

### Running

```bash
npm start
```

Then open [http://localhost:3005](http://localhost:3005) in your browser.

For development with auto-reload:

```bash
npm run dev
```

## Usage

1. **Connect** — enter your MySQL host, port, user, and password on the configuration page
2. **Query** — type a question in the chat box, e.g. *"Show me the top 10 customers by total order value"*
3. **Review** — the generated SQL and result table appear instantly; click **Copy** to grab the SQL
4. **Chart** — switch to the stock panel, enter a symbol and date range to render a price chart

### Example queries

```
Show all orders placed in the last 30 days
Which products have fewer than 5 units in stock?
List users who have never made a purchase
What was the average sale amount by month this year?
```

## Project structure

```
rosetta-sql/
├── backend/
│   ├── main.js          # Express server — API routes, DB pool, schema cache
│   └── plot_stock.py    # Stock chart generation (matplotlib)
├── frontend/
│   ├── index.html       # Landing page
│   ├── config.html      # Database connection form
│   └── query.html       # Main query interface
├── .env.example         # Environment variable template
└── package.json
```

## Security notes

- Database credentials are held **in memory only** and never persisted to disk
- All AI-generated SQL is validated against an allowlist (`SELECT`, `INSERT`, `UPDATE`, `DELETE`) and a blocklist of destructive keywords before execution
- All user-supplied values displayed in the UI are HTML-escaped to prevent XSS
- AI endpoints are rate-limited to 20 requests per minute per IP

## Contributing

Pull requests are welcome. For substantial changes, please open an issue first to discuss what you'd like to change.

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/my-feature`
3. Commit your changes: `git commit -m 'Add my feature'`
4. Push and open a pull request

## License

MIT — feel free to use, modify, and distribute.
