# Stride: Fitness Tracker (DBMS project)

A fitness tracker built on a MySQL schema: users log the foods they eat and the workouts they do each day, and a weekly height and weight check-in. The schema is the one in `v0/DBMS.pdf`, with 7 tables, constraints, triggers and views, all written by hand in SQL.

There are two versions of the project.

| | [`v0/`](v0/) | [`v1/`](v1/) |
|---|---|---|
| Backend | Go, `net/http`, plain SQL strings | Django + Django REST Framework |
| Sign-in | Three fixed MySQL accounts (admin, clerk, viewer) | Anyone can register; passwords stored as PBKDF2 hashes in `Users` |
| Sessions | Cookie session kept in the Go server's memory, holding that account's MySQL connection | JWT access and refresh tokens |
| Admin panel | None (the admin account uses the website itself) | Django admin panel with the Unfold theme, at `/admin/` |
| Database | `fitness_tracker` | `fitness_tracker_v1` (same schema plus account columns) |
| Port | 8080 | 8000 |

**v1 is the current version.** It's the one used in the demo.

## Quick start (v1)

You need MySQL or MariaDB, and Python 3.11 or newer.

```bash
cd v1
sudo mariadb < db/00_account.sql   # once: creates the MySQL account the site uses (or: mysql -u root -p < ...)
./run.sh --reset                   # builds and seeds the database, then starts the site
```

Then open http://localhost:8000.

| Account | Password | Role |
|---|---|---|
| `admin` | `admin12345` | admin: admin panel (edit and delete), SQL tab, catalogue editing |
| `clerk` | `clerk12345` | clerk: admin panel, view and add only |
| `haadi_runs`, `lakshya_lifts`, `nishad_cycles` | `stride12345` | athletes with 4 weeks of sample logs |

Later starts are just `./run.sh`; that keeps your data. `./run.sh --reset` restores the sample data.

## Running v1 on Windows

`run.sh` is a bash script, so on Windows you run its steps by hand. The settings come from `v1/.env`, which is already in the repo; Django reads it on startup. If your MySQL port, database user or password differ, change them there.

**You need:**
* **MySQL Server 8** and **MySQL Workbench**, from the MySQL Installer: https://dev.mysql.com/downloads/installer/. During setup, note the root password.
* **Python 3.11, 3.12 or 3.13** from https://www.python.org/downloads/. Tick *Add python.exe to PATH*. `mysqlclient` has ready-made Windows packages for these versions.

**1. Build the database in MySQL Workbench.** Connect as `root`. For each file, use **File → Open SQL Script**, then click the lightning bolt (Execute all):

1. `v1/db/00_account.sql` creates the account the site connects as (`stride_app` / `stride_app_pass`, matching `.env`).
2. `v1/db/01_schema.sql` creates `fitness_tracker_v1` with its tables, triggers and views.

Run these as root: with MySQL 8's default settings, only root can create triggers.

**2. Install and migrate.** In PowerShell, from the `v1` folder:

```powershell
py -m venv .venv
.venv\Scripts\pip install -r requirements.txt
.venv\Scripts\python manage.py migrate
```

`migrate` adds Django's own tables (sessions, admin log) next to the 7 tracker tables. It doesn't change the tracker tables.

**3. Load the sample data.** In Workbench, open and run `v1/db/02_seed.sql`.

**4. Start the site:**

```powershell
.venv\Scripts\python manage.py runserver 8000
```

Open http://localhost:8000. Next time, only step 4 is needed.

**To reset to the sample data**, run steps 1.2, the `migrate` command and step 3 again. `01_schema.sql` drops the database first.

If `pip install` fails on `mysqlclient`, your Python version is probably too new for it. Install Python 3.12 and recreate `.venv`.

## More

* [`QUICKSTART.md`](QUICKSTART.md): the shortest path to a running site
* [`BASIC_DEMO.md`](BASIC_DEMO.md): a 3-minute demo
* [`v1/README.md`](v1/README.md): setup, how v1 meets each judging criterion, and the REST API reference
* [`v1/DEMO.md`](v1/DEMO.md): step-by-step demo script for the judges
* [`v0/README.md`](v0/README.md): the original Go version

Every setting and password is kept in plaintext in each version's `.env` file. This is a mock project, so that's on purpose.
