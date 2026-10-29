-- =====================================================================
--  STRIDE v1  -  judge_queries.sql
--  Ready-made queries to run live in MySQL Workbench when the judges ask
--  "show us a query that ...". Each one says which tables / views it uses.
--
--  Run one at a time: put the cursor in a query and press Ctrl+Enter.
--  Sections A-J only read data. Section K changes data, inside a
--  transaction that is rolled back. Section L shows the database
--  refusing bad data (each statement is meant to fail).
--
--  Tables:  Users, Food, Burn, Daily_Record, Daily_Food, Daily_Burn, Weekly_Record
--  Views:   vw_daily_summary, vw_weekly_average, vw_user_profile, vw_food_log, vw_burn_log
-- =====================================================================
USE fitness_tracker_v1;


-- ---------------------------------------------------------------------
-- A. The schema itself
-- ---------------------------------------------------------------------

-- A1. Every table and view in the database          [information_schema]
SHOW FULL TABLES;

-- A2. Columns, types and keys of one table          [Daily_Food]
DESCRIBE Daily_Food;

-- A3. Every foreign key and what it does on delete  [information_schema.REFERENTIAL_CONSTRAINTS]
SELECT  constraint_name, table_name, referenced_table_name, delete_rule, update_rule
FROM information_schema.REFERENTIAL_CONSTRAINTS
WHERE constraint_schema = 'fitness_tracker_v1' AND table_name NOT LIKE 'django%' AND table_name NOT LIKE 'auth%'
ORDER BY table_name;

-- A4. The CHECK and UNIQUE constraints              [information_schema.TABLE_CONSTRAINTS]
SELECT  table_name, constraint_name, constraint_type
FROM information_schema.TABLE_CONSTRAINTS
WHERE constraint_schema = 'fitness_tracker_v1' AND constraint_type IN ('CHECK', 'UNIQUE')
  AND table_name NOT LIKE 'django%' AND table_name NOT LIKE 'auth%'
ORDER BY table_name;

-- A5. The triggers (no future dates)                [information_schema.TRIGGERS]
SELECT trigger_name, event_manipulation, event_object_table, action_timing
FROM information_schema.TRIGGERS
WHERE trigger_schema = 'fitness_tracker_v1';


-- ---------------------------------------------------------------------
-- B. Simple SELECT, WHERE, ORDER BY, LIMIT
-- ---------------------------------------------------------------------

-- B1. All accounts, with the hash and the plaintext copy   [Users]
SELECT user_id, username, user_contact, dob, password, unhashed_password, is_staff, is_active, last_login
FROM Users;

-- B2. The 5 most calorie-dense foods                       [Food]
SELECT name, food_type, calories_per_serving
FROM Food
ORDER BY calories_per_serving DESC
LIMIT 5;

-- B3. Cardio exercises burning more than 9 kcal a minute   [Burn]
SELECT burn_name, calories_per_min
FROM Burn
WHERE burn_type = 'Cardio' AND calories_per_min > 9
ORDER BY calories_per_min DESC;

-- B4. Foods whose name contains "Masala" (pattern match)   [Food]
SELECT name, food_type, calories_per_serving
FROM Food
WHERE name LIKE '%Masala%';

-- B5. Foods between 100 and 200 kcal, in two categories    [Food]
SELECT name, food_type, calories_per_serving
FROM Food
WHERE calories_per_serving BETWEEN 100 AND 200
  AND food_type IN ('Breakfast', 'Protein')
ORDER BY calories_per_serving;


-- ---------------------------------------------------------------------
-- C. JOINs
-- ---------------------------------------------------------------------

-- C1. What haadi_runs ate today, with calories (4-table join)
--     [Users, Daily_Record, Daily_Food, Food]
SELECT  u.username, dr.record_date, f.name, df.servings,
        df.servings * f.calories_per_serving AS calories
FROM Users u
JOIN Daily_Record dr ON dr.user_id  = u.user_id
JOIN Daily_Food   df ON df.daily_id = dr.daily_id
JOIN Food         f  ON f.food_id   = df.food_id
WHERE u.username = 'haadi_runs' AND dr.record_date = CURDATE();

-- C2. Every workout this week, all users                   [Users, Daily_Record, Daily_Burn, Burn]
SELECT  u.username, dr.record_date, b.burn_name, db.duration_min,
        db.duration_min * b.calories_per_min AS calories
FROM Daily_Burn db
JOIN Daily_Record dr ON dr.daily_id = db.daily_id
JOIN Users u         ON u.user_id   = dr.user_id
JOIN Burn b          ON b.burn_id   = db.burn_id
WHERE dr.record_date >= CURDATE() - INTERVAL 6 DAY
ORDER BY dr.record_date DESC, u.username;

-- C3. LEFT JOIN: every user and how many days they logged, including users with none
--     [Users, Daily_Record]
SELECT u.username, COUNT(dr.daily_id) AS days_logged
FROM Users u
LEFT JOIN Daily_Record dr ON dr.user_id = u.user_id
GROUP BY u.user_id, u.username
ORDER BY days_logged DESC;

-- C4. LEFT JOIN + IS NULL: foods nobody has ever eaten     [Food, Daily_Food]
SELECT f.name, f.food_type
FROM Food f
LEFT JOIN Daily_Food df ON df.food_id = f.food_id
WHERE df.food_id IS NULL;

-- C5. Self join: pairs of users born in the same year      [Users]
SELECT a.username AS user_a, b.username AS user_b, YEAR(a.dob) AS born
FROM Users a
JOIN Users b ON YEAR(a.dob) = YEAR(b.dob) AND a.user_id < b.user_id;


-- ---------------------------------------------------------------------
-- D. Aggregates: GROUP BY, HAVING
-- ---------------------------------------------------------------------

-- D1. Total calories eaten per user, all time              [Users, Daily_Record, Daily_Food, Food]
SELECT  u.username, ROUND(SUM(df.servings * f.calories_per_serving)) AS total_kcal_eaten
FROM Users u
JOIN Daily_Record dr ON dr.user_id  = u.user_id
JOIN Daily_Food   df ON df.daily_id = dr.daily_id
JOIN Food         f  ON f.food_id   = df.food_id
GROUP BY u.user_id, u.username
ORDER BY total_kcal_eaten DESC;

-- D2. Number of foods and average calories per food type   [Food]
SELECT food_type, COUNT(*) AS foods, ROUND(AVG(calories_per_serving)) AS avg_kcal,
       MIN(calories_per_serving) AS lowest, MAX(calories_per_serving) AS highest
FROM Food
GROUP BY food_type
ORDER BY avg_kcal DESC;

-- D3. HAVING: exercises done for more than 300 minutes in total   [Daily_Burn, Burn]
SELECT b.burn_name, SUM(db.duration_min) AS total_minutes, COUNT(*) AS sessions
FROM Daily_Burn db
JOIN Burn b ON b.burn_id = db.burn_id
GROUP BY b.burn_id, b.burn_name
HAVING SUM(db.duration_min) > 300
ORDER BY total_minutes DESC;

-- D4. Most popular foods: how many times each was logged   [Daily_Food, Food]
SELECT f.name, COUNT(*) AS times_logged, SUM(df.servings) AS total_servings
FROM Daily_Food df
JOIN Food f ON f.food_id = df.food_id
GROUP BY f.food_id, f.name
ORDER BY times_logged DESC
LIMIT 10;

-- D5. Calories eaten per food type for haadi_runs          [Users, Daily_Record, Daily_Food, Food]
SELECT f.food_type, ROUND(SUM(df.servings * f.calories_per_serving)) AS kcal
FROM Daily_Food df
JOIN Food f          ON f.food_id   = df.food_id
JOIN Daily_Record dr ON dr.daily_id = df.daily_id
JOIN Users u         ON u.user_id   = dr.user_id
WHERE u.username = 'haadi_runs'
GROUP BY f.food_type
ORDER BY kcal DESC;


-- ---------------------------------------------------------------------
-- E. Subqueries
-- ---------------------------------------------------------------------

-- E1. Foods above the average calories (scalar subquery)   [Food]
SELECT name, calories_per_serving
FROM Food
WHERE calories_per_serving > (SELECT AVG(calories_per_serving) FROM Food)
ORDER BY calories_per_serving DESC;

-- E2. IN: users who have ever done HIIT Circuit               [Users, Daily_Record, Daily_Burn, Burn]
SELECT username
FROM Users
WHERE user_id IN (SELECT dr.user_id
                  FROM Daily_Record dr
                  JOIN Daily_Burn db ON db.daily_id = dr.daily_id
                  JOIN Burn b        ON b.burn_id   = db.burn_id
                  WHERE b.burn_name = 'HIIT Circuit');

-- E3. NOT EXISTS: days with meals but no workout (rest days)   [Daily_Record, Users, Daily_Burn]
SELECT u.username, dr.record_date
FROM Daily_Record dr
JOIN Users u ON u.user_id = dr.user_id
WHERE NOT EXISTS (SELECT 1 FROM Daily_Burn db WHERE db.daily_id = dr.daily_id)
ORDER BY dr.record_date DESC;

-- E4. Correlated subquery: each user's highest-calorie meal entry   [vw_food_log]
SELECT fl.username, fl.record_date, fl.food_name, fl.calories
FROM vw_food_log fl
WHERE fl.calories = (SELECT MAX(x.calories) FROM vw_food_log x WHERE x.user_id = fl.user_id);

-- E5. Derived table: users whose average daily intake is over 2,000 kcal   [vw_daily_summary]
SELECT t.username, t.avg_in
FROM (SELECT username, ROUND(AVG(calories_in)) AS avg_in
      FROM vw_daily_summary
      GROUP BY user_id, username) AS t
WHERE t.avg_in > 2000;


-- ---------------------------------------------------------------------
-- F. Views
-- ---------------------------------------------------------------------

-- F1. Calories in / out / net per day                      [vw_daily_summary]
SELECT username, record_date, calories_in, calories_out, net_calories
FROM vw_daily_summary
WHERE record_date >= CURDATE() - INTERVAL 6 DAY
ORDER BY username, record_date;

-- F2. Weekly averages                                      [vw_weekly_average]
SELECT * FROM vw_weekly_average ORDER BY username, week_start;

-- F3. Profiles with age computed on the fly (no password)  [vw_user_profile]
SELECT * FROM vw_user_profile;

-- F4. A view's definition                                  [information_schema.VIEWS]
SELECT view_definition FROM information_schema.VIEWS
WHERE table_schema = 'fitness_tracker_v1' AND table_name = 'vw_daily_summary';


-- ---------------------------------------------------------------------
-- G. Dates
-- ---------------------------------------------------------------------

-- G1. Each user's age, from date of birth                  [Users]
SELECT username, dob, TIMESTAMPDIFF(YEAR, dob, CURDATE()) AS age
FROM Users
WHERE dob IS NOT NULL;

-- G2. Days logged per weekday name                         [Daily_Record]
SELECT DAYNAME(record_date) AS weekday, COUNT(*) AS days
FROM Daily_Record
GROUP BY DAYOFWEEK(record_date), DAYNAME(record_date)
ORDER BY DAYOFWEEK(record_date);

-- G3. Who signed in most recently, and how long ago        [Users]
SELECT username, last_login, TIMESTAMPDIFF(MINUTE, last_login, NOW()) AS minutes_ago
FROM Users
WHERE last_login IS NOT NULL
ORDER BY last_login DESC;


-- ---------------------------------------------------------------------
-- H. Window functions
-- ---------------------------------------------------------------------

-- H1. Leaderboard: rank users by calories burnt in the last 7 days   [vw_daily_summary]
SELECT  username,
        ROUND(SUM(calories_out)) AS kcal_burnt,
        RANK() OVER (ORDER BY SUM(calories_out) DESC) AS place
FROM vw_daily_summary
WHERE record_date >= CURDATE() - INTERVAL 6 DAY
GROUP BY user_id, username;

-- H2. Weight change week to week (LAG)                     [Weekly_Record, Users]
SELECT  u.username, w.week_start_date, w.weight_kg,
        w.weight_kg - LAG(w.weight_kg) OVER (PARTITION BY w.user_id ORDER BY w.week_start_date) AS change_kg,
        ROUND(w.weight_kg / POW(w.height_cm / 100, 2), 1) AS bmi
FROM Weekly_Record w
JOIN Users u ON u.user_id = w.user_id
ORDER BY u.username, w.week_start_date;

-- H3. Running total of calories eaten by haadi_runs        [vw_daily_summary]
SELECT  record_date, calories_in,
        SUM(calories_in) OVER (ORDER BY record_date) AS running_total
FROM vw_daily_summary
WHERE username = 'haadi_runs'
ORDER BY record_date;


-- ---------------------------------------------------------------------
-- I. CASE and UNION
-- ---------------------------------------------------------------------

-- I1. Label each day as a surplus or deficit               [vw_daily_summary]
SELECT username, record_date, net_calories,
       CASE WHEN net_calories > 500  THEN 'Big surplus'
            WHEN net_calories > 0    THEN 'Surplus'
            WHEN net_calories > -500 THEN 'Deficit'
            ELSE 'Big deficit' END AS verdict
FROM vw_daily_summary
WHERE record_date = CURDATE();

-- I2. One list of the whole catalogue (UNION ALL)          [Food, Burn]
SELECT 'Food' AS kind, name AS item, food_type AS type, calories_per_serving AS kcal, 'per serving' AS unit FROM Food
UNION ALL
SELECT 'Exercise', burn_name, burn_type, calories_per_min, 'per minute' FROM Burn
ORDER BY kind, kcal DESC;


-- ---------------------------------------------------------------------
-- J. Row counts (a quick health check)
-- ---------------------------------------------------------------------

-- J1. Rows in every table                                  [all 7 tables]
SELECT 'Users' AS tbl, COUNT(*) AS row_count FROM Users
UNION ALL SELECT 'Food', COUNT(*) FROM Food
UNION ALL SELECT 'Burn', COUNT(*) FROM Burn
UNION ALL SELECT 'Daily_Record', COUNT(*) FROM Daily_Record
UNION ALL SELECT 'Daily_Food', COUNT(*) FROM Daily_Food
UNION ALL SELECT 'Daily_Burn', COUNT(*) FROM Daily_Burn
UNION ALL SELECT 'Weekly_Record', COUNT(*) FROM Weekly_Record;


-- ---------------------------------------------------------------------
-- K. INSERT, UPDATE, DELETE (inside a transaction, undone at the end)
--    Run K1 to K8 in order. After any step, the website shows the change
--    only if you COMMIT; ROLLBACK puts everything back.
-- ---------------------------------------------------------------------

-- K1. Start a transaction
START TRANSACTION;

-- K2. INSERT a new food                                    [Food]
INSERT INTO Food (name, food_type, calories_per_serving) VALUES ('Sabudana Khichdi', 'Breakfast', 320);
SELECT * FROM Food WHERE name = 'Sabudana Khichdi';

-- K3. Log it for haadi_runs today (INSERT ... SELECT)      [Daily_Food, Daily_Record, Users, Food]
INSERT INTO Daily_Food (daily_id, food_id, servings)
SELECT dr.daily_id, f.food_id, 1.5
FROM Daily_Record dr
JOIN Users u ON u.user_id = dr.user_id
JOIN Food f  ON f.name = 'Sabudana Khichdi'
WHERE u.username = 'haadi_runs' AND dr.record_date = CURDATE();
SELECT * FROM vw_food_log WHERE username = 'haadi_runs' AND record_date = CURDATE();

-- K4. UPDATE: double its servings                          [Daily_Food, Food]
UPDATE Daily_Food df
JOIN Food f ON f.food_id = df.food_id
SET df.servings = df.servings * 2
WHERE f.name = 'Sabudana Khichdi';

-- K5. UPDATE: raise every Dessert's calories by 10%        [Food]
UPDATE Food SET calories_per_serving = ROUND(calories_per_serving * 1.1) WHERE food_type = 'Dessert';
SELECT name, calories_per_serving FROM Food WHERE food_type = 'Dessert';

-- K6. DELETE a user: their days, meals, workouts and check-ins go too (ON DELETE CASCADE)
--     [Users -> Daily_Record -> Daily_Food / Daily_Burn, Weekly_Record]
SELECT (SELECT COUNT(*) FROM Daily_Record WHERE user_id = 3) AS days_before,
       (SELECT COUNT(*) FROM Weekly_Record WHERE user_id = 3) AS checkins_before;
DELETE FROM Users WHERE username = 'nishad_cycles';
SELECT (SELECT COUNT(*) FROM Daily_Record WHERE user_id = 3) AS days_after,
       (SELECT COUNT(*) FROM Weekly_Record WHERE user_id = 3) AS checkins_after;

-- K7. Undo all of K2 to K6
ROLLBACK;

-- K8. Check that everything is back                        [Food, Users]
SELECT (SELECT COUNT(*) FROM Food WHERE name = 'Sabudana Khichdi') AS new_food_left,
       (SELECT COUNT(*) FROM Users WHERE username = 'nishad_cycles') AS nishad_still_here;


-- ---------------------------------------------------------------------
-- L. The database refusing bad data (each statement should FAIL)
-- ---------------------------------------------------------------------

-- L1. UNIQUE: a username that is already taken             [Users, uq_users_username]
INSERT INTO Users (username, password) VALUES ('haadi_runs', 'x');

-- L2. CHECK: zero servings                                 [Daily_Food, chk_servings_positive]
UPDATE Daily_Food SET servings = 0 WHERE daily_id = 1 LIMIT 1;

-- L3. CHECK: negative calories                             [Food, chk_food_calories]
INSERT INTO Food (name, food_type, calories_per_serving) VALUES ('Negative Cake', 'Dessert', -50);

-- L4. FOREIGN KEY: a meal for a day that doesn't exist     [Daily_Food, fk_dfood_daily]
INSERT INTO Daily_Food (daily_id, food_id, servings) VALUES (99999, 1, 1);

-- L5. ON DELETE RESTRICT: a food that is used in logs      [Food, Daily_Food, fk_dfood_food]
DELETE FROM Food WHERE name = 'Poha';

-- L6. TRIGGER: a day in the future                         [Daily_Record, trg_daily_date_ins]
INSERT INTO Daily_Record (user_id, record_date) VALUES (1, CURDATE() + INTERVAL 1 DAY);

-- L7. TRIGGER: a date of birth in the future               [Users, trg_users_dob_upd]
UPDATE Users SET dob = CURDATE() + INTERVAL 1 YEAR WHERE username = 'haadi_runs';

-- L8. ENUM: a food type that isn't allowed (strict mode)   [Food]
INSERT INTO Food (name, food_type, calories_per_serving) VALUES ('Mystery Dish', 'Soup', 100);
