# Quickstart

Gets Stride v1 running at http://localhost:8000. Every setting and password is in `v1/.env`.

## Linux / macOS (MySQL or MariaDB)

```bash
cd v1
sudo mariadb < db/00_account.sql   # once; with MySQL: mysql -u root -p < db/00_account.sql
./run.sh --reset                   # builds and seeds the database, then starts the site
```

Later starts are just `./run.sh`, which keeps your data.

## Windows (MySQL 8, Python 3.11 to 3.13)

```bat
cd v1
run.bat --reset    :: first time: asks for the MySQL root password, then builds, seeds and starts
run.bat            :: later starts keep your data
```

## Sign in

| Account | Password | |
|---|---|---|
| `admin` | `admin12345` | admin; admin panel at http://localhost:8000/admin/ |
| `clerk` | `clerk12345` | clerk; admin panel, view and add only |
| `haadi_runs`, `lakshya_lifts`, `nishad_cycles` | `stride12345` | athletes with sample logs |

In Workbench, connect as `stride_app` / `stride_app_pass` on `127.0.0.1:3306`, schema `fitness_tracker_v1`.

## Reset to the sample data

`./run.sh --reset` (Linux, macOS) or `run.bat --reset` (Windows).
