// Fitness Tracker - a tiny REST API over MySQL.
//
// Every request runs plain, hand-written SQL strings (no ORM, no prepared
// statements) so each query can be shown and re-run in MySQL Workbench.
// Requests are handled one at a time behind a single lock.
//
// Each person signs in as one of three MySQL accounts (admin, clerk,
// viewer, see db/04_users.sql). Their requests run on a connection opened
// with that account, so MySQL's own GRANTs decide what they may change.
package main

import (
	"bufio"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/go-sql-driver/mysql"
)

// connection of the signed-in account for the current request
var db *sql.DB
var lock sync.Mutex

// SQL executed during the current request (sent back to the browser)
var executed []string

// last few hundred statements, for the SQL panel in the UI
type logEntry struct {
	Time    string `json:"time"`
	Account string `json:"account"`
	Query   string `json:"query"`
	Error   string `json:"error,omitempty"`
}

var history []logEntry

// ---------------------------------------------------------------------
// Accounts and sign-in
// ---------------------------------------------------------------------

// website role -> MySQL account (names can be changed in .env)
var accounts = map[string]string{}

type session struct {
	role    string
	account string
	conn    *sql.DB
}

var sessions = map[string]*session{}
var current *session // session of the current request
var mysqlAddr string

func main() {
	loadEnv(".env")
	accounts["admin"] = envOr("ADMIN_USER", "ft_admin")
	accounts["clerk"] = envOr("CLERK_USER", "ft_clerk")
	accounts["viewer"] = envOr("VIEWER_USER", "ft_viewer")

	addr := flag.String("mysql", envOr("MYSQL_HOST", "127.0.0.1")+":"+envOr("MYSQL_PORT", "3306"), "MySQL host:port")
	port := flag.String("port", envOr("PORT", "8080"), "HTTP port")
	flag.Parse()
	mysqlAddr = *addr

	mux := http.NewServeMux()

	mux.HandleFunc("POST /api/login", login)
	mux.HandleFunc("POST /api/logout", logout)
	mux.HandleFunc("GET /api/me", me)

	mux.HandleFunc("GET /api/today", getToday)

	mux.HandleFunc("GET /api/users", getUsers)
	mux.HandleFunc("POST /api/users", addUser)
	mux.HandleFunc("PUT /api/users/{id}", updateUser)
	mux.HandleFunc("DELETE /api/users/{id}", deleteUser)

	mux.HandleFunc("GET /api/foods", getFoods)
	mux.HandleFunc("POST /api/foods", addFood)
	mux.HandleFunc("PUT /api/foods/{id}", updateFood)
	mux.HandleFunc("DELETE /api/foods/{id}", deleteFood)

	mux.HandleFunc("GET /api/burns", getBurns)
	mux.HandleFunc("POST /api/burns", addBurn)
	mux.HandleFunc("PUT /api/burns/{id}", updateBurn)
	mux.HandleFunc("DELETE /api/burns/{id}", deleteBurn)

	mux.HandleFunc("GET /api/day", getDay)
	mux.HandleFunc("POST /api/day/food", addDayFood)
	mux.HandleFunc("PUT /api/day/food", updateDayFood)
	mux.HandleFunc("DELETE /api/day/food", deleteDayFood)
	mux.HandleFunc("POST /api/day/burn", addDayBurn)
	mux.HandleFunc("PUT /api/day/burn", updateDayBurn)
	mux.HandleFunc("DELETE /api/day/burn", deleteDayBurn)

	mux.HandleFunc("GET /api/summary", getSummary)
	mux.HandleFunc("GET /api/weekly-average", getWeeklyAverage)
	mux.HandleFunc("GET /api/stats", getStats)
	mux.HandleFunc("GET /api/leaderboard", getLeaderboard)

	mux.HandleFunc("GET /api/weekly", getWeekly)
	mux.HandleFunc("POST /api/weekly", addWeekly)
	mux.HandleFunc("DELETE /api/weekly/{id}", deleteWeekly)

	mux.HandleFunc("GET /api/sqllog", getSQLLog)
	mux.HandleFunc("POST /api/sql", runSQL)

	mux.Handle("/", http.FileServer(http.Dir("static")))

	// one request at a time; every /api call except signing in needs a session
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		lock.Lock()
		defer lock.Unlock()
		executed = nil
		current, db = nil, nil
		if c, err := r.Cookie("ft_session"); err == nil && sessions[c.Value] != nil {
			current = sessions[c.Value]
			db = current.conn
		}
		if strings.HasPrefix(r.URL.Path, "/api/") && r.URL.Path != "/api/login" && current == nil {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusUnauthorized)
			json.NewEncoder(w).Encode(map[string]any{"error": "Please sign in"})
			return
		}
		mux.ServeHTTP(w, r)
	})

	fmt.Printf("\n  Fitness Tracker running on  http://localhost:%s  (MySQL at %s)\n\n", *port, mysqlAddr)
	log.Fatal(http.ListenAndServe(":"+*port, handler))
}

// signs in by opening a MySQL connection as the role's account;
// MySQL itself checks the password
func login(w http.ResponseWriter, r *http.Request) {
	b := body(r)
	role := fmt.Sprint(b["role"])
	account, ok := accounts[role]
	if !ok {
		reply(w, nil, fmt.Errorf("unknown role %q", role))
		return
	}
	cfg := mysql.NewConfig()
	cfg.User = account
	cfg.Passwd = fmt.Sprint(b["password"])
	cfg.Net = "tcp"
	cfg.Addr = mysqlAddr
	cfg.DBName = "fitness_tracker"

	conn, err := sql.Open("mysql", cfg.FormatDSN())
	if err == nil {
		conn.SetMaxOpenConns(1)
		err = conn.Ping()
	}
	if err != nil {
		if conn != nil {
			conn.Close()
		}
		if me, ok := err.(*mysql.MySQLError); ok && me.Number == 1045 {
			err = fmt.Errorf("Wrong password for %s (MySQL account %s)", role, account)
		} else {
			err = fmt.Errorf("Cannot sign in as %s at %s: %v. Did you run db/04_users.sql?", account, mysqlAddr, err)
		}
		reply(w, nil, err)
		return
	}

	if current != nil {
		closeSession(r)
	}
	token := make([]byte, 16)
	rand.Read(token)
	id := hex.EncodeToString(token)
	sessions[id] = &session{role: role, account: account, conn: conn}
	http.SetCookie(w, &http.Cookie{Name: "ft_session", Value: id, Path: "/", HttpOnly: true, SameSite: http.SameSiteStrictMode})
	fmt.Printf("\033[36m[LOGIN]\033[0m %s signed in as MySQL user %s\n", role, account)
	reply(w, map[string]any{"role": role, "account": account}, nil)
}

func logout(w http.ResponseWriter, r *http.Request) {
	closeSession(r)
	http.SetCookie(w, &http.Cookie{Name: "ft_session", Value: "", Path: "/", MaxAge: -1})
	reply(w, nil, nil)
}

func closeSession(r *http.Request) {
	if c, err := r.Cookie("ft_session"); err == nil && sessions[c.Value] != nil {
		sessions[c.Value].conn.Close()
		delete(sessions, c.Value)
	}
}

func me(w http.ResponseWriter, r *http.Request) {
	reply(w, map[string]any{"role": current.role, "account": current.account}, nil)
}

// reads KEY=VALUE lines from .env; variables already set in the shell win
func loadEnv(path string) {
	f, err := os.Open(path)
	if err != nil {
		return
	}
	defer f.Close()
	s := bufio.NewScanner(f)
	for s.Scan() {
		line := strings.TrimSpace(s.Text())
		k, v, ok := strings.Cut(line, "=")
		if !ok || strings.HasPrefix(line, "#") {
			continue
		}
		if _, set := os.LookupEnv(k); !set {
			os.Setenv(strings.TrimSpace(k), strings.TrimSpace(v))
		}
	}
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

// ---------------------------------------------------------------------
// SQL helpers
// ---------------------------------------------------------------------

func record(query string, err error) {
	executed = append(executed, query)
	e := logEntry{Time: time.Now().Format("15:04:05"), Account: current.account, Query: query}
	if err != nil {
		e.Error = err.Error()
		fmt.Printf("\033[31m[SQL %s] %s\n      ERROR: %v\033[0m\n", current.account, query, err)
	} else {
		fmt.Printf("\033[33m[SQL %s]\033[0m %s\n", current.account, query)
	}
	history = append(history, e)
	if len(history) > 300 {
		history = history[len(history)-300:]
	}
}

// fetch runs a SELECT and returns each row as column -> value
func fetch(query string) ([]map[string]any, error) {
	rows, err := db.Query(query)
	record(query, err)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	cols, _ := rows.ColumnTypes()
	result := []map[string]any{}
	for rows.Next() {
		values := make([]any, len(cols))
		ptrs := make([]any, len(cols))
		for i := range values {
			ptrs[i] = &values[i]
		}
		if err := rows.Scan(ptrs...); err != nil {
			return nil, err
		}
		row := map[string]any{}
		for i, c := range cols {
			row[c.Name()] = convert(values[i], c.DatabaseTypeName())
		}
		result = append(result, row)
	}
	return result, rows.Err()
}

// run executes INSERT / UPDATE / DELETE and returns the new auto-increment id
func run(query string) (int64, error) {
	res, err := db.Exec(query)
	record(query, err)
	if err != nil {
		return 0, err
	}
	id, _ := res.LastInsertId()
	return id, nil
}

// numeric columns come back as text; turn them into JSON numbers
func convert(v any, dbType string) any {
	b, ok := v.([]byte)
	if !ok {
		return v
	}
	s := string(b)
	if strings.Contains(dbType, "INT") || strings.Contains(dbType, "DECIMAL") ||
		dbType == "DOUBLE" || dbType == "FLOAT" {
		var f float64
		if _, err := fmt.Sscan(s, &f); err == nil {
			return f
		}
	}
	return s
}

// quote a text value for SQL ('' escapes a single quote); empty becomes NULL
func text(v any) string {
	s := strings.TrimSpace(fmt.Sprint(v))
	if v == nil || s == "" {
		return "NULL"
	}
	return "'" + strings.ReplaceAll(s, "'", "''") + "'"
}

// a number goes into the SQL as-is; empty becomes NULL
func num(v any) string {
	s := strings.TrimSpace(fmt.Sprint(v))
	if v == nil || s == "" {
		return "NULL"
	}
	return s
}

// ---------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------

func reply(w http.ResponseWriter, data any, err error) {
	w.Header().Set("Content-Type", "application/json")
	body := map[string]any{"data": data, "sql": executed}
	if err != nil {
		w.WriteHeader(http.StatusBadRequest)
		body["error"] = explain(err)
	}
	json.NewEncoder(w).Encode(body)
}

// friendlier text for the MySQL errors the business rules produce
func explain(err error) string {
	me, ok := err.(*mysql.MySQLError)
	if !ok {
		return err.Error()
	}
	switch me.Number {
	case 1062:
		return "Already exists: " + me.Message
	case 1451:
		return "Can't delete: it is still used in someone's log (ON DELETE RESTRICT). " + me.Message
	case 3819, 4025:
		return "Value breaks a CHECK constraint: " + me.Message
	case 1644:
		return me.Message
	case 1142, 1143, 1044, 1227:
		return fmt.Sprintf("Permission denied for %s (MySQL error %d): %s", current.account, me.Number, me.Message)
	}
	return fmt.Sprintf("MySQL error %d: %s", me.Number, me.Message)
}

func body(r *http.Request) map[string]any {
	m := map[string]any{}
	json.NewDecoder(r.Body).Decode(&m)
	return m
}

// ---------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------

func getToday(w http.ResponseWriter, r *http.Request) {
	rows, err := fetch("SELECT CURDATE() AS today")
	if err != nil {
		reply(w, nil, err)
		return
	}
	reply(w, rows[0], nil)
}

func getUsers(w http.ResponseWriter, r *http.Request) {
	rows, err := fetch(`SELECT user_id, username, user_contact, dob,
       TIMESTAMPDIFF(YEAR, dob, CURDATE()) AS age
FROM Users
ORDER BY user_id`)
	reply(w, rows, err)
}

func addUser(w http.ResponseWriter, r *http.Request) {
	b := body(r)
	id, err := run(fmt.Sprintf(
		"INSERT INTO Users (username, user_contact, dob) VALUES (%s, %s, %s)",
		text(b["username"]), text(b["user_contact"]), text(b["dob"])))
	reply(w, map[string]any{"user_id": id}, err)
}

func updateUser(w http.ResponseWriter, r *http.Request) {
	b := body(r)
	_, err := run(fmt.Sprintf(
		"UPDATE Users SET username = %s, user_contact = %s, dob = %s WHERE user_id = %s",
		text(b["username"]), text(b["user_contact"]), text(b["dob"]), r.PathValue("id")))
	reply(w, nil, err)
}

func deleteUser(w http.ResponseWriter, r *http.Request) {
	_, err := run("DELETE FROM Users WHERE user_id = " + r.PathValue("id"))
	reply(w, nil, err)
}

// ---------------------------------------------------------------------
// Food catalogue
// ---------------------------------------------------------------------

func getFoods(w http.ResponseWriter, r *http.Request) {
	rows, err := fetch(`SELECT f.food_id, f.name, f.food_type, f.calories_per_serving,
       COUNT(df.daily_id) AS times_logged
FROM Food f
LEFT JOIN Daily_Food df ON df.food_id = f.food_id
GROUP BY f.food_id, f.name, f.food_type, f.calories_per_serving
ORDER BY f.food_type, f.name`)
	reply(w, rows, err)
}

func addFood(w http.ResponseWriter, r *http.Request) {
	b := body(r)
	id, err := run(fmt.Sprintf(
		"INSERT INTO Food (name, food_type, calories_per_serving) VALUES (%s, %s, %s)",
		text(b["name"]), text(b["food_type"]), num(b["calories_per_serving"])))
	reply(w, map[string]any{"food_id": id}, err)
}

func updateFood(w http.ResponseWriter, r *http.Request) {
	b := body(r)
	_, err := run(fmt.Sprintf(
		"UPDATE Food SET name = %s, food_type = %s, calories_per_serving = %s WHERE food_id = %s",
		text(b["name"]), text(b["food_type"]), num(b["calories_per_serving"]), r.PathValue("id")))
	reply(w, nil, err)
}

func deleteFood(w http.ResponseWriter, r *http.Request) {
	_, err := run("DELETE FROM Food WHERE food_id = " + r.PathValue("id"))
	reply(w, nil, err)
}

// ---------------------------------------------------------------------
// Burn (exercise) catalogue
// ---------------------------------------------------------------------

func getBurns(w http.ResponseWriter, r *http.Request) {
	rows, err := fetch(`SELECT b.burn_id, b.burn_name, b.burn_type, b.calories_per_min,
       COUNT(db.daily_id) AS times_logged
FROM Burn b
LEFT JOIN Daily_Burn db ON db.burn_id = b.burn_id
GROUP BY b.burn_id, b.burn_name, b.burn_type, b.calories_per_min
ORDER BY b.burn_type, b.burn_name`)
	reply(w, rows, err)
}

func addBurn(w http.ResponseWriter, r *http.Request) {
	b := body(r)
	id, err := run(fmt.Sprintf(
		"INSERT INTO Burn (burn_name, burn_type, calories_per_min) VALUES (%s, %s, %s)",
		text(b["burn_name"]), text(b["burn_type"]), num(b["calories_per_min"])))
	reply(w, map[string]any{"burn_id": id}, err)
}

func updateBurn(w http.ResponseWriter, r *http.Request) {
	b := body(r)
	_, err := run(fmt.Sprintf(
		"UPDATE Burn SET burn_name = %s, burn_type = %s, calories_per_min = %s WHERE burn_id = %s",
		text(b["burn_name"]), text(b["burn_type"]), num(b["calories_per_min"]), r.PathValue("id")))
	reply(w, nil, err)
}

func deleteBurn(w http.ResponseWriter, r *http.Request) {
	_, err := run("DELETE FROM Burn WHERE burn_id = " + r.PathValue("id"))
	reply(w, nil, err)
}

// ---------------------------------------------------------------------
// A single day: what was eaten and what was done
// ---------------------------------------------------------------------

func getDay(w http.ResponseWriter, r *http.Request) {
	userID := r.URL.Query().Get("user_id")
	date := r.URL.Query().Get("date")

	day := map[string]any{"daily_id": nil, "foods": []any{}, "burns": []any{},
		"calories_in": 0, "calories_out": 0, "net_calories": 0}

	rows, err := fetch(fmt.Sprintf(
		"SELECT daily_id FROM Daily_Record WHERE user_id = %s AND record_date = %s",
		num(userID), text(date)))
	if err != nil || len(rows) == 0 {
		reply(w, day, err)
		return
	}
	dailyID := fmt.Sprint(rows[0]["daily_id"])
	day["daily_id"] = rows[0]["daily_id"]

	foods, err := fetch(`SELECT df.food_id, f.name, f.food_type, df.servings, f.calories_per_serving,
       df.servings * f.calories_per_serving AS calories
FROM Daily_Food df
JOIN Food f ON f.food_id = df.food_id
WHERE df.daily_id = ` + dailyID + `
ORDER BY f.food_type, f.name`)
	if err != nil {
		reply(w, nil, err)
		return
	}
	day["foods"] = foods

	burns, err := fetch(`SELECT db.burn_id, b.burn_name, b.burn_type, db.duration_min, b.calories_per_min,
       db.duration_min * b.calories_per_min AS calories
FROM Daily_Burn db
JOIN Burn b ON b.burn_id = db.burn_id
WHERE db.daily_id = ` + dailyID + `
ORDER BY b.burn_name`)
	if err != nil {
		reply(w, nil, err)
		return
	}
	day["burns"] = burns

	totals, err := fetch(`SELECT t.calories_in, t.calories_out, t.calories_in - t.calories_out AS net_calories
FROM (SELECT
        (SELECT COALESCE(SUM(df.servings * f.calories_per_serving), 0)
         FROM Daily_Food df JOIN Food f ON f.food_id = df.food_id
         WHERE df.daily_id = ` + dailyID + `) AS calories_in,
        (SELECT COALESCE(SUM(db.duration_min * b.calories_per_min), 0)
         FROM Daily_Burn db JOIN Burn b ON b.burn_id = db.burn_id
         WHERE db.daily_id = ` + dailyID + `) AS calories_out
     ) t`)
	if err != nil {
		reply(w, nil, err)
		return
	}
	for k, v := range totals[0] {
		day[k] = v
	}
	reply(w, day, nil)
}

// finds the Daily_Record for user+date, creating it if this is the first entry
func dailyRecordID(userID, date any) (string, error) {
	rows, err := fetch(fmt.Sprintf(
		"SELECT daily_id FROM Daily_Record WHERE user_id = %s AND record_date = %s",
		num(userID), text(date)))
	if err != nil {
		return "", err
	}
	if len(rows) > 0 {
		return fmt.Sprint(rows[0]["daily_id"]), nil
	}
	id, err := run(fmt.Sprintf(
		"INSERT INTO Daily_Record (user_id, record_date) VALUES (%s, %s)",
		num(userID), text(date)))
	return fmt.Sprint(id), err
}

func addDayFood(w http.ResponseWriter, r *http.Request) {
	b := body(r)
	dailyID, err := dailyRecordID(b["user_id"], b["date"])
	if err != nil {
		reply(w, nil, err)
		return
	}
	// logging the same food twice adds to the servings instead of a new row
	_, err = run(fmt.Sprintf(`INSERT INTO Daily_Food (daily_id, food_id, servings)
VALUES (%s, %s, %s)
ON DUPLICATE KEY UPDATE servings = servings + VALUES(servings)`,
		dailyID, num(b["food_id"]), num(b["servings"])))
	reply(w, nil, err)
}

func updateDayFood(w http.ResponseWriter, r *http.Request) {
	b := body(r)
	_, err := run(fmt.Sprintf(
		"UPDATE Daily_Food SET servings = %s WHERE daily_id = %s AND food_id = %s",
		num(b["servings"]), num(b["daily_id"]), num(b["food_id"])))
	reply(w, nil, err)
}

func deleteDayFood(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	_, err := run(fmt.Sprintf(
		"DELETE FROM Daily_Food WHERE daily_id = %s AND food_id = %s",
		num(q.Get("daily_id")), num(q.Get("food_id"))))
	reply(w, nil, err)
}

func addDayBurn(w http.ResponseWriter, r *http.Request) {
	b := body(r)
	dailyID, err := dailyRecordID(b["user_id"], b["date"])
	if err != nil {
		reply(w, nil, err)
		return
	}
	_, err = run(fmt.Sprintf(`INSERT INTO Daily_Burn (daily_id, burn_id, duration_min)
VALUES (%s, %s, %s)
ON DUPLICATE KEY UPDATE duration_min = duration_min + VALUES(duration_min)`,
		dailyID, num(b["burn_id"]), num(b["duration_min"])))
	reply(w, nil, err)
}

func updateDayBurn(w http.ResponseWriter, r *http.Request) {
	b := body(r)
	_, err := run(fmt.Sprintf(
		"UPDATE Daily_Burn SET duration_min = %s WHERE daily_id = %s AND burn_id = %s",
		num(b["duration_min"]), num(b["daily_id"]), num(b["burn_id"])))
	reply(w, nil, err)
}

func deleteDayBurn(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	_, err := run(fmt.Sprintf(
		"DELETE FROM Daily_Burn WHERE daily_id = %s AND burn_id = %s",
		num(q.Get("daily_id")), num(q.Get("burn_id"))))
	reply(w, nil, err)
}

// ---------------------------------------------------------------------
// Summaries
// ---------------------------------------------------------------------

func getSummary(w http.ResponseWriter, r *http.Request) {
	days := r.URL.Query().Get("days")
	if days == "" {
		days = "14"
	}
	rows, err := fetch(`SELECT dr.record_date,
       COALESCE(fi.calories_in, 0)  AS calories_in,
       COALESCE(bo.calories_out, 0) AS calories_out,
       COALESCE(fi.calories_in, 0) - COALESCE(bo.calories_out, 0) AS net_calories,
       COALESCE(bo.minutes, 0)      AS minutes
FROM Daily_Record dr
LEFT JOIN (SELECT df.daily_id, SUM(df.servings * f.calories_per_serving) AS calories_in
           FROM Daily_Food df JOIN Food f ON f.food_id = df.food_id
           GROUP BY df.daily_id) fi ON fi.daily_id = dr.daily_id
LEFT JOIN (SELECT db.daily_id, SUM(db.duration_min * b.calories_per_min) AS calories_out,
                  SUM(db.duration_min) AS minutes
           FROM Daily_Burn db JOIN Burn b ON b.burn_id = db.burn_id
           GROUP BY db.daily_id) bo ON bo.daily_id = dr.daily_id
WHERE dr.user_id = ` + num(r.URL.Query().Get("user_id")) + `
  AND dr.record_date > CURDATE() - INTERVAL ` + days + ` DAY
ORDER BY dr.record_date`)
	reply(w, rows, err)
}

func getWeeklyAverage(w http.ResponseWriter, r *http.Request) {
	rows, err := fetch(`SELECT DATE_SUB(d.record_date, INTERVAL WEEKDAY(d.record_date) DAY) AS week_start,
       COUNT(*)                    AS days_logged,
       ROUND(AVG(d.calories_in), 0)  AS avg_in,
       ROUND(AVG(d.calories_out), 0) AS avg_out,
       ROUND(AVG(d.calories_in - d.calories_out), 0) AS avg_net
FROM (SELECT dr.daily_id, dr.record_date,
             (SELECT COALESCE(SUM(df.servings * f.calories_per_serving), 0)
              FROM Daily_Food df JOIN Food f ON f.food_id = df.food_id
              WHERE df.daily_id = dr.daily_id) AS calories_in,
             (SELECT COALESCE(SUM(db.duration_min * b.calories_per_min), 0)
              FROM Daily_Burn db JOIN Burn b ON b.burn_id = db.burn_id
              WHERE db.daily_id = dr.daily_id) AS calories_out
      FROM Daily_Record dr
      WHERE dr.user_id = ` + num(r.URL.Query().Get("user_id")) + `) d
GROUP BY week_start
ORDER BY week_start DESC`)
	reply(w, rows, err)
}

func getStats(w http.ResponseWriter, r *http.Request) {
	userID := num(r.URL.Query().Get("user_id"))
	stats := map[string]any{}

	totals, err := fetch(`SELECT COUNT(DISTINCT dr.daily_id)      AS days_logged,
       COUNT(db.burn_id)                AS workouts,
       COALESCE(SUM(db.duration_min), 0) AS active_minutes
FROM Daily_Record dr
LEFT JOIN Daily_Burn db ON db.daily_id = dr.daily_id
WHERE dr.user_id = ` + userID)
	if err != nil {
		reply(w, nil, err)
		return
	}
	stats["totals"] = totals[0]

	food, err := fetch(`SELECT f.name, SUM(df.servings) AS total_servings
FROM Daily_Food df
JOIN Daily_Record dr ON dr.daily_id = df.daily_id
JOIN Food f ON f.food_id = df.food_id
WHERE dr.user_id = ` + userID + `
GROUP BY f.food_id, f.name
ORDER BY total_servings DESC
LIMIT 3`)
	if err != nil {
		reply(w, nil, err)
		return
	}
	stats["top_foods"] = food

	burn, err := fetch(`SELECT b.burn_name, SUM(db.duration_min) AS total_minutes
FROM Daily_Burn db
JOIN Daily_Record dr ON dr.daily_id = db.daily_id
JOIN Burn b ON b.burn_id = db.burn_id
WHERE dr.user_id = ` + userID + `
GROUP BY b.burn_id, b.burn_name
ORDER BY total_minutes DESC
LIMIT 3`)
	stats["top_burns"] = burn
	reply(w, stats, err)
}

func getLeaderboard(w http.ResponseWriter, r *http.Request) {
	rows, err := fetch(`SELECT u.user_id, u.username,
       COALESCE(SUM(db.duration_min * b.calories_per_min), 0) AS calories_burnt,
       COALESCE(SUM(db.duration_min), 0) AS minutes,
       RANK() OVER (ORDER BY COALESCE(SUM(db.duration_min * b.calories_per_min), 0) DESC) AS position
FROM Users u
LEFT JOIN Daily_Record dr ON dr.user_id = u.user_id
      AND dr.record_date > CURDATE() - INTERVAL 7 DAY
LEFT JOIN Daily_Burn db ON db.daily_id = dr.daily_id
LEFT JOIN Burn b ON b.burn_id = db.burn_id
GROUP BY u.user_id, u.username
ORDER BY position`)
	reply(w, rows, err)
}

// ---------------------------------------------------------------------
// Weekly body measurements
// ---------------------------------------------------------------------

func getWeekly(w http.ResponseWriter, r *http.Request) {
	rows, err := fetch(`SELECT week_id, week_start_date, height_cm, weight_kg,
       ROUND(weight_kg / POW(height_cm / 100, 2), 1) AS bmi,
       weight_kg - LAG(weight_kg) OVER (ORDER BY week_start_date) AS change_kg
FROM Weekly_Record
WHERE user_id = ` + num(r.URL.Query().Get("user_id")) + `
ORDER BY week_start_date`)
	reply(w, rows, err)
}

func addWeekly(w http.ResponseWriter, r *http.Request) {
	b := body(r)
	id, err := run(fmt.Sprintf(
		"INSERT INTO Weekly_Record (user_id, week_start_date, height_cm, weight_kg) VALUES (%s, %s, %s, %s)",
		num(b["user_id"]), text(b["week_start_date"]), num(b["height_cm"]), num(b["weight_kg"])))
	reply(w, map[string]any{"week_id": id}, err)
}

func deleteWeekly(w http.ResponseWriter, r *http.Request) {
	_, err := run("DELETE FROM Weekly_Record WHERE week_id = " + r.PathValue("id"))
	reply(w, nil, err)
}

// ---------------------------------------------------------------------
// SQL panel + playground
// ---------------------------------------------------------------------

func getSQLLog(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(history)
}

// runs whatever SQL is typed into the playground box
func runSQL(w http.ResponseWriter, r *http.Request) {
	query := strings.TrimSpace(fmt.Sprint(body(r)["query"]))
	query = strings.TrimSuffix(query, ";")
	first := strings.ToUpper(strings.Fields(query + " x")[0])

	if first == "SELECT" || first == "SHOW" || first == "DESCRIBE" || first == "DESC" ||
		first == "EXPLAIN" || first == "WITH" {
		rows, err := db.Query(query)
		record(query, err)
		if err != nil {
			reply(w, nil, err)
			return
		}
		defer rows.Close()
		cols, _ := rows.ColumnTypes()
		names := []string{}
		for _, c := range cols {
			names = append(names, c.Name())
		}
		table := [][]any{}
		for rows.Next() {
			values := make([]any, len(cols))
			ptrs := make([]any, len(cols))
			for i := range values {
				ptrs[i] = &values[i]
			}
			rows.Scan(ptrs...)
			for i, c := range cols {
				values[i] = convert(values[i], c.DatabaseTypeName())
			}
			table = append(table, values)
		}
		reply(w, map[string]any{"columns": names, "rows": table}, nil)
		return
	}

	res, err := db.Exec(query)
	record(query, err)
	if err != nil {
		reply(w, nil, err)
		return
	}
	n, _ := res.RowsAffected()
	reply(w, map[string]any{"rows_affected": n}, nil)
}
