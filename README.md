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

Install **MySQL Server 8** (MySQL Installer, note the root password) and **Python 3.12** (tick *Add python.exe to PATH*). Then in the `v1` folder:

```bat
run.bat --reset    :: first time: asks for the MySQL root password, builds the database, starts the site
run.bat            :: every time after that
```

Open http://localhost:8000. `run.bat --reset` also puts the sample data back. Settings are in `v1/.env`.

## More

* [`QUICKSTART.md`](QUICKSTART.md): the shortest path to a running site
* [`BASIC_DEMO.md`](BASIC_DEMO.md): a 3-minute demo
* [`v1/README.md`](v1/README.md): setup, how v1 meets each judging criterion, and the REST API reference
* [`v1/DEMO.md`](v1/DEMO.md): step-by-step demo script for the judges
* [`v0/README.md`](v0/README.md): the original Go version

Every setting and password is kept in plaintext in each version's `.env` file. This is a mock project, so that's on purpose.
