-- =====================================================================
--  FITNESS TRACKER  -  03_demo_queries.sql
--  Queries to run one by one in MySQL Workbench during the demo.
--  Put the cursor on a statement and press Ctrl+Enter to run just that one.
--  Statements that change data are wrapped in a transaction and rolled
--  back, so the sample data stays the same however many times you run them.
-- =====================================================================
USE fitness_tracker;


-- ---------------------------------------------------------------------
-- A. Looking at the structure
-- ---------------------------------------------------------------------
SHOW TABLES;

DESCRIBE Users;
DESCRIBE Daily_Food;

SHOW CREATE TABLE Daily_Food;

-- every primary key, foreign key, unique and check constraint
SELECT TABLE_NAME, CONSTRAINT_NAME, CONSTRAINT_TYPE
FROM information_schema.TABLE_CONSTRAINTS
WHERE TABLE_SCHEMA = 'fitness_tracker'
ORDER BY TABLE_NAME, CONSTRAINT_TYPE;

-- foreign keys with their ON DELETE rule (RESTRICT vs CASCADE)
SELECT TABLE_NAME, CONSTRAINT_NAME, REFERENCED_TABLE_NAME, DELETE_RULE, UPDATE_RULE
FROM information_schema.REFERENTIAL_CONSTRAINTS
WHERE CONSTRAINT_SCHEMA = 'fitness_tracker';

SHOW TRIGGERS;


-- ---------------------------------------------------------------------
-- B. Catalogues and users
-- ---------------------------------------------------------------------
SELECT * FROM Users;
SELECT * FROM Food ORDER BY food_type, name;
SELECT * FROM Burn ORDER BY burn_type, burn_name;

-- age is derived, not stored (3NF)
SELECT user_id, username, dob, TIMESTAMPDIFF(YEAR, dob, CURDATE()) AS age
FROM Users;


-- ---------------------------------------------------------------------
-- C. One day for one user
-- ---------------------------------------------------------------------
-- what haadi_runs ate today
SELECT f.name, f.food_type, df.servings, f.calories_per_serving,
       df.servings * f.calories_per_serving AS calories
FROM Daily_Record dr
JOIN Daily_Food df ON df.daily_id = dr.daily_id
JOIN Food f        ON f.food_id   = df.food_id
WHERE dr.user_id = 1 AND dr.record_date = CURDATE();

-- what haadi_runs did today
SELECT b.burn_name, db.duration_min, b.calories_per_min,
       db.duration_min * b.calories_per_min AS calories
FROM Daily_Record dr
JOIN Daily_Burn db ON db.daily_id = dr.daily_id
JOIN Burn b        ON b.burn_id   = db.burn_id
WHERE dr.user_id = 1 AND dr.record_date = CURDATE();


-- ---------------------------------------------------------------------
-- D. Calories in, calories out, net  (per day)
-- ---------------------------------------------------------------------
SELECT dr.record_date,
       COALESCE(fi.calories_in, 0)  AS calories_in,
       COALESCE(bo.calories_out, 0) AS calories_out,
       COALESCE(fi.calories_in, 0) - COALESCE(bo.calories_out, 0) AS net_calories
FROM Daily_Record dr
LEFT JOIN (SELECT df.daily_id, SUM(df.servings * f.calories_per_serving) AS calories_in
           FROM Daily_Food df JOIN Food f ON f.food_id = df.food_id
           GROUP BY df.daily_id) fi ON fi.daily_id = dr.daily_id
LEFT JOIN (SELECT db.daily_id, SUM(db.duration_min * b.calories_per_min) AS calories_out
           FROM Daily_Burn db JOIN Burn b ON b.burn_id = db.burn_id
           GROUP BY db.daily_id) bo ON bo.daily_id = dr.daily_id
WHERE dr.user_id = 1
ORDER BY dr.record_date DESC;

-- the same thing, saved as a view
SELECT * FROM vw_daily_summary WHERE username = 'haadi_runs' ORDER BY record_date DESC;


-- ---------------------------------------------------------------------
-- E. Weekly averages
-- ---------------------------------------------------------------------
SELECT * FROM vw_weekly_average ORDER BY week_start DESC, username;

-- best week (lowest average net calories) for each user
SELECT username, week_start, avg_net_calories
FROM vw_weekly_average w
WHERE avg_net_calories = (SELECT MIN(avg_net_calories)
                          FROM vw_weekly_average
                          WHERE user_id = w.user_id);


-- ---------------------------------------------------------------------
-- F. Body measurements: BMI and change since last week
-- ---------------------------------------------------------------------
SELECT u.username, wr.week_start_date, wr.height_cm, wr.weight_kg,
       ROUND(wr.weight_kg / POW(wr.height_cm / 100, 2), 1) AS bmi,
       wr.weight_kg - LAG(wr.weight_kg) OVER (PARTITION BY wr.user_id ORDER BY wr.week_start_date) AS change_kg
FROM Weekly_Record wr
JOIN Users u ON u.user_id = wr.user_id
ORDER BY u.username, wr.week_start_date;

-- total weight change from first to latest check-in
SELECT u.username,
       MIN(wr.week_start_date) AS first_week,
       MAX(wr.week_start_date) AS latest_week,
       (SELECT weight_kg FROM Weekly_Record WHERE user_id = u.user_id ORDER BY week_start_date DESC LIMIT 1)
     - (SELECT weight_kg FROM Weekly_Record WHERE user_id = u.user_id ORDER BY week_start_date ASC  LIMIT 1) AS total_change_kg
FROM Users u
JOIN Weekly_Record wr ON wr.user_id = u.user_id
GROUP BY u.user_id, u.username;


-- ---------------------------------------------------------------------
-- G. Other reports
-- ---------------------------------------------------------------------
-- leaderboard: calories burnt in the last 7 days
SELECT u.username,
       COALESCE(SUM(db.duration_min * b.calories_per_min), 0) AS calories_burnt,
       RANK() OVER (ORDER BY COALESCE(SUM(db.duration_min * b.calories_per_min), 0) DESC) AS position
FROM Users u
LEFT JOIN Daily_Record dr ON dr.user_id = u.user_id AND dr.record_date > CURDATE() - INTERVAL 7 DAY
LEFT JOIN Daily_Burn db   ON db.daily_id = dr.daily_id
LEFT JOIN Burn b          ON b.burn_id = db.burn_id
GROUP BY u.user_id, u.username;

-- most popular foods across all users
SELECT f.name, COUNT(*) AS times_logged, SUM(df.servings) AS servings
FROM Daily_Food df JOIN Food f ON f.food_id = df.food_id
GROUP BY f.food_id, f.name
ORDER BY times_logged DESC
LIMIT 5;

-- calories burnt by exercise type
SELECT b.burn_type, SUM(db.duration_min) AS minutes,
       SUM(db.duration_min * b.calories_per_min) AS calories
FROM Daily_Burn db JOIN Burn b ON b.burn_id = db.burn_id
GROUP BY b.burn_type
ORDER BY calories DESC;

-- foods nobody has eaten yet (safe to delete)
SELECT f.food_id, f.name
FROM Food f
WHERE NOT EXISTS (SELECT 1 FROM Daily_Food df WHERE df.food_id = f.food_id);

-- days with a surplus above 1500 kcal
SELECT username, record_date, net_calories
FROM vw_daily_summary
WHERE net_calories > 1500
ORDER BY net_calories DESC;


-- ---------------------------------------------------------------------
-- H. Business rules in action  (each one is expected to fail or is rolled back)
-- ---------------------------------------------------------------------

-- 1. usernames are unique            -> Error 1062 Duplicate entry
INSERT INTO Users (username, user_contact, dob) VALUES ('haadi_runs', 'x@y.com', '2000-01-01');

-- 2. no future dates (trigger)       -> Error 1644 Cannot log a day in the future
INSERT INTO Daily_Record (user_id, record_date) VALUES (1, CURDATE() + INTERVAL 1 DAY);
INSERT INTO Users (username, dob) VALUES ('time_traveller', CURDATE() + INTERVAL 1 YEAR);

-- 3. one record per user per day     -> Error 1062 Duplicate entry
INSERT INTO Daily_Record (user_id, record_date) VALUES (1, CURDATE());

-- 4. quantities must be positive     -> Error 3819 Check constraint is violated
INSERT INTO Daily_Food (daily_id, food_id, servings) VALUES (1, 3, -2);
INSERT INTO Daily_Burn (daily_id, burn_id, duration_min) VALUES (1, 3, 0);
INSERT INTO Food (name, food_type, calories_per_serving) VALUES ('Negative Cake', 'Dessert', -50);

-- 5. same food twice on a day adds servings instead of a new row
START TRANSACTION;
SELECT * FROM Daily_Food WHERE daily_id = 1;
SET @food = (SELECT food_id FROM Daily_Food WHERE daily_id = 1 LIMIT 1);
INSERT INTO Daily_Food (daily_id, food_id, servings) VALUES (1, @food, 1)
ON DUPLICATE KEY UPDATE servings = servings + VALUES(servings);
SELECT * FROM Daily_Food WHERE daily_id = 1;
ROLLBACK;

-- 6. a food used in a log can't be deleted (ON DELETE RESTRICT) -> Error 1451
DELETE FROM Food WHERE food_id = (SELECT food_id FROM (SELECT food_id FROM Daily_Food LIMIT 1) x);

-- 7. deleting a user deletes their days, foods, workouts and check-ins (ON DELETE CASCADE)
START TRANSACTION;
SELECT 'before' AS moment,
       (SELECT COUNT(*) FROM Daily_Record  WHERE user_id = 3) AS days,
       (SELECT COUNT(*) FROM Weekly_Record WHERE user_id = 3) AS check_ins,
       (SELECT COUNT(*) FROM Daily_Food df JOIN Daily_Record dr ON dr.daily_id = df.daily_id WHERE dr.user_id = 3) AS foods;
DELETE FROM Users WHERE user_id = 3;
SELECT 'after' AS moment,
       (SELECT COUNT(*) FROM Daily_Record  WHERE user_id = 3) AS days,
       (SELECT COUNT(*) FROM Weekly_Record WHERE user_id = 3) AS check_ins,
       (SELECT COUNT(*) FROM Daily_Food df JOIN Daily_Record dr ON dr.daily_id = df.daily_id WHERE dr.user_id = 3) AS foods;
ROLLBACK;
