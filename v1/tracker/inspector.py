"""The SQL inspector behind the admins' SQL tab.

* run_script() splits a script into statements (DELIMITER works, like in the
  mysql client) and runs them one by one on its own MySQL connection, so
  START TRANSACTION / SAVEPOINT / ROLLBACK / COMMIT behave as in Workbench.
  It signs in as the site's own MySQL account, the same one Django uses.
* source() cuts the project's own SQL (the account and its GRANT, the schema,
  triggers, views and the queries behind the website) into pieces to show.
* concepts() reads the examples in db/concepts.sql.
"""

import re
import time
from datetime import datetime

import MySQLdb
from django.conf import settings
from django.db import connection

from . import sqlcapture

MAX_ROWS = 500

KINDS = {
    "DDL": ("CREATE", "ALTER", "DROP", "TRUNCATE", "RENAME"),
    "DML": ("INSERT", "UPDATE", "DELETE", "REPLACE", "LOAD"),
    "DQL": ("SELECT", "WITH", "SHOW", "DESCRIBE", "DESC", "EXPLAIN", "TABLE", "VALUES"),
    "TCL": ("START", "BEGIN", "COMMIT", "ROLLBACK", "SAVEPOINT", "RELEASE"),
    "DCL": ("GRANT", "REVOKE"),
}


def kind_of(sql):
    word = (re.match(r"\s*(\w+)", sql) or [None, ""])[1].upper()
    for kind, words in KINDS.items():
        if word in words:
            return kind
    return "Other"


# ---------------------------------------------------------------- splitting


def split_script(script):
    """The statements in a script, in order. Leading comments are dropped;
    "DELIMITER $$" lines change the statement end, as in the mysql client."""
    out, buf, delim = [], [], ";"
    i, n = 0, len(script)

    def flush():
        text = "".join(buf).strip()
        buf.clear()
        if text:
            out.append(text)

    while i < n:
        at_start = not "".join(buf).strip()
        if at_start:
            line_end = script.find("\n", i)
            line_end = n if line_end < 0 else line_end
            line = script[i:line_end].strip()
            m = re.match(r"delimiter\s+(\S+)", line, re.I)
            if m:
                delim = m.group(1)
                buf.clear()
                i = line_end + 1
                continue
        c = script[i]
        if c in "'\"`":  # quoted string or name: copy it whole
            j = i + 1
            while j < n:
                if script[j] == "\\" and c != "`":
                    j += 2
                    continue
                if script[j] == c:
                    if j + 1 < n and script[j + 1] == c:  # doubled quote
                        j += 2
                        continue
                    break
                j += 1
            buf.append(script[i:j + 1])
            i = j + 1
        elif script.startswith("--", i) and (i + 2 >= n or script[i + 2] in " \t\r\n") or c == "#":
            end = script.find("\n", i)
            end = n if end < 0 else end
            comment = script[i:end]
            if at_start:
                buf.clear()
            else:
                buf.append(comment)
            i = end
        elif script.startswith("/*", i):
            end = script.find("*/", i + 2)
            end = n if end < 0 else end + 2
            if not at_start:
                buf.append(script[i:end])
            i = end
        elif script.startswith(delim, i):
            flush()
            i += len(delim)
        else:
            buf.append(c)
            i += 1
    flush()
    return out


# ---------------------------------------------------------------- running


def connect():
    """A fresh connection as the site's account (DB_USER in .env), separate
    from Django's, so a script's transaction is its own."""
    db = settings.DATABASES["default"]
    return MySQLdb.connect(host=db["HOST"], port=int(db["PORT"]), user=db["USER"], password=db["PASSWORD"],
                           database=db["NAME"], charset="utf8mb4", autocommit=True)


def plain(value):
    if isinstance(value, (bytes, bytearray)):
        return value.decode("utf-8", "replace")
    return value


class Transaction:
    """What a connection's transaction looks like after each statement:
    START / BEGIN open it, COMMIT / ROLLBACK close it, DDL and DCL commit it
    implicitly, SAVEPOINT / ROLLBACK TO / RELEASE edit the savepoint list."""

    def __init__(self):
        self.open, self.savepoints, self.autocommit = False, [], True

    def after(self, sql):
        text = re.sub(r"\s+", " ", sql.strip())  # names keep their case, keywords are matched in s
        s = text.upper()
        word = s.split(" ", 1)[0]
        m = re.match(r"SET (?:SESSION |@@SESSION\.|@@)?AUTOCOMMIT ?= ?(\w+)", s)
        if m:
            self.autocommit = m.group(1) in ("1", "ON")
            if self.autocommit:
                self.open, self.savepoints = False, []
        elif s.startswith("START TRANSACTION") or s in ("BEGIN", "BEGIN WORK"):
            self.open, self.savepoints = True, []
        elif word == "SAVEPOINT":
            name = text.split(" ", 1)[1].strip("` ")
            if name in self.savepoints:
                self.savepoints.remove(name)
            self.savepoints.append(name)
        elif (m := re.match(r"ROLLBACK (?:WORK )?TO (?:SAVEPOINT )?`?(\w+)", text, re.I)):
            if m.group(1) in self.savepoints:
                del self.savepoints[self.savepoints.index(m.group(1)) + 1:]
        elif (m := re.match(r"RELEASE SAVEPOINT `?(\w+)", text, re.I)):
            if m.group(1) in self.savepoints:
                del self.savepoints[self.savepoints.index(m.group(1)):]
        elif word in ("COMMIT", "ROLLBACK") or kind_of(s) in ("DDL", "DCL"):
            self.open, self.savepoints = False, []
        elif not self.autocommit and kind_of(s) in ("DML", "DQL"):
            self.open = True

    def state(self):
        return {"open": self.open, "savepoints": list(self.savepoints), "autocommit": self.autocommit}


def run_script(request, script, keep_going=False):
    statements = split_script(script)
    results, notes = [], []
    tx = Transaction()
    conn = connect()
    try:
        for i, sql in enumerate(statements):
            res = {"sql": sql, "kind": kind_of(sql)}
            results.append(res)
            started = time.perf_counter()
            try:
                cur = conn.cursor()
                cur.execute(sql)
                if cur.description:
                    rows = cur.fetchmany(MAX_ROWS + 1)
                    res["columns"] = [d[0] for d in cur.description]
                    res["rows"] = [[plain(v) for v in r] for r in rows[:MAX_ROWS]]
                    res["truncated"] = len(rows) > MAX_ROWS
                else:
                    res["rows_affected"] = cur.rowcount
                while cur.nextset():
                    pass
                cur.close()
                if conn.warning_count():
                    w = conn.cursor()
                    w.execute("SHOW WARNINGS")
                    res["warnings"] = [f"{lvl} {code}: {msg}" for lvl, code, msg in w.fetchall()]
                    w.close()
                tx.after(sql)
            except MySQLdb.Error as exc:
                res["error"] = sqlcapture.describe_db_error(exc)
            res["ms"] = round((time.perf_counter() - started) * 1000, 2)
            res["tx"] = tx.state()

            sqlcapture.history.append({"time": datetime.now().strftime("%H:%M:%S"), "query": sql,
                                       "error": res.get("error"), "account": f"{request.user.username} (SQL tab)"})
            request._request.sql.append(sql)

            if "error" in res and not keep_going:
                left = len(statements) - i - 1
                if left:
                    notes.append(f"Stopped at the error: {left} more statement{'s' if left != 1 else ''} not run. "
                                 "Tick \"Keep going after an error\" to run them anyway.")
                break
    finally:
        if tx.open:
            notes.append("The transaction left open was ROLLED BACK when the run ended "
                         "(each run has its own connection). End with COMMIT to keep it.")
        try:
            conn.rollback()
            conn.close()
        except MySQLdb.Error:
            pass
    return {"results": results, "notes": notes}


# ---------------------------------------------------------------- source


DB_DIR = settings.BASE_DIR / "db"
TRACKER_DIR = settings.BASE_DIR / "tracker"

# tables whose rows the admin panel shows on another page (composite keys -> the log views)
ADMIN_ALIASES = {"Daily_Food": "vw_food_log", "Daily_Burn": "vw_burn_log"}


def admin_pages():
    """db_table -> admin changelist URL, for every model the admin panel lists."""
    from django.contrib import admin
    from django.urls import reverse
    pages = {m._meta.db_table: reverse(f"admin:{m._meta.app_label}_{m._meta.model_name}_changelist")
             for m in admin.site._registry}
    return {**pages, **{t: pages[v] for t, v in ADMIN_ALIASES.items() if v in pages}}


def _comment_above(text, start):
    """The "-- ..." lines right above a statement (dash-only rulers left out)."""
    lines = text[:start].rstrip("\n").split("\n")
    out = []
    while lines and lines[-1].startswith("--"):
        line = lines.pop()
        if not re.fullmatch(r"-+\s*-*", line.replace(" ", "")):
            out.insert(0, line)
    return "\n".join(out)


def _line(text, pos):
    return text.count("\n", 0, pos) + 1


def source():
    """The project's real SQL, piece by piece: the MySQL account from
    db/00_account.sql, CREATE TABLE / TRIGGER / VIEW from db/01_schema.sql, and
    the queries the website and the admin dashboard run (api.py, admin.py)."""
    pages = admin_pages()
    items = []

    schema_sql = (DB_DIR / "01_schema.sql").read_text(encoding="utf-8")
    for group, pattern in (("Tables", r"CREATE TABLE (\w+) \(.*?\n\);"),
                           ("Triggers", r"CREATE TRIGGER (\w+).*?END\$\$"),
                           ("Views", r"CREATE VIEW (\w+) AS.*?;")):
        for m in re.finditer(pattern, schema_sql, re.S):
            name = m.group(1)
            item = {"group": group, "name": name, "file": "db/01_schema.sql", "line": _line(schema_sql, m.start()),
                    "code": (_comment_above(schema_sql, m.start()) + "\n" + m.group(0)).strip()}
            if group == "Triggers":
                item["code"] += ";"
                item["table"] = re.search(r" ON (\w+)", m.group(0)).group(1)
            else:
                item["table"] = name
                item["try"] = f"SELECT * FROM {name} LIMIT 20;"
            if item["table"] in pages:
                item["admin"] = pages[item["table"]]
            items.append(item)

    account_sql = (DB_DIR / "00_account.sql").read_text(encoding="utf-8")
    start = account_sql.index("DROP USER")
    items.insert(0, {"group": "Database account", "name": "stride_app", "file": "db/00_account.sql",
                     "line": _line(account_sql, start), "try": "SELECT CURRENT_USER();\nSHOW GRANTS;",
                     "code": "-- the one MySQL account the website, the admin panel and the SQL tab use\n"
                             + account_sql[start:].strip()})

    urls = dict((fn, path) for path, fn in re.findall(r'path\("([^"]*)", api\.(\w+)\)',
                                                     (TRACKER_DIR / "urls.py").read_text(encoding="utf-8")))
    api_py = (TRACKER_DIR / "api.py").read_text(encoding="utf-8")
    defs = [(m.start(), m.group(1)) for m in re.finditer(r"^def (\w+)\(", api_py, re.M)]
    by_fn = {}
    for m in re.finditer(r'rows\(\s*"""(.*?)"""', api_py, re.S):
        fn = [name for pos, name in defs if pos < m.start()][-1]
        by_fn.setdefault(fn, []).append((m.start(), m.group(1).strip() + ";"))
    for fn, queries in by_fn.items():
        endpoint = f"/api/{urls[fn]}" if fn in urls else None
        code = "\n\n".join(q for _, q in queries)
        head = f"-- {fn}() in tracker/api.py" + (f", behind GET {endpoint}" if endpoint else "")
        if "%s" in code:
            head += "\n-- %s is a parameter: MySQLdb fills it in safely (no string joining)"
        items.append({"group": "Website queries", "name": endpoint or fn + "()", "file": "tracker/api.py",
                      "line": _line(api_py, queries[0][0]), "code": head + "\n" + code})

    admin_py = (TRACKER_DIR / "admin.py").read_text(encoding="utf-8")
    for m in re.finditer(r'(\w+) = query\(\s*"""(.*?)"""', admin_py, re.S):
        items.append({"group": "Admin dashboard queries", "name": m.group(1), "file": "tracker/admin.py",
                      "line": _line(admin_py, m.start()), "code": m.group(2).strip() + ";",
                      "try": m.group(2).strip() + ";"})
    return items


# ---------------------------------------------------------------- lessons


CONCEPTS_FILE = settings.BASE_DIR / "db" / "concepts.sql"


def concepts():
    """db/concepts.sql as lessons. "-- # Group" starts a group, "-- ## Title" a
    lesson; the comment lines right under the title are its notes, and
    "-- on error: continue" in them runs every statement even if one fails."""
    lessons, group, cur = [], "", None
    for line in CONCEPTS_FILE.read_text(encoding="utf-8").splitlines():
        if m := re.match(r"--\s*#\s+(?!#)(.+)", line):
            group, cur = m.group(1).strip(), None
            continue
        if m := re.match(r"--\s*##\s+(.+)", line):
            cur = {"group": group, "title": m.group(1).strip(), "notes": [], "sql": [], "keep_going": False}
            lessons.append(cur)
            continue
        if cur is None or re.match(r"--\s*=+\s*$", line):
            continue
        if not cur["sql"] and line.startswith("--") and not re.match(r"--\s*@as\b", line):
            text = line[2:].strip()
            if text.lower() == "on error: continue":
                cur["keep_going"] = True
            elif text:
                cur["notes"].append(text)
            continue
        if not cur["sql"] and not line.strip():
            continue
        cur["sql"].append(line)
    for lesson in lessons:
        lesson["notes"] = " ".join(lesson["notes"])
        lesson["sql"] = "\n".join(lesson["sql"]).strip() + "\n"
    return lessons
