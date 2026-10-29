-- =====================================================================
--  STRIDE v1  -  judge_queries.sql
--  Extra queries for "show us a query that ...", beyond the ones in
--  concepts.sql (one per DBMS concept) and 03_demo_queries.sql.
--  Run one at a time in Workbench (cursor on it, Ctrl+Enter).
-- =====================================================================
USE fitness_tracker_v1;

-- 1. Leaderboard: RANK() by calories burnt in the last 7 days          [vw_daily_summary]
SELECT username, ROUND(SUM(calories_out)) AS kcal_burnt,
       RANK() OVER (ORDER BY SUM(calories_out) DESC) AS place
FROM vw_daily_summary
WHERE record_date > CURDATE() - INTERVAL 7 DAY
GROUP BY user_id, username;

-- 2. Running total of calories eaten (window SUM)                     [vw_daily_summary]
SELECT record_date, calories_in, SUM(calories_in) OVER (ORDER BY record_date) AS running_total
FROM vw_daily_summary
WHERE username = 'haadi_runs';

-- 3. CASE: label each day a surplus or a deficit                      [vw_daily_summary]
SELECT username, record_date, net_calories,
       CASE WHEN net_calories > 500  THEN 'Big surplus'
            WHEN net_calories > 0    THEN 'Surplus'
            WHEN net_calories > -500 THEN 'Deficit'
            ELSE 'Big deficit' END AS verdict
FROM vw_daily_summary
WHERE record_date > CURDATE() - INTERVAL 7 DAY;

-- 4. UNION ALL: rows in every table                                   [all 7 tables]
SELECT 'Users' AS tbl, COUNT(*) AS row_count FROM Users
UNION ALL SELECT 'Food', COUNT(*) FROM Food
UNION ALL SELECT 'Burn', COUNT(*) FROM Burn
UNION ALL SELECT 'Daily_Record', COUNT(*) FROM Daily_Record
UNION ALL SELECT 'Daily_Food', COUNT(*) FROM Daily_Food
UNION ALL SELECT 'Daily_Burn', COUNT(*) FROM Daily_Burn
UNION ALL SELECT 'Weekly_Record', COUNT(*) FROM Weekly_Record;

-- 5. Refusals not shown elsewhere (each is meant to FAIL)
INSERT INTO Daily_Food (daily_id, food_id, servings) VALUES (99999, 1, 1);                        -- FOREIGN KEY
INSERT INTO Food (name, food_type, calories_per_serving) VALUES ('Mystery Dish', 'Soup', 100);   -- ENUM (strict mode)
UPDATE Users SET dob = CURDATE() + INTERVAL 1 YEAR WHERE username = 'haadi_runs';                 -- trigger on UPDATE
