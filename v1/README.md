# Stride v1: Fitness Tracker on Django + MySQL

v1 rebuilds the v0 project (`../v0`, Go + plain SQL) as a normal website with real user accounts:

* **Django REST API** over HTTP, with every v0 endpoint plus sign-up, sign-in and account endpoints
* **Real accounts**: anyone can register, passwords are stored as PBKDF2 hashes in `Users.password`
* **JWT authentication** (access + refresh tokens, `djangorestframework-simplejwt`)
* **MySQL / MariaDB**: the same 7 tables, keys, triggers and views as v0, created by hand-written SQL files, so everything is visible in MySQL Workbench
* **Admin panel** at `/admin/` (Django admin with the Unfold theme): dashboard, filters, search and every table
* Every password and setting is kept in plaintext in `.env` (mock project)

```
.env                    settings and every password, in plaintext
db/00_account.sql       MySQL account the site connects as (run once, as root)
db/01_schema.sql        database fitness_tracker_v1: 7 tables, constraints, triggers, 5 views
db/02_seed.sql          sample data: 3 athletes + 1 staff account, 38 foods, 18 exercises, 4 weeks of logs
db/03_demo_queries.sql  queries for the Workbench demo, including every business rule
stride/                 Django project (settings read .env)
tracker/models.py       models mapped onto the SQL tables and views (managed = False)
tracker/api.py          the REST API
tracker/admin.py        the admin panel and its dashboard
tracker/sqlcapture.py   records the SQL behind each request; error messages for constraints and triggers
web/                    the website (index.html, style.css, app.js)
run.sh                  starts everything (./run.sh --reset rebuilds the database)
DEMO.md                 step-by-step demo script for the judges
db/judge_queries.sql    54 ready-made queries for the judges, each naming its tables
```

## 1. Set up the database (once)

**a. Create the MySQL account** the site uses. This needs the root user once:

```bash
sudo mariadb < db/00_account.sql          # MariaDB (Arch, Debian...): root signs in through the OS
mysql -u root -p < db/00_account.sql      # MySQL with a root password
```

This creates `stride_app` / `stride_app_pass` (same as `DB_USER` / `DB_PASSWORD` in `.env`) with every privilege on `fitness_tracker_v1` and nothing else.

**b. Build and fill the database:**

```bash
./run.sh --reset
```

That runs, in order:

1. `db/01_schema.sql`: drops and recreates `fitness_tracker_v1` with the 7 tables, triggers and views
2. `python manage.py migrate`: adds Django's own tables next to them (`django_session`, `django_admin_log`, `auth_permission`...). It does **not** touch the 7 tracker tables, whose models are `managed = False`.
3. `db/02_seed.sql`: sample data

To do the same in **MySQL Workbench**, connect as `stride_app`, run `01_schema.sql`, run `.venv/bin/python manage.py migrate` in a terminal, then run `02_seed.sql`.

## 2. Start the site

```bash
./run.sh
```

The first start creates `.venv` and installs `requirements.txt`. Then open:

* http://localhost:8000: the website
* http://localhost:8000/admin/: the admin panel

| Account | Password | |
|---|---|---|
| `admin` | `admin12345` | staff: admin panel, SQL tab, Live SQL drawer, edits the catalogue |
| `haadi_runs`, `lakshya_lifts`, `nishad_cycles` | `stride12345` | normal athletes with 4 weeks of logs |

Or create a new account with **Create account** on the home page.

## How it answers the judging criteria

### Users can register and sign in

* `POST /api/register` validates the username (format, already taken) and password (Django's validators: length, common, numeric only), then runs `INSERT INTO Users (...)` with the hashed password. The response already carries a JWT, so the new user lands straight in the app.
* `POST /api/login` checks the username and password against `Users.password` and updates `Users.last_login`.
* A wrong password returns `Wrong username or password, or the account is disabled.` A disabled account (`is_active = 0`) can't sign in.

### JWT tokens, not DB sessions

* Signing in returns an **access token** (15 minutes) and a **refresh token** (7 days), both signed with HS256 and `SECRET_KEY` from `.env`. The browser keeps them in `localStorage` and sends `Authorization: Bearer <access>` with every API call.
* When the access token expires, the API answers 401 and `app.js` quietly trades the refresh token for a new one (`POST /api/token/refresh`), then retries the call.
* There is **no session table for the website**: the server keeps no state per login. On each request it checks the token's signature and expiry, then loads that user from `Users` (`SELECT ... FROM Users WHERE user_id = ...`, visible in the Live SQL drawer). So deleting or disabling a user in the database locks them out on the next request.
* Signing out deletes the tokens in the browser. JWTs can't be revoked on the server without a blacklist table. That was left out so `DELETE FROM Users` still works from Workbench. An access token that was copied elsewhere stays valid for at most 15 minutes.
* The **admin panel** is Django's own staff tool and uses Django's normal cookie session (`django_session`). It is separate from the website's JWT login.

### Changes in the DB show on the website

The website keeps no data of its own: every page asks the API, and the API reads MySQL each time. Change something in Workbench, then click back into the browser window: the page reloads its data from the database as soon as the window gets focus again (unless you are in the middle of typing into a form). Reloading the page or switching tabs does the same. For example, signed in as `haadi_runs` on the Today page:

```sql
UPDATE Daily_Food SET servings = 5 WHERE daily_id = 21 AND food_id = 4;      -- Masala Dosa today: 555 -> 1,850 kcal
INSERT INTO Food (name, food_type, calories_per_serving) VALUES ('Sabudana Khichdi', 'Breakfast', 320);  -- appears in the food picker
UPDATE Users SET user_contact = 'new@example.com' WHERE username = 'haadi_runs';   -- profile card updates
UPDATE Users SET is_active = 0 WHERE username = 'haadi_runs';  -- signed out on the next click (set it back to 1 after)
```

### Actions on the website reach the DB

Every form and button calls the API, which writes to MySQL. Each API request is a single transaction, so if one step fails the earlier ones are undone too. Some examples:

| On the site | SQL |
|---|---|
| Create account | `INSERT INTO Users` |
| First food of a day | `INSERT INTO Daily_Record`, then `INSERT INTO Daily_Food ... ON DUPLICATE KEY UPDATE servings = servings + VALUES(servings)` |
| Change servings / remove a food | `UPDATE Daily_Food` / `DELETE FROM Daily_Food` |
| Weekly check-in | `INSERT INTO Weekly_Record` |
| Edit profile / change password | `UPDATE Users` |
| Delete account | `DELETE FROM Users` (its days, meals, workouts and check-ins go with it) |

Signed in as staff, the **Live SQL** button (bottom right) shows the exact statements behind each click. The **SQL** tab lists every query the API ran, and has a query box.

Constraint and trigger errors from MySQL are shown to the user as readable messages that still name the rule, so it can be pointed out in Workbench. Try: saving a second check-in for the same week ("There is already a check-in for that week (MySQL UNIQUE constraint uq_week_user_date, error 1062)"), a negative or zero quantity (CHECK), a date in the future (trigger, error 1644), or, as staff, deleting Poha (ON DELETE RESTRICT).

The admin panel checks the same rules in its forms first, so there it shows a form error instead of a database error. The website leaves them to MySQL on purpose.

### Who can do what

| | Anyone | Signed-in athlete | Staff (`is_staff = 1`) |
|---|---|---|---|
| Register, sign in | yes | | |
| Own days, meals, workouts, check-ins, profile | | yes | yes, and anyone's via `?user_id=` |
| Read the food / exercise catalogue, leaderboard | | yes | yes |
| Edit the catalogue, list / edit / delete users | | no (403) | yes |
| SQL tab, Live SQL drawer, admin panel | | no (403) | yes |

The server checks all of this. The website only hides buttons that would be refused anyway.

## Admin panel

`/admin/`, sign in as `admin`:

* **Dashboard**: athletes, active this week, days / foods / workouts logged, a 14-day chart of calories eaten vs. burnt, the leaderboard, the most logged foods and the newest accounts
* **Users**: role badge, age, days logged, check-ins, join and last sign-in dates; filters for staff / active / join date; search. Each user's page shows the password hash, has a field to set a new password, lists the weekly check-ins, and links to that user's logs.
* **Daily records**: calories in / out / net per day, filters by user and date range; each day's page lists its foods and workouts
* **Food log / Workout log**: every `Daily_Food` / `Daily_Burn` row through the views `vw_food_log` / `vw_burn_log`, filterable by user, type and date. Read only: Django's admin can't edit tables with a composite primary key, so those rows are changed from the website.
* **Daily summary**: the view `vw_daily_summary`, read only
* **Foods / Exercises**: the catalogue with how often each item was logged. Deleting one that is in use is refused (RESTRICT).
* **History**: every change made through the admin is recorded in `django_admin_log`

## Schema changes from v0

Same tables, columns, keys, constraints, triggers and views, except:

* `Users` is also the login table. It gained `password` (hash), `is_staff`, `is_active`, `date_joined` and `last_login`.
* `Users.unhashed_password` keeps a plaintext copy of each password (mock project). It is filled whenever a password is set, from sign-up, the password change and the admin panel. It is only visible in the database: the API, the views and the admin panel never show it.
* Two new views for the admin panel: `vw_food_log`, `vw_burn_log`. `vw_user_profile` now shows the account columns too, but never the password.
* Django adds its own tables next to these through `migrate` (`django_session`, `django_admin_log`, `django_content_type`, `django_migrations`, `auth_permission`, `auth_group*`).
* Deleting a **staff** user from Workbench fails if they have entries in `django_admin_log` (that foreign key is RESTRICT). Delete them from the admin panel instead. Athletes can be deleted from either place.

## REST API

Every reply is `{"data": ...}` or `{"error": "..."}`, with the matching HTTP status (200, 201, 400, 401, 403, 404, 409). Staff replies also carry `"sql": [...]`. Every endpoint except the first three needs `Authorization: Bearer <access token>`.

| Method | Path | |
|---|---|---|
| POST | `/api/register` | create an account, returns tokens + profile |
| POST | `/api/login` | returns tokens + profile |
| POST | `/api/token/refresh` | new access token |
| POST | `/api/logout` | nothing to undo on the server (JWT); the browser drops its tokens |
| GET / PUT / DELETE | `/api/me` | own profile; DELETE needs `password` |
| POST | `/api/me/password` | change password |
| GET | `/api/today` | `CURDATE()` |
| GET / POST | `/api/users` | staff: list / create users |
| PUT / DELETE | `/api/users/{id}` | self or staff |
| GET / POST, PUT / DELETE | `/api/foods`, `/api/foods/{id}` | read: everyone; write: staff |
| GET / POST, PUT / DELETE | `/api/burns`, `/api/burns/{id}` | read: everyone; write: staff |
| GET | `/api/day?date=` | a day's foods, workouts and totals |
| POST / PUT / DELETE | `/api/day/food`, `/api/day/burn` | Daily_Food / Daily_Burn (own days only) |
| GET | `/api/summary?days=`, `/api/weekly-average`, `/api/stats` | reports for the signed-in user |
| GET | `/api/leaderboard` | calories burnt in the last 7 days, all athletes |
| GET / POST, DELETE | `/api/weekly`, `/api/weekly/{id}` | weekly check-ins with BMI and change |
| GET | `/api/sqllog` | staff: the last 300 statements |
| POST | `/api/sql` | staff: run any SQL |

Unlike v0, the API never glues values into SQL strings. The ORM and `%s` parameters do the quoting, so it is not open to SQL injection. The staff-only SQL tab is the one exception, on purpose.
