# Quickstart

Gets Stride v1 running at http://localhost:8000. Every setting and password is in `v1/.env`.

## Linux / macOS (MySQL or MariaDB)

```bash
cd v1
sudo mariadb < db/00_account.sql   # once; with MySQL: mysql -u root -p < db/00_account.sql
./run.sh --reset                   # builds and seeds the database, then starts the site
```

Later starts are just `./run.sh`, which keeps your data.

## Windows (MySQL 8 + Workbench)

1. In Workbench, connected as `root`, open and run `v1/db/00_account.sql`, then `v1/db/01_schema.sql`.
2. In PowerShell, from the `v1` folder:
   ```powershell
   py -m venv .venv
   .venv\Scripts\pip install -r requirements.txt
   .venv\Scripts\python manage.py migrate
   ```
3. In Workbench, run `v1/db/02_seed.sql`.
4. Start the site:
   ```powershell
   .venv\Scripts\python manage.py runserver 8000
   ```

Use Python 3.11, 3.12 or 3.13. More detail is in the root [README](README.md).

## Sign in

| Account | Password | |
|---|---|---|
| `admin` | `admin12345` | staff; admin panel at http://localhost:8000/admin/ |
| `haadi_runs`, `lakshya_lifts`, `nishad_cycles` | `stride12345` | athletes with sample logs |

In Workbench, connect as `stride_app` / `stride_app_pass` on `127.0.0.1:3306`, schema `fitness_tracker_v1`.

## Reset to the sample data

Linux and macOS: `./run.sh --reset`. Windows: run `01_schema.sql`, then `migrate`, then `02_seed.sql` again.
