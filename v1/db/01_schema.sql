-- =====================================================================
--  STRIDE v1 (FITNESS TRACKER)  -  DBMS mini-project
--  01_schema.sql : database, tables, constraints, triggers, views
--  Run this first in MySQL Workbench (File > Open SQL Script > Execute),
--  connected as stride_app (see db/00_account.sql), then run
--  `python manage.py migrate` and finally 02_seed.sql.
--
--  Same 7 tables and relations as v0. The only change: Users is now also
--  the login table, so it gained password / is_staff / is_active /
--  date_joined / last_login. Django's own tables (sessions, admin log,
--  permissions) are added next to these by `manage.py migrate`.
-- =====================================================================

DROP DATABASE IF EXISTS fitness_tracker_v1;
CREATE DATABASE fitness_tracker_v1 CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE fitness_tracker_v1;

-- ---------------------------------------------------------------------
-- 1. Users : people tracking their fitness, and their login
-- ---------------------------------------------------------------------
CREATE TABLE Users (
    user_id       INT           NOT NULL AUTO_INCREMENT,
    username      VARCHAR(50)   NOT NULL,
    user_contact  VARCHAR(100),
    dob           DATE,
    password      VARCHAR(128)  NOT NULL,                 -- PBKDF2 hash, never the password itself
    is_staff      TINYINT(1)    NOT NULL DEFAULT 0,       -- may use the admin panel
    is_active     TINYINT(1)    NOT NULL DEFAULT 1,       -- 0 = account disabled, can't sign in
    date_joined   DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_login    DATETIME      NULL,
    PRIMARY KEY (user_id),
    CONSTRAINT uq_users_username UNIQUE (username)
);

-- ---------------------------------------------------------------------
-- 2. Food : catalogue of available foods
-- ---------------------------------------------------------------------
CREATE TABLE Food (
    food_id               INT           NOT NULL AUTO_INCREMENT,
    name                  VARCHAR(100)  NOT NULL,
    food_type             ENUM('Breakfast','Grain','Protein','Dairy','Fruit',
                               'Vegetable','Snack','Beverage','Dessert','Fast Food')
                          NOT NULL,
    calories_per_serving  INT           NOT NULL,
    PRIMARY KEY (food_id),
    CONSTRAINT uq_food_name UNIQUE (name),
    CONSTRAINT chk_food_calories CHECK (calories_per_serving >= 0)
);

-- ---------------------------------------------------------------------
-- 3. Burn : catalogue of physical exercises
-- ---------------------------------------------------------------------
CREATE TABLE Burn (
    burn_id           INT           NOT NULL AUTO_INCREMENT,
    burn_name         VARCHAR(100)  NOT NULL,
    burn_type         ENUM('Cardio','Strength','Flexibility','Sports','Outdoor')
                      NOT NULL,
    calories_per_min  DECIMAL(6,2)  NOT NULL,
    PRIMARY KEY (burn_id),
    CONSTRAINT uq_burn_name UNIQUE (burn_name),
    CONSTRAINT chk_burn_calories CHECK (calories_per_min >= 0)
);

-- ---------------------------------------------------------------------
-- 4. Daily_Record : one tracked day per user (at most one per date)
-- ---------------------------------------------------------------------
CREATE TABLE Daily_Record (
    daily_id     INT   NOT NULL AUTO_INCREMENT,
    user_id      INT   NOT NULL,
    record_date  DATE  NOT NULL,
    PRIMARY KEY (daily_id),
    CONSTRAINT uq_daily_user_date UNIQUE (user_id, record_date),
    CONSTRAINT fk_daily_user FOREIGN KEY (user_id)
        REFERENCES Users (user_id)
        ON DELETE CASCADE ON UPDATE CASCADE
);

-- ---------------------------------------------------------------------
-- 5. Daily_Food : foods eaten on a given day   (associative entity)
-- ---------------------------------------------------------------------
CREATE TABLE Daily_Food (
    daily_id  INT           NOT NULL,
    food_id   INT           NOT NULL,
    servings  DECIMAL(5,2)  NOT NULL,
    PRIMARY KEY (daily_id, food_id),
    CONSTRAINT chk_servings_positive CHECK (servings > 0),
    CONSTRAINT fk_dfood_daily FOREIGN KEY (daily_id)
        REFERENCES Daily_Record (daily_id)
        ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT fk_dfood_food FOREIGN KEY (food_id)
        REFERENCES Food (food_id)
        ON DELETE RESTRICT ON UPDATE CASCADE
);

-- ---------------------------------------------------------------------
-- 6. Daily_Burn : exercises done on a given day   (associative entity)
-- ---------------------------------------------------------------------
CREATE TABLE Daily_Burn (
    daily_id      INT  NOT NULL,
    burn_id       INT  NOT NULL,
    duration_min  INT  NOT NULL,
    PRIMARY KEY (daily_id, burn_id),
    CONSTRAINT chk_duration_positive CHECK (duration_min > 0),
    CONSTRAINT fk_dburn_daily FOREIGN KEY (daily_id)
        REFERENCES Daily_Record (daily_id)
        ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT fk_dburn_burn FOREIGN KEY (burn_id)
        REFERENCES Burn (burn_id)
        ON DELETE RESTRICT ON UPDATE CASCADE
);

-- ---------------------------------------------------------------------
-- 7. Weekly_Record : weekly height / weight checkpoints
-- ---------------------------------------------------------------------
CREATE TABLE Weekly_Record (
    week_id          INT           NOT NULL AUTO_INCREMENT,
    user_id          INT           NOT NULL,
    week_start_date  DATE          NOT NULL,
    height_cm        DECIMAL(5,2)  NOT NULL,
    weight_kg        DECIMAL(5,2)  NOT NULL,
    PRIMARY KEY (week_id),
    CONSTRAINT uq_week_user_date UNIQUE (user_id, week_start_date),
    CONSTRAINT chk_height CHECK (height_cm > 0),
    CONSTRAINT chk_weight CHECK (weight_kg > 0),
    CONSTRAINT fk_week_user FOREIGN KEY (user_id)
        REFERENCES Users (user_id)
        ON DELETE CASCADE ON UPDATE CASCADE
);

-- ---------------------------------------------------------------------
-- Business rule: future dates are not allowed.
-- A CHECK constraint cannot call CURDATE() in MySQL, so triggers do it.
-- ---------------------------------------------------------------------
DELIMITER $$

CREATE TRIGGER trg_users_dob_ins BEFORE INSERT ON Users
FOR EACH ROW
BEGIN
    IF NEW.dob > CURDATE() THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Date of birth cannot be in the future';
    END IF;
END$$

CREATE TRIGGER trg_users_dob_upd BEFORE UPDATE ON Users
FOR EACH ROW
BEGIN
    IF NEW.dob > CURDATE() THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Date of birth cannot be in the future';
    END IF;
END$$

CREATE TRIGGER trg_daily_date_ins BEFORE INSERT ON Daily_Record
FOR EACH ROW
BEGIN
    IF NEW.record_date > CURDATE() THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Cannot log a day in the future';
    END IF;
END$$

CREATE TRIGGER trg_daily_date_upd BEFORE UPDATE ON Daily_Record
FOR EACH ROW
BEGIN
    IF NEW.record_date > CURDATE() THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Cannot log a day in the future';
    END IF;
END$$

CREATE TRIGGER trg_week_date_ins BEFORE INSERT ON Weekly_Record
FOR EACH ROW
BEGIN
    IF NEW.week_start_date > CURDATE() THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Week start date cannot be in the future';
    END IF;
END$$

CREATE TRIGGER trg_week_date_upd BEFORE UPDATE ON Weekly_Record
FOR EACH ROW
BEGIN
    IF NEW.week_start_date > CURDATE() THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Week start date cannot be in the future';
    END IF;
END$$

DELIMITER ;

-- ---------------------------------------------------------------------
-- Views: derived values are computed, never stored (3NF)
-- ---------------------------------------------------------------------

-- Calories in / out / net for every tracked day
CREATE VIEW vw_daily_summary AS
SELECT  dr.daily_id,
        u.user_id,
        u.username,
        dr.record_date,
        COALESCE(fi.calories_in, 0)                               AS calories_in,
        COALESCE(bo.calories_out, 0)                              AS calories_out,
        COALESCE(fi.calories_in, 0) - COALESCE(bo.calories_out, 0) AS net_calories
FROM Daily_Record dr
JOIN Users u ON u.user_id = dr.user_id
LEFT JOIN (SELECT df.daily_id, SUM(df.servings * f.calories_per_serving) AS calories_in
           FROM Daily_Food df JOIN Food f ON f.food_id = df.food_id
           GROUP BY df.daily_id) fi ON fi.daily_id = dr.daily_id
LEFT JOIN (SELECT db.daily_id, SUM(db.duration_min * b.calories_per_min) AS calories_out
           FROM Daily_Burn db JOIN Burn b ON b.burn_id = db.burn_id
           GROUP BY db.daily_id) bo ON bo.daily_id = dr.daily_id;

-- Mean daily calories per user per week (weeks start on Monday)
CREATE VIEW vw_weekly_average AS
SELECT  user_id,
        username,
        DATE_SUB(record_date, INTERVAL WEEKDAY(record_date) DAY) AS week_start,
        COUNT(*)                     AS days_logged,
        ROUND(AVG(calories_in), 1)   AS avg_calories_in,
        ROUND(AVG(calories_out), 1)  AS avg_calories_out,
        ROUND(AVG(net_calories), 1)  AS avg_net_calories
FROM vw_daily_summary
GROUP BY user_id, username, DATE_SUB(record_date, INTERVAL WEEKDAY(record_date) DAY);

-- User profile with age computed on the fly (no password column)
CREATE VIEW vw_user_profile AS
SELECT  user_id, username, user_contact, dob,
        TIMESTAMPDIFF(YEAR, dob, CURDATE()) AS age,
        is_staff, is_active, date_joined, last_login
FROM Users;

-- Every food logged, one row per (day, food), with who / when / calories.
-- entry_id gives the admin panel a single-column key for the composite PK.
CREATE VIEW vw_food_log AS
SELECT  CONCAT(df.daily_id, '-', df.food_id)  AS entry_id,
        df.daily_id,
        dr.user_id,
        u.username,
        dr.record_date,
        df.food_id,
        f.name                                 AS food_name,
        f.food_type,
        df.servings,
        f.calories_per_serving,
        df.servings * f.calories_per_serving   AS calories
FROM Daily_Food df
JOIN Daily_Record dr ON dr.daily_id = df.daily_id
JOIN Users u         ON u.user_id   = dr.user_id
JOIN Food f          ON f.food_id   = df.food_id;

-- Every workout logged, one row per (day, exercise)
CREATE VIEW vw_burn_log AS
SELECT  CONCAT(db.daily_id, '-', db.burn_id)  AS entry_id,
        db.daily_id,
        dr.user_id,
        u.username,
        dr.record_date,
        db.burn_id,
        b.burn_name,
        b.burn_type,
        db.duration_min,
        b.calories_per_min,
        db.duration_min * b.calories_per_min  AS calories
FROM Daily_Burn db
JOIN Daily_Record dr ON dr.daily_id = db.daily_id
JOIN Users u         ON u.user_id   = dr.user_id
JOIN Burn b          ON b.burn_id   = db.burn_id;
