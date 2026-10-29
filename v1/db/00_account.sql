-- =====================================================================
--  STRIDE v1  -  00_account.sql
--  Run ONCE as the MySQL/MariaDB root user:
--      sudo mariadb < db/00_account.sql          (MariaDB, socket login)
--      mysql -u root -p < db/00_account.sql      (MySQL / password login)
--
--  Creates the account Django connects as. It owns fitness_tracker_v1
--  and nothing else, so it can also drop and recreate that database
--  (./run.sh --reset). The password must match DB_PASSWORD in .env.
--
--  The account is created for 'localhost' as well as '%': a fresh
--  MariaDB has an anonymous ''@'localhost' user that would otherwise
--  shadow 'stride_app'@'%' for local connections.
-- =====================================================================

DROP USER IF EXISTS 'stride_app'@'localhost', 'stride_app'@'127.0.0.1', 'stride_app'@'%';

CREATE USER 'stride_app'@'localhost' IDENTIFIED BY 'stride_app_pass';
CREATE USER 'stride_app'@'127.0.0.1' IDENTIFIED BY 'stride_app_pass';
CREATE USER 'stride_app'@'%'         IDENTIFIED BY 'stride_app_pass';

GRANT ALL PRIVILEGES ON `fitness_tracker_v1`.* TO 'stride_app'@'localhost';
GRANT ALL PRIVILEGES ON `fitness_tracker_v1`.* TO 'stride_app'@'127.0.0.1';
GRANT ALL PRIVILEGES ON `fitness_tracker_v1`.* TO 'stride_app'@'%';

FLUSH PRIVILEGES;

SHOW GRANTS FOR 'stride_app'@'localhost';
