# Demo script for the judges

About 10 minutes. It follows the four judging criteria: **sign-in is authenticated**, **JWT instead of DB sessions**, **website → DB**, **DB → website**.

## Before the judges arrive

1. Reset to the clean sample data and start the server:
   ```bash
   cd v1
   ./run.sh --reset        # rebuilds fitness_tracker_v1 and starts the site
   ```
   Later restarts, which keep the data, are just `./run.sh`.
2. Open three windows side by side:
   * **Browser A:** http://localhost:8000, signed out
   * **Browser B** (private window): http://localhost:8000/admin/, signed in as `admin` / `admin12345`
   * **MySQL Workbench:** connected as `stride_app` / `stride_app_pass` on `127.0.0.1:3306`, default schema `fitness_tracker_v1`, with `db/03_demo_queries.sql` open in a tab
3. The sample athletes are `haadi_runs`, `lakshya_lifts` and `nishad_cycles`, all with password `stride12345`.

---

## 1. Schema (1 min, Workbench)

> "Same schema as v0: 7 tables, built by hand-written SQL, not by Django."

* Show the tables `Users`, `Food`, `Burn`, `Daily_Record`, `Daily_Food`, `Daily_Burn` and `Weekly_Record`.
* Show **Database → Reverse Engineer** (the ER diagram), or `SHOW CREATE TABLE Daily_Food;`:
  * composite primary key `(daily_id, food_id)`
  * `ON DELETE CASCADE` towards the day
  * `ON DELETE RESTRICT` towards the food
* Show `SHOW TRIGGERS;` and the views `vw_daily_summary`, `vw_weekly_average` and `vw_food_log`.
* Point out that `Users` is also the login table, and `Users.password` stores a hash:
  ```sql
  SELECT user_id, username, password, is_staff, last_login FROM Users;
  ```

## 2. Users register and sign in (2 min, Browser A + Workbench)

1. Click **Create account** and register `judge_demo` with password `judge12345`. You land straight in the app.
2. In Workbench:
   ```sql
   SELECT user_id, username, password, date_joined FROM Users WHERE username = 'judge_demo';
   ```
   > "A new row, and the password is a PBKDF2 hash, never the plain text."
3. Click **Sign out**. Try signing in with a wrong password. The site says *Wrong username or password, or the account is disabled.*
4. Sign in as `haadi_runs` / `stride12345`, then run:
   ```sql
   SELECT username, last_login FROM Users WHERE username = 'haadi_runs';
   ```
   > "last_login just updated."

## 3. JWT, not DB sessions (2 min, Browser A DevTools)

1. Press **F12**, open **Application → Local Storage → localhost:8000**, and show `stride-access` and `stride-refresh`.
2. Paste the access token into https://jwt.io. It contains `user_id`, `exp` (15 minutes from now), and the HS256 signature made with `SECRET_KEY` from `.env`.
3. Open **Network**, click any request, and show the `Authorization: Bearer eyJ…` header.
4. Back in Workbench:
   ```sql
   SELECT COUNT(*) FROM django_session;
   ```
   > "The website stores no sessions. Every request is checked by the token's signature and expiry, then the user is loaded from Users."
   * The only rows here come from the admin panel, which is Django's built-in staff tool and uses a cookie session.
5. Show the token refresh: in DevTools, set `stride-access` to `junk` and click a tab. The page still works, because the API answered 401 and `app.js` exchanged the refresh token for a new access token. The Network tab shows `token/refresh`.

## 4. Website → DB (2 min, Browser A + Workbench)

Signed in as `haadi_runs`, on **Today**:

1. Add a food, for example **Poha × 2**, then run:
   ```sql
   SELECT * FROM vw_food_log WHERE username = 'haadi_runs' AND record_date = CURDATE();
   ```
   The new row is there.
2. Change its servings and run the query again: the row is updated. Remove the food: the row is gone.
3. Add a workout, then run:
   ```sql
   SELECT * FROM vw_burn_log WHERE username = 'haadi_runs' AND record_date = CURDATE();
   ```
4. Go to **Progress** and save a check-in for **this week** (any height and weight). The site refuses with:
   > *There is already a check-in for that week (MySQL UNIQUE constraint uq_week_user_date, error 1062).*

   > "That error comes from MySQL itself; the site shows the constraint's name."
5. Go to **Account**, edit the contact field and click **Save profile**, then run `SELECT * FROM Users WHERE user_id = 1;`.

**With staff, the SQL is visible live:** sign in as `admin` in Browser A instead.

* Open the **Live SQL** drawer (bottom right) and click around. Each click lists the exact `SELECT`, `INSERT`, `UPDATE` or `DELETE` statements it ran.
* In **Food & exercise**, try to delete **Poha**. It is refused with *Can't delete: N logged entries still use it (the foreign key is ON DELETE RESTRICT).*

## 5. DB → website (2 min, Workbench + Browser A as `haadi_runs`)

Run each statement in Workbench, then **click back into the browser window**. The page reloads from MySQL when the window regains focus.

```sql
-- Today's Masala Dosa: 1.5 servings (555 kcal) -> 5 servings (1,850 kcal); the track bars move
UPDATE Daily_Food SET servings = 5 WHERE daily_id = 21 AND food_id = 4;

-- a new food appears in the "Add food" picker
INSERT INTO Food (name, food_type, calories_per_serving) VALUES ('Sabudana Khichdi', 'Breakfast', 320);

-- the profile card changes
UPDATE Users SET user_contact = 'judges@example.com' WHERE username = 'haadi_runs';

-- disable the account: haadi is signed out on the next click and can't sign back in
UPDATE Users SET is_active = 0 WHERE username = 'haadi_runs';
UPDATE Users SET is_active = 1 WHERE username = 'haadi_runs';   -- undo
```

Then show the database enforcing its own rules, straight from Workbench:

```sql
UPDATE Daily_Food SET servings = 0 WHERE daily_id = 21 AND food_id = 4;               -- CHECK constraint fails
INSERT INTO Daily_Record (user_id, record_date) VALUES (1, CURDATE() + INTERVAL 1 DAY); -- trigger: "Cannot log a day in the future"
DELETE FROM Users WHERE username = 'judge_demo';  -- cascades to their days, meals and check-ins; judge_demo can't use the site any more
```

## 6. Admin panel (1 min, Browser B)

* The **dashboard** shows the KPIs, a 14-day chart of calories eaten vs. burnt, the leaderboard and the most logged foods. Refresh it: the data from steps 4 and 5 is already counted.
* **Users:** open `haadi_runs`. It shows the password hash, the weekly check-ins tab and links to the logs. Note that `judge_demo` is gone.
* **Food log:** filter by user and date. This page reads the view `vw_food_log`.
* **History:** every admin change is stored in `django_admin_log`. Show it with `SELECT * FROM django_admin_log;`.

---

## Likely questions

| Question | Answer |
|---|---|
| Why JWT? | It is stateless: the server keeps nothing per login and only checks the signature. The access token lasts 15 minutes and the refresh token 7 days. |
| How does sign-out work? | The browser deletes its tokens. To stop a user from the server side, set `is_active = 0`; it takes effect on their next request. A token blacklist table would add a foreign key that blocks `DELETE FROM Users`, so it was left out on purpose. |
| Is it open to SQL injection? | No. The ORM and `%s` parameters do the quoting. The staff-only SQL tab runs raw SQL on purpose. |
| What happens if a request fails half-way? | Each API request is one transaction (`ATOMIC_REQUESTS`), so everything it did is rolled back. |
| Who can see what? | Athletes see only their own data. Staff can see everyone's and edit the catalogue. Every rule is checked on the server, and the API answers 403 to anything not allowed. |

## Reset after the demo

```bash
./run.sh --reset
```
