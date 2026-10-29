-- =====================================================================
--  FITNESS TRACKER  -  DBMS mini-project
--  04_users.sql : database accounts and their privileges (GRANT)
--  Run this after 01_schema.sql, logged in as root.
--
--  Three MySQL accounts, one per role in the website:
--    ft_admin   everything on fitness_tracker
--    ft_clerk   reads everything, logs meals / workouts / check-ins
--    ft_viewer  read only
--
--  The passwords are plaintext on purpose (mock project) and must match
--  the ones in the .env file at the project root.
-- =====================================================================

DROP USER IF EXISTS 'ft_admin'@'%', 'ft_clerk'@'%', 'ft_viewer'@'%';

CREATE USER 'ft_admin'@'%'  IDENTIFIED BY 'admin123';
CREATE USER 'ft_clerk'@'%'  IDENTIFIED BY 'clerk123';
CREATE USER 'ft_viewer'@'%' IDENTIFIED BY 'viewer123';

-- ---------------------------------------------------------------------
-- Admin: full control of the database, including the catalogues and
-- athletes (but cannot create other accounts: no GRANT OPTION)
-- ---------------------------------------------------------------------
GRANT ALL PRIVILEGES ON fitness_tracker.* TO 'ft_admin'@'%';

-- ---------------------------------------------------------------------
-- Clerk: can read everything and write only the log tables.
-- Food, Burn and Users stay read-only for this account.
-- ---------------------------------------------------------------------
GRANT SELECT ON fitness_tracker.* TO 'ft_clerk'@'%';
GRANT INSERT                 ON fitness_tracker.Daily_Record  TO 'ft_clerk'@'%';
GRANT INSERT, UPDATE, DELETE ON fitness_tracker.Daily_Food    TO 'ft_clerk'@'%';
GRANT INSERT, UPDATE, DELETE ON fitness_tracker.Daily_Burn    TO 'ft_clerk'@'%';
GRANT INSERT, UPDATE, DELETE ON fitness_tracker.Weekly_Record TO 'ft_clerk'@'%';

-- ---------------------------------------------------------------------
-- Viewer: SELECT only (tables and views)
-- ---------------------------------------------------------------------
GRANT SELECT ON fitness_tracker.* TO 'ft_viewer'@'%';

FLUSH PRIVILEGES;

-- check them
SHOW GRANTS FOR 'ft_admin'@'%';
SHOW GRANTS FOR 'ft_clerk'@'%';
SHOW GRANTS FOR 'ft_viewer'@'%';
