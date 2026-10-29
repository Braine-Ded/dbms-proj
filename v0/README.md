# Stride: Fitness Tracker (DBMS mini-project)

A MySQL fitness tracker built on the schema in `DBMS.pdf`, with a small Go REST API and a web front end.
Every database call is a plain, hand-written SQL string. There is no ORM and there are no prepared statements, so any query the site runs can be copied into MySQL Workbench and run there unchanged.

```
db/01_schema.sql        database, 7 tables, PK/FK/UNIQUE/CHECK constraints, triggers, 3 views
db/02_seed.sql          sample data: 3 users, 38 foods, 18 exercises, 4 weeks of logs, 8 weekly check-ins
db/03_demo_queries.sql  queries to run during the Workbench demo, including every business rule
db/04_users.sql         MySQL accounts ft_admin / ft_clerk / ft_viewer and their GRANTs
.env                    settings and every password, in plaintext (mock project)
main.go                 REST API (one file, net/http + database/sql, one request at a time)
static/                 website (index.html, style.css, app.js, img/)
run.sh                  starts everything
```

## 1. Create the database (MySQL Workbench)

1. Open MySQL Workbench and connect to your local server.
2. **File → Open SQL Script → `db/01_schema.sql`**, then press the lightning bolt (Execute all).
3. Do the same for **`db/02_seed.sql`**, then **`db/04_users.sql`** (creates the website's MySQL accounts).
4. Click the refresh icon in the **Schemas** panel. `fitness_tracker` now shows its tables, views and triggers.

Seed dates are relative to `CURDATE()`, so the demo data always ends on today.
To start over, run the files again. `01_schema.sql` drops and recreates the database, and `04_users.sql` drops and recreates the accounts.

ER diagram in Workbench: **Database → Reverse Engineer**, then pick `fitness_tracker`.

## 2. Start the website

You need Go 1.22 or newer.

Put your MySQL root password in `.env` (`MYSQL_PASSWORD=`), then:

```bash
./run.sh
```

Then open http://localhost:8080 and sign in.

* `./run.sh --reset` rebuilds the database and accounts from `01_schema.sql`, `02_seed.sql` and `04_users.sql` before starting. It needs the `mysql` command-line client and uses the root login from `.env`.
* Settings live in `.env`: `MYSQL_USER` / `MYSQL_PASSWORD` (root, only for `--reset`), `MYSQL_HOST`, `MYSQL_PORT`, `PORT`. A variable set in the shell overrides `.env`, e.g. `MYSQL_PASSWORD=x ./run.sh` (fish: `env MYSQL_PASSWORD=x ./run.sh`).
* Without the script: `go run . -mysql 127.0.0.1:3306`

### Accounts

The website never connects as root. Signing in opens a MySQL connection as one of three accounts, and MySQL checks the password. Every query that person runs goes through that connection, so the GRANTs in `db/04_users.sql` decide what is allowed. The buttons a role can't use are hidden, but the real check is MySQL's.

| Role | MySQL account | Password | Can do |
|---|---|---|---|
| Admin | `ft_admin` | `admin123` | everything on `fitness_tracker` |
| Clerk | `ft_clerk` | `clerk123` | read everything; log meals, workouts and weekly check-ins (`Daily_Record`, `Daily_Food`, `Daily_Burn`, `Weekly_Record`) |
| Viewer | `ft_viewer` | `viewer123` | `SELECT` only |

The passwords are kept in plaintext in `.env` on purpose. If you change one, change it in `db/04_users.sql` too and rerun that file.

The terminal running the server prints every SQL statement as it runs.

## 3. Demo script for the judges

The site has three ways to show the database working:

| Where | What it shows |
|---|---|
| **Live SQL** button (bottom right of the site) | The exact SQL behind the last few clicks, with any MySQL errors |
| **SQL** tab | A query box that runs SQL against `fitness_tracker`, plus a history of every query the site has run |
| **MySQL Workbench** | Run `db/03_demo_queries.sql` one statement at a time (Ctrl+Enter) |

A suggested order:

1. **Workbench:** show the tables, `DESCRIBE`, the constraints and the triggers (section A of `03_demo_queries.sql`).
2. **Site, Today tab:** add a food. Open *Live SQL*. The first food on a new day runs `INSERT INTO Daily_Record`, then `INSERT INTO Daily_Food ... ON DUPLICATE KEY UPDATE`.
3. Add the same food again. The servings go up and no new row is added (business rule: no duplicate entries).
4. **Workbench:** run `SELECT * FROM Daily_Food WHERE daily_id = ...` to show that the row changed.
5. **Site, Food & exercise tab:** try to delete *Poha*. MySQL refuses with error 1451 (**ON DELETE RESTRICT**). Then delete a food that shows "Logged 0 times". That one is removed.
6. **Site, Progress tab:** the chart and weekly averages come from `SUM`/`AVG` queries with `GROUP BY`. BMI and weekly weight change come from `ROUND`, `POW` and the window function `LAG()`.
7. **Site, Athletes tab:** add an athlete with a future date of birth. The trigger rejects it. Delete an athlete, and every day and check-in they logged goes with them (**ON DELETE CASCADE**).
8. **Accounts:** sign out, sign in as *Viewer*, open the **SQL** tab and press *My privileges* (`SHOW GRANTS`), then *Try renaming a food*. MySQL refuses with error 1142 (`UPDATE command denied`). As *Clerk*, logging food works but the same rename is still refused. The query history shows which account ran each statement.
9. **Workbench:** run section H of `03_demo_queries.sql`. Each statement breaks one business rule and gets the matching MySQL error. The cascade demo is wrapped in a transaction that rolls back.

## How the schema maps to the PDF

| PDF requirement | Where it is enforced |
|---|---|
| Unique, non-null username | `uq_users_username`, `NOT NULL` |
| No future dates | triggers `trg_users_dob_*`, `trg_daily_date_*`, `trg_week_date_*` (a MySQL CHECK can't call `CURDATE()`) |
| One daily record per user per date | `uq_daily_user_date (user_id, record_date)` |
| Servings and durations > 0, calories ≥ 0 | `chk_servings_positive`, `chk_duration_positive`, `chk_food_calories`, `chk_burn_calories` |
| Duplicate food/exercise on a day updates the quantity | composite PK `(daily_id, food_id)` plus `INSERT ... ON DUPLICATE KEY UPDATE` |
| Catalogue rows in use can't be deleted | `fk_dfood_food`, `fk_dburn_burn` set to `ON DELETE RESTRICT` |
| Deleting a user removes their logs | `fk_daily_user`, `fk_week_user`, `fk_dfood_daily`, `fk_dburn_daily` set to `ON DELETE CASCADE` |
| Derived values are not stored (3NF) | calories in/out/net, weekly averages, age and BMI are computed in queries and the views `vw_daily_summary`, `vw_weekly_average`, `vw_user_profile` |

`food_type` and `burn_type` are `ENUM`s (`FOOD_TYPE_ENUM` / `BURN_TYPE_ENUM` in the ER diagram):

* Food: Breakfast, Grain, Protein, Dairy, Fruit, Vegetable, Snack, Beverage, Dessert, Fast Food
* Burn: Cardio, Strength, Flexibility, Sports, Outdoor

## REST API

All responses look like `{ "data": ..., "sql": ["statements that ran"], "error": "..." }`.

| Method | Path | SQL |
|---|---|---|
| GET/POST | `/api/users` | SELECT / INSERT Users |
| PUT/DELETE | `/api/users/{id}` | UPDATE / DELETE Users |
| GET/POST, PUT/DELETE | `/api/foods`, `/api/foods/{id}` | Food catalogue |
| GET/POST, PUT/DELETE | `/api/burns`, `/api/burns/{id}` | Burn catalogue |
| GET | `/api/day?user_id=&date=` | a day's foods, workouts and totals |
| POST/PUT/DELETE | `/api/day/food`, `/api/day/burn` | Daily_Food / Daily_Burn |
| GET | `/api/summary?user_id=&days=` | calories in, out and net per day |
| GET | `/api/weekly-average?user_id=` | mean daily calories per week |
| GET | `/api/stats?user_id=`, `/api/leaderboard` | totals, favourite foods and exercises, 7-day ranking |
| GET/POST, DELETE | `/api/weekly`, `/api/weekly/{id}` | Weekly_Record with BMI and change |
| POST | `/api/sql` | runs any SQL (SQL tab) |
| GET | `/api/sqllog` | the last 300 statements |

Text values are wrapped in quotes with `'` doubled to `''`, so a name like *O'Brien* works. The SQL is still built by joining strings, so it is open to SQL injection, as the brief asked. Only run this locally.

Banner photo: Unsplash (photo-1476480862126-209bfaa8edc8), used for personal, non-commercial use.
