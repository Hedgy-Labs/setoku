# Setoku

> Make any AI fluent in your own data.

Setoku is an open-source, self-hosted MCP (Model Context Protocol) knowledge server. It gives an AI agent a read-only, audited view of the data you own (a company’s, a household’s, or your own), plus the curated context needed to use it correctly: the metric definitions, the gotchas, the reasons a naive query is wrong.

Version 0.21.0 · Apache-2.0 · <https://github.com/Hedgy-Labs/setoku>

This is the markdown twin of <https://setoku.com/>. The API reference is <https://setoku.com/docs> (markdown: <https://setoku.com/docs.md>).

## When to use Setoku

Reach for Setoku when the answer lives in data its operator connected (a company’s, a household’s, or one person’s) and depends on their own definitions rather than public knowledge.

Who runs one:

- A company: one box, a token per person, and the definitions everyone argues about written down once: what counts as an active customer, which refunds are excluded, which table people actually trust.
- A household: joint finances, mail, and calendars on one box, so both partners can ask about the same numbers and the one who does not write SQL still gets an answer.
- One person: your own bank, mail, and repos, reachable from every client you use (phone, web, desktop), instead of only from the machine holding the files.

Use it when:

- A question is about the operator’s own affairs (revenue, churn, pipeline, deploys and support load for a company; spending, budgets, net worth and mail for a person or a household) and the data sits in their database, Slack, GitHub, email, or bank.
- The data has no fresh local copy. A bank, a budgeting service, a mail account and an issue tracker all keep changing, so a hand-made export is stale on arrival and the question needs today’s answer.
- You need the operator’s definition of a term before you can answer: what counts as an active customer, which account is the joint one, which charges were reimbursed and are therefore not really spend.
- A naive query would be wrong in a way only an insider knows (soft-deleted rows, a test tenant, a transfer between two of your own accounts double-counted as income) and you want that caveat before you run SQL.
- Someone wants a live, shareable view of that data: a dashboard or small app on a link a non-technical teammate, or your partner, can open, refreshing against real data rather than a pasted screenshot.
- An agent will read untrusted text (mail, logs, chat) in the same session it answers from. The session that reads it holds no tool that can rewrite what Setoku knows, so a prompt-injection attempt in an email cannot become a remembered fact.
- You want your answer, and the reasoning behind it, to be auditable later: every query and every knowledge change is logged on the owner’s own box.

Do not use it when:

- The question is general knowledge, or about public data — Setoku only knows the data its operator connected.
- The data is one static file you already have on disk. If a CSV export answers the question and will not change, query it locally; Setoku earns its keep on data that lives somewhere else and keeps moving.
- You need to write to the operator’s database. Every data path is read-only, by database role; there is no write tool and no escape hatch.
- You are looking for a hosted, multi-tenant API to sign up for. There is none: Setoku is single-tenant and self-hosted, and the endpoint you call is the operator’s own box.
- You want a model to run server-side. Setoku runs no inference; your own agent does the thinking.

## How an agent calls it

1. Connect to the box’s MCP endpoint (Streamable HTTP) at `https://<their-box>/mcp` with the person’s bearer token, or paste `https://<their-box>/mcp/<token>` into a connector dialog that has no header field.
2. Call find_context FIRST, every time. It returns the curated notes for the question, including which tables to trust and which to avoid.
3. Then get_schema, then run_query. Reading context before querying is the difference between a right answer and a plausible one.
4. Found something the context got wrong? Call report_correction. It lands as a proposal for a human to accept — an agent session can never commit knowledge by itself.

## Try it without installing anything

The demo box is wired to a synthetic pro-sports-club dataset (ticketing, sponsorship, concessions, payroll, broadcast rights) for a fictional club, the Bonita Bulldogs. Add this as a custom MCP connector:

    https://demo.setoku.com/mcp/85315b4240ff6ded111072f950ac6f14167d920fdb765144

The token is public on purpose: read-only, analyst role, synthetic data.

- [Sponsorship pricing table](https://demo.setoku.com/p/7e38381ced6517329947b14d) — inventory and rates for sponsorship placements, published by an agent and running on live demo data.
- [Bulldogs attendance forecast](https://demo.setoku.com/p/a7a1240ae0bc202c5eefa1cc) — projected gate for upcoming home games, published by an agent and running on live demo data.
- [Demo box health](https://demo.setoku.com/healthz) — a credential-free REST endpoint, if you want to see the shape of the API before you connect.

## Install

Claude Code plugin, from your project directory:

    /plugin marketplace add Hedgy-Labs/setoku
    /plugin install setoku@setoku
    /setoku:onboard

Server, by hand, on a fresh Ubuntu VPS (about $5–12/month):

    git clone https://github.com/Hedgy-Labs/setoku /opt/setoku
    cd /opt/setoku
    SETOKU_ADMIN_USER=you ./deploy/bootstrap.sh

## The tool surface

19 MCP tools. Which ones a session sees depends on its token’s role — that split is the security model, not a convenience.

| Tool | What it does | Role |
| --- | --- | --- |
| `find_context` | Find context for this connector’s data | analyst |
| `list_entities` | List everything in the knowledge store | analyst |
| `describe_entity` | Full context doc for one entity | analyst |
| `get_metric` | Canonical metric definition | analyst |
| `report_correction` | Record a context correction / clarification | analyst |
| `list_corrections` | List pending knowledge corrections | analyst |
| `resolve_correction` | Resolve a pending correction | curator |
| `upsert_context` | Create or update a knowledge doc | curator |
| `draft_correction` | Attach a drafted doc-edit to a pending correction | janitor |
| `reject_correction` | Auto-reject a pending correction | janitor |
| `list_sources` | List connected data sources | analyst |
| `get_schema` | Every table and column you can query | analyst |
| `run_query` | Run a read-only SQL query | analyst |
| `app_guide` | How to build a Setoku app | analyst |
| `publish_app` | Publish a live app to the box | analyst |
| `update_app` | Edit an app you published | analyst |
| `list_apps` | List apps published to the box | analyst |
| `get_app` | Inspect an app — its full template and panels | analyst |
| `unpublish_app` | Archive a published app | analyst |

## Skills

- `/setoku:compact-knowledge` — Periodically tidy the Setoku knowledge store in a curator session — merge duplicate facts, resolve contradictions, tighten verbose docs, and flag stale knowledge. Use when the user asks to compact / clean up / dedupe / tidy knowledge, or when /admin/knowledge shows merge / contradiction / verbose flags.
- `/setoku:connect` — Connect a data source to Setoku end-to-end — ensure a box exists, wire the source up (read-only), verify the agent actually understands the data, and write what it learns back as knowledge. Use when the user says "connect \<source>", "hook up \<source>", "add a data source", "set up Setoku", or "/setoku:connect".
- `/setoku:curate` — Review pending Setoku knowledge candidates and promote, edit, or reject them — conversationally, no git or dev skills required. Use when the user asks to curate/review setoku knowledge, or when list_entities reports pending corrections.
- `/setoku:eval` — Run the Setoku golden-question eval for this repository and report a scorecard. Use when the user asks to eval/test setoku answer quality, or after significant context-artifact changes.
- `/setoku:generate` — Generate or refresh Setoku’s business-context knowledge by reading this repository’s code — ORM schemas, business logic, migrations, existing docs — and saving it to the knowledge store (commits directly on a curator connector, or proposes for human approval on the everyday analyst connector — no SSH needed). Use when the user asks to generate/update/refresh business context, when setoku tools report an empty knowledge store, or when schema drift is detected.
- `/setoku:onboard` — First-run setup for Setoku in a repo — connect the business database, generate context from the code, and answer a first question end-to-end. Use when the user says "set up setoku" or "onboard", or when setoku tools report missing config. (Thin wrapper over /setoku:connect.)

## Connectors

- **PostgreSQL** — your app database, mirrored read-only into biz.*
- **GitHub** — issues, pull requests, commits, comments
- **Vercel** — deploys and logs
- **Render** — deploys and logs
- **Slack** — messages
- **Mercury** — accounts and transactions
- **Monarch** — accounts, transactions, net worth, budgets, holdings
- **Gmail** — messages, per-mailbox OAuth

No connector for yours? `/setoku:connect` gives a coding agent the patterns to wire one up.

## Security model

- **Two identities, one membrane.** An analyst token may query the lake but holds no tool that commits knowledge. A curator token may commit knowledge but cannot read the lake. They never coexist on one session, so a prompt-injected session cannot weaponize the write path.
- **Accepting knowledge is a human click** on the box’s admin page, outside the agent loop. No MCP tool creates users, grants access, or commits knowledge on its own.
- **Reads are governed by database roles**, not by parsing SQL in our code. The engine enforces it.
- **The credential never reaches the model.** Config names an environment variable; the gateway resolves it.
- **No model runs on the server**, so there is no inference cost and no AI API key on the box.

## Machine-readable index

- [OpenAPI 3.1](https://setoku.com/openapi.json) — the gateway HTTP API
- [MCP manifest](https://setoku.com/.well-known/mcp.json) — endpoint, transport, auth
- [Agent card](https://setoku.com/.well-known/agent-card.json) — who we are, what we do
- [Agent skills index](https://setoku.com/.well-known/agent-skills/index.json)
- [Catalog root](https://setoku.com/api/index.json) · [tools](https://setoku.com/api/tools.json) · [connectors](https://setoku.com/api/connectors.json)
- [llms.txt](https://setoku.com/llms.txt)

Contact: hello@setoku.com · Issues: <https://github.com/Hedgy-Labs/setoku/issues>
