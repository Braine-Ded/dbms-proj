-- =====================================================================
--  STRIDE v1  -  03_demo_queries.sql
--  Run one statement at a time in Workbench (cursor on it, Ctrl+Enter).
--  Changes are rolled back; the statements in C are meant to fail.
-- =====================================================================
USE fitness_tracker_v1;

-- A. Structure ---------------------------------------------------------
SHOW TABLES;
SHOW CREATE TABLE Daily_Food;   -- composite PK, CHECK, CASCADE and RESTRICT foreign keys
SHOW TRIGGERS;                  -- no dates in the future

-- B. Reports -----------------------------------------------------------
SELECT * FROM vw_daily_summary WHERE username = 'haadi_runs' ORDER BY record_date DESC;

SELECT u.username, w.week_start_date, w.weight_kg,
       ROUND(w.weight_kg / POW(w.height_cm / 100, 2), 1) AS bmi,
       w.weight_kg - LAG(w.weight_kg) OVER (PARTITION BY w.user_id ORDER BY w.week_start_date) AS change_kg
FROM Weekly_Record w
JOIN Users u ON u.user_id = w.user_id
ORDER BY u.username, w.week_start_date;

-- C. The database refusing bad data --------------------------------------
INSERT INTO Users (username, password) VALUES ('haadi_runs', 'x');                       -- 1062 UNIQUE
INSERT INTO Daily_Record (user_id, record_date) VALUES (1, CURDATE() + INTERVAL 1 DAY);  -- 1644 trigger
INSERT INTO Daily_Food (daily_id, food_id, servings) VALUES (1, 3, -2);                  -- CHECK (3819 MySQL, 4025 MariaDB)
DELETE FROM Food WHERE name = 'Poha';                                                    -- 1451 RESTRICT

-- D. ON DELETE CASCADE, rolled back ------------------------------------------
START TRANSACTION;
DELETE FROM Users WHERE username = 'nishad_cycles';
SELECT COUNT(*) AS days_left FROM Daily_Record WHERE user_id = 3;   -- 0
ROLLBACK;

-- E. Accounts: Users is the login table (PBKDF2 hash; role decides access on the site) --
SELECT user_id, username, role, is_staff, is_active, last_login,
       SUBSTRING_INDEX(password, '$', 2) AS algorithm_and_iterations
FROM Users;
