-- =====================================================================
--  STRIDE v1  -  concepts.sql
--  One example per DBMS concept, on the Stride data. The website's SQL
--  tab lists them under "Example"; they also run in Workbench as they are.
--  Changes are rolled back or made on Scratch_ objects that are dropped.
--
--  Format for the SQL tab: "-- # Group", "-- ## Example", comment lines
--  as notes ("-- on error: continue" runs past failures), then the SQL.
-- =====================================================================


-- # DDL

-- ## CREATE, ALTER, RENAME, TRUNCATE, DROP
DROP TABLE IF EXISTS Scratch_Goal, Scratch_Target;
CREATE TABLE Scratch_Goal (
    goal_id      INT  NOT NULL AUTO_INCREMENT PRIMARY KEY,
    user_id      INT  NOT NULL,
    target_kcal  INT  NOT NULL,
    CONSTRAINT fk_goal_user FOREIGN KEY (user_id) REFERENCES Users (user_id) ON DELETE CASCADE
);
ALTER TABLE Scratch_Goal ADD COLUMN note VARCHAR(100) NULL;
ALTER TABLE Scratch_Goal ADD CONSTRAINT chk_goal_kcal CHECK (target_kcal BETWEEN 800 AND 6000);
RENAME TABLE Scratch_Goal TO Scratch_Target;
INSERT INTO Scratch_Target (user_id, target_kcal) SELECT user_id, 2200 FROM Users;
TRUNCATE TABLE Scratch_Target;
DESCRIBE Scratch_Target;
DROP TABLE Scratch_Target;


-- # DML

-- ## INSERT, UPDATE, DELETE
-- Rolled back at the end.
START TRANSACTION;
INSERT INTO Food (name, food_type, calories_per_serving) VALUES ('Sabudana Khichdi', 'Breakfast', 320);
UPDATE Food SET calories_per_serving = 350 WHERE name = 'Sabudana Khichdi';
SELECT * FROM Food WHERE name = 'Sabudana Khichdi';
DELETE FROM Food WHERE name = 'Sabudana Khichdi';
ROLLBACK;


-- # Keys and CASCADE

-- ## Primary and foreign keys
SELECT TABLE_NAME, CONSTRAINT_NAME, GROUP_CONCAT(COLUMN_NAME) AS key_columns, REFERENCED_TABLE_NAME
FROM information_schema.KEY_COLUMN_USAGE
WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME NOT LIKE 'django%' AND TABLE_NAME NOT LIKE 'auth%'
GROUP BY TABLE_NAME, CONSTRAINT_NAME, REFERENCED_TABLE_NAME
ORDER BY TABLE_NAME, REFERENCED_TABLE_NAME IS NOT NULL;

-- ## ON DELETE CASCADE
-- Deleting a user deletes their days, meals, workouts and check-ins. Rolled back.
START TRANSACTION;
SELECT COUNT(*) AS days FROM Daily_Record WHERE user_id = 3;
DELETE FROM Users WHERE username = 'nishad_cycles';
SELECT COUNT(*) AS days FROM Daily_Record WHERE user_id = 3;
ROLLBACK;

-- ## ON DELETE RESTRICT
-- Poha is in people's logs, so fk_dfood_food refuses the delete. Meant to fail.
DELETE FROM Food WHERE name = 'Poha';


-- # Operators

-- ## Comparison, logical, BETWEEN, IN, LIKE, IS NULL, arithmetic
SELECT name, food_type, calories_per_serving, calories_per_serving * 2 AS two_servings
FROM Food
WHERE (food_type IN ('Protein', 'Dairy') OR name LIKE '%Masala%')
  AND calories_per_serving BETWEEN 100 AND 400
  AND NOT food_type = 'Dessert';

SELECT username FROM Users WHERE dob IS NULL;


-- # Dates

-- ## DATEDIFF and other date functions
SELECT u.username,
       MAX(dr.record_date)                      AS last_day,
       DATEDIFF(CURDATE(), MAX(dr.record_date)) AS days_since_last_log,
       DATE_ADD(MAX(dr.record_date), INTERVAL 7 DAY) AS week_later,
       DAYNAME(MAX(dr.record_date))             AS weekday,
       TIMESTAMPDIFF(YEAR, u.dob, CURDATE())    AS age
FROM Users u
JOIN Daily_Record dr ON dr.user_id = u.user_id
GROUP BY u.user_id, u.username, u.dob;


-- # Aggregates

-- ## COUNT, SUM, AVG, MIN, MAX with GROUP BY and HAVING
SELECT food_type, COUNT(*) AS foods, SUM(calories_per_serving) AS total,
       ROUND(AVG(calories_per_serving)) AS average,
       MIN(calories_per_serving) AS lowest, MAX(calories_per_serving) AS highest
FROM Food
GROUP BY food_type
HAVING COUNT(*) >= 3
ORDER BY average DESC;


-- # Nested queries

-- ## Scalar, IN, NOT EXISTS and correlated subqueries
SELECT name, calories_per_serving FROM Food
WHERE calories_per_serving > (SELECT AVG(calories_per_serving) FROM Food);

SELECT username FROM Users
WHERE user_id IN (SELECT user_id FROM vw_burn_log WHERE burn_name = 'HIIT Circuit');

SELECT name FROM Food f
WHERE NOT EXISTS (SELECT 1 FROM Daily_Food df WHERE df.food_id = f.food_id);

SELECT username, food_name, calories FROM vw_food_log f
WHERE calories = (SELECT MAX(calories) FROM vw_food_log WHERE user_id = f.user_id);


-- # Joins

-- ## INNER JOIN
-- Only rows that match on both sides.
SELECT u.username, dr.record_date, f.name, df.servings
FROM Users u
INNER JOIN Daily_Record dr ON dr.user_id  = u.user_id
INNER JOIN Daily_Food   df ON df.daily_id = dr.daily_id
INNER JOIN Food         f  ON f.food_id   = df.food_id
WHERE dr.record_date = CURDATE();

-- ## LEFT JOIN
-- Every food, with NULL on the right for foods nobody logged.
SELECT f.name, COUNT(df.daily_id) AS times_logged
FROM Food f
LEFT JOIN Daily_Food df ON df.food_id = f.food_id
GROUP BY f.food_id, f.name
ORDER BY times_logged;

-- ## RIGHT JOIN
-- Every exercise, including ones never done.
SELECT b.burn_name, COUNT(db.daily_id) AS times_done
FROM Daily_Burn db
RIGHT JOIN Burn b ON b.burn_id = db.burn_id
GROUP BY b.burn_id, b.burn_name
ORDER BY times_done;

-- ## FULL OUTER JOIN
-- MySQL has no FULL JOIN: LEFT JOIN UNION RIGHT JOIN. haadi_runs' exercises
-- last week vs. this week, including ones done in only one of them.
WITH this_week AS (SELECT burn_name, SUM(duration_min) AS minutes FROM vw_burn_log
                   WHERE username = 'haadi_runs' AND record_date > CURDATE() - INTERVAL 7 DAY
                   GROUP BY burn_name),
     last_week AS (SELECT burn_name, SUM(duration_min) AS minutes FROM vw_burn_log
                   WHERE username = 'haadi_runs'
                     AND record_date BETWEEN CURDATE() - INTERVAL 13 DAY AND CURDATE() - INTERVAL 7 DAY
                   GROUP BY burn_name)
SELECT l.burn_name, t.burn_name, l.minutes AS last_week, t.minutes AS this_week
FROM last_week l LEFT JOIN this_week t ON t.burn_name = l.burn_name
UNION
SELECT l.burn_name, t.burn_name, l.minutes, t.minutes
FROM last_week l RIGHT JOIN this_week t ON t.burn_name = l.burn_name;

-- ## CROSS JOIN
-- Every athlete paired with every exercise type.
SELECT u.username, t.burn_type
FROM Users u
CROSS JOIN (SELECT DISTINCT burn_type FROM Burn) t
WHERE u.role = 'athlete'
ORDER BY u.username, t.burn_type;


-- # Views

-- ## CREATE, query and DROP a view
CREATE OR REPLACE VIEW vw_scratch_streak AS
SELECT username, COUNT(*) AS days_logged, DATEDIFF(CURDATE(), MAX(record_date)) AS days_since
FROM vw_daily_summary
GROUP BY username;
SELECT * FROM vw_scratch_streak;
DROP VIEW vw_scratch_streak;


-- # Triggers and SIGNAL

-- ## A trigger raising SIGNAL
-- First the schema's own trigger refuses a future date; then a new trigger on a
-- scratch table refuses a weight over 300 kg. Both refusals are meant to fail.
-- (MySQL 8 lets only root create triggers by default; MariaDB allows it.)
-- on error: continue
INSERT INTO Daily_Record (user_id, record_date) VALUES (1, CURDATE() + INTERVAL 1 DAY);

DROP TABLE IF EXISTS Scratch_Weigh_In;
CREATE TABLE Scratch_Weigh_In (id INT AUTO_INCREMENT PRIMARY KEY, weight_kg DECIMAL(5,2) NOT NULL);

DELIMITER $$
CREATE TRIGGER trg_scratch_weight BEFORE INSERT ON Scratch_Weigh_In
FOR EACH ROW
BEGIN
    IF NEW.weight_kg > 300 THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Weight over 300 kg: check the number';
    END IF;
END$$
DELIMITER ;

INSERT INTO Scratch_Weigh_In (weight_kg) VALUES (720);
DROP TABLE Scratch_Weigh_In;


-- # Database users and GRANT

-- ## The site's MySQL account and its GRANT
-- db/00_account.sql creates stride_app (CREATE USER) and GRANTs it every privilege on
-- fitness_tracker_v1. The website, the admin panel and this tab all connect as it;
-- who may do what on the site is decided by Users.role, in Django.
SELECT CURRENT_USER();
SHOW GRANTS;


-- # Transactions

-- ## SAVEPOINT, ROLLBACK TO and COMMIT
-- The jalebi is undone by ROLLBACK TO; the ladoo is committed, then deleted again.
START TRANSACTION;
INSERT INTO Food (name, food_type, calories_per_serving) VALUES ('Savepoint Ladoo', 'Dessert', 180);
SAVEPOINT after_ladoo;
INSERT INTO Food (name, food_type, calories_per_serving) VALUES ('Savepoint Jalebi', 'Dessert', 300);
ROLLBACK TO SAVEPOINT after_ladoo;
COMMIT;
SELECT name FROM Food WHERE name LIKE 'Savepoint%';
DELETE FROM Food WHERE name = 'Savepoint Ladoo';
