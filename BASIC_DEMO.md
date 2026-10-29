# Basic demo (3 minutes)

Have the site at http://localhost:8000 and MySQL Workbench (schema `fitness_tracker_v1`) side by side. For the full version, see [v1/DEMO.md](v1/DEMO.md).

## 1. Sign-up is real

On the site, click **Create account** and register `judge_demo` / `judge12345`. Then in Workbench:

```sql
SELECT user_id, username, password FROM Users WHERE username = 'judge_demo';
```

There's a new row, and the password is stored as a hash.

## 2. JWT, not DB sessions

Press **F12** and open **Application → Local Storage**: the `stride-access` and `stride-refresh` tokens are there. Every API call sends `Authorization: Bearer …`. No session row is stored for the website.

## 3. Website → DB

Sign in as `haadi_runs` / `stride12345`. On **Today**, add **Poha × 2** and click **Save changes**. Then in Workbench:

```sql
SELECT * FROM vw_food_log WHERE username = 'haadi_runs' AND record_date = CURDATE();
```

The Poha row is there.

## 4. DB → website

In Workbench:

```sql
UPDATE Daily_Food SET servings = 5 WHERE daily_id = 21 AND food_id = 4;   -- Masala Dosa: 555 -> 1,850 kcal
```

Click back into the browser. The Today page reloads from MySQL and the totals change.

## 5. The database enforces its rules

On **Progress**, save a check-in for this week. MySQL refuses it with *UNIQUE constraint uq_week_user_date*. Then disable the account in Workbench:

```sql
UPDATE Users SET is_active = 0 WHERE username = 'haadi_runs';   -- haadi is signed out on the next click
UPDATE Users SET is_active = 1 WHERE username = 'haadi_runs';   -- undo
```

## Afterwards

Reset with `cd v1 && ./run.sh --reset`.
