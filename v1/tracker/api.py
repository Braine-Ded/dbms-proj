"""REST API: every endpoint of v0, plus sign-up, JWT sign-in and account pages.

Who may do what:
* anyone: register, login, refresh a token
* a signed-in user: their own days, food/workout logs, check-ins and profile;
  read the food/exercise catalogue and the leaderboard
* staff (Users.is_staff = 1): everything above for any user (pass ?user_id=),
  edit the catalogue and other users, the SQL playground

Simple writes go through the ORM. The reports are hand-written SQL with
%s parameters (no string joining, so no SQL injection), the same queries
as v0 and db/03_demo_queries.sql.
"""

import re
from datetime import date

from django.contrib.auth import password_validation
from django.core.exceptions import ValidationError as DjangoValidationError
from django.db import connection
from django.db.models import Count, F
from django.shortcuts import get_object_or_404
from rest_framework import status
from rest_framework.decorators import api_view, authentication_classes, permission_classes
from rest_framework.exceptions import AuthenticationFailed, NotFound, PermissionDenied, ValidationError
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework_simplejwt.exceptions import InvalidToken, TokenError
from rest_framework_simplejwt.serializers import TokenObtainPairSerializer, TokenRefreshSerializer
from rest_framework_simplejwt.tokens import RefreshToken

from . import sqlcapture
from .models import BURN_TYPES, FOOD_TYPES, Burn, DailyBurn, DailyFood, DailyRecord, Food, User, WeeklyRecord

# ---------------------------------------------------------------- helpers


def rows(sql, params=()):
    """Run a SELECT and return each row as {column: value}."""
    with connection.cursor() as cur:
        cur.execute(sql, params)
        cols = [c[0] for c in cur.description]
        return [dict(zip(cols, r)) for r in cur.fetchall()]


def require_staff(request):
    if not request.user.is_staff:
        raise PermissionDenied("Only staff can do that.")


def target_user(request):
    """The signed-in user, or for staff the user named by ?user_id= / body user_id."""
    uid = request.query_params.get("user_id") or (request.data.get("user_id") if isinstance(request.data, dict) else None)
    if uid and str(uid) != str(request.user.user_id):
        require_staff(request)
        return get_object_or_404(User, pk=number(uid, "user_id", int))
    return request.user


def own_day(request, daily_id):
    """A Daily_Record the signed-in user may change."""
    day = get_object_or_404(DailyRecord, pk=number(daily_id, "daily_id", int))
    if day.user_id != request.user.user_id:
        require_staff(request)
    return day


def number(value, field, kind=float):
    try:
        return kind(str(value).strip())
    except (TypeError, ValueError):
        raise ValidationError({field: ["Enter a number."]})


def iso_date(value, field, required=True):
    if value in (None, ""):
        if required:
            raise ValidationError({field: ["This field is required."]})
        return None
    try:
        return date.fromisoformat(str(value))
    except ValueError:
        raise ValidationError({field: ["Use the format YYYY-MM-DD."]})


def required_text(value, field):
    value = (value or "").strip() if isinstance(value, str) else ""
    if not value:
        raise ValidationError({field: ["This field is required."]})
    return value


def choice(value, options, field):
    if value not in options:
        raise ValidationError({field: ["Pick one of: " + ", ".join(options) + "."]})
    return value


def text(value):
    value = (value or "").strip() if isinstance(value, str) else value
    return value or None


def profile(user):
    return {
        "user_id": user.user_id,
        "username": user.username,
        "user_contact": user.user_contact,
        "dob": user.dob,
        "age": user.age,
        "is_staff": user.is_staff,
        "is_active": user.is_active,
        "date_joined": user.date_joined,
        "last_login": user.last_login,
    }


def tokens_for(user):
    refresh = RefreshToken.for_user(user)
    return {"access": str(refresh.access_token), "refresh": str(refresh)}


USERNAME_RE = re.compile(r"^[A-Za-z0-9_.-]{3,50}$")


def check_username(username, exclude_id=None):
    if not USERNAME_RE.match(username or ""):
        raise ValidationError({"username": ["3 to 50 characters: letters, digits, dot, dash or underscore."]})
    taken = User.objects.filter(username=username)
    if exclude_id:
        taken = taken.exclude(pk=exclude_id)
    if taken.exists():
        raise ValidationError({"username": ["That username is already taken."]})


def check_password(password, user):
    try:
        password_validation.validate_password(password or "", user)
    except DjangoValidationError as e:
        raise ValidationError({"password": e.messages})


# ---------------------------------------------------------------- auth


@api_view(["POST"])
@authentication_classes([])
@permission_classes([AllowAny])
def register(request):
    """Create an account (INSERT INTO Users) and sign straight in."""
    d = request.data
    username = (d.get("username") or "").strip()
    check_username(username)
    candidate = User(username=username, user_contact=text(d.get("user_contact")))
    check_password(d.get("password"), candidate)
    user = User.objects.create_user(
        username,
        d.get("password"),
        user_contact=text(d.get("user_contact")),
        dob=iso_date(d.get("dob"), "dob", required=False),
    )
    user.last_login = user.date_joined
    user.save(update_fields=["last_login"])
    return Response({**tokens_for(user), "user": profile(user)}, status=status.HTTP_201_CREATED)


@api_view(["POST"])
@authentication_classes([])
@permission_classes([AllowAny])
def login(request):
    """Check username + password against Users.password; returns an access and a refresh JWT."""
    s = TokenObtainPairSerializer(data=request.data)
    try:
        s.is_valid(raise_exception=True)
    except AuthenticationFailed:  # also raised for a disabled account (is_active = 0)
        raise AuthenticationFailed("Wrong username or password, or the account is disabled.")
    return Response({**s.validated_data, "user": profile(s.user)})


@api_view(["POST"])
@authentication_classes([])
@permission_classes([AllowAny])
def refresh(request):
    """Trade a refresh token for a new access token."""
    s = TokenRefreshSerializer(data=request.data)
    try:
        s.is_valid(raise_exception=True)
    except TokenError as e:  # malformed or expired refresh token
        raise InvalidToken(e.args[0])
    return Response(s.validated_data)


@api_view(["POST"])
def logout(request):
    """JWTs are stateless: signing out means the browser forgets its tokens.
    The access token stops working by itself within JWT_ACCESS_MINUTES."""
    return Response({"signed_out": request.user.username})


@api_view(["GET", "PUT", "DELETE"])
def me(request):
    user = request.user
    if request.method == "GET":
        return Response(profile(user))

    if request.method == "PUT":
        d = request.data
        username = (d.get("username") or user.username).strip()
        check_username(username, exclude_id=user.user_id)
        user.username = username
        user.user_contact = text(d.get("user_contact"))
        user.dob = iso_date(d.get("dob"), "dob", required=False)
        user.save(update_fields=["username", "user_contact", "dob"])
        return Response(profile(user))

    # DELETE: the account and, by ON DELETE CASCADE, every day and check-in
    if not user.check_password(request.data.get("password") or ""):
        raise ValidationError({"password": ["Password is not correct."]})
    if user.is_staff:
        raise PermissionDenied("Staff accounts are removed from the admin panel.")
    user.delete()
    return Response({"deleted": True})


@api_view(["POST"])
def change_password(request):
    user = request.user
    if not user.check_password(request.data.get("current_password") or ""):
        raise ValidationError({"current_password": ["Current password is not correct."]})
    check_password(request.data.get("new_password"), user)
    user.set_password(request.data["new_password"])
    user.save(update_fields=["password", "unhashed_password"])
    return Response({"changed": True})


# ---------------------------------------------------------------- users


@api_view(["GET"])
def today(request):
    return Response(rows("SELECT CURDATE() AS today")[0])


@api_view(["GET", "POST"])
def users(request):
    require_staff(request)
    if request.method == "GET":
        return Response([profile(u) for u in User.objects.order_by("user_id")])
    d = request.data
    username = (d.get("username") or "").strip()
    check_username(username)
    check_password(d.get("password"), User(username=username))
    user = User.objects.create_user(
        username, d.get("password"),
        user_contact=text(d.get("user_contact")),
        dob=iso_date(d.get("dob"), "dob", required=False),
        is_staff=bool(d.get("is_staff")),
    )
    return Response(profile(user), status=status.HTTP_201_CREATED)


@api_view(["PUT", "DELETE"])
def user_detail(request, user_id):
    if user_id != request.user.user_id:
        require_staff(request)
    user = get_object_or_404(User, pk=user_id)
    if request.method == "DELETE":
        user.delete()
        return Response({"deleted": user_id})
    d = request.data
    username = (d.get("username") or user.username).strip()
    check_username(username, exclude_id=user.user_id)
    user.username = username
    user.user_contact = text(d.get("user_contact"))
    user.dob = iso_date(d.get("dob"), "dob", required=False)
    user.save(update_fields=["username", "user_contact", "dob"])
    return Response(profile(user))


# ---------------------------------------------------------------- catalogue


def food_json(f):
    return {"food_id": f.food_id, "name": f.name, "food_type": f.food_type,
            "calories_per_serving": f.calories_per_serving, "times_logged": getattr(f, "times_logged", 0)}


def burn_json(b):
    return {"burn_id": b.burn_id, "burn_name": b.burn_name, "burn_type": b.burn_type,
            "calories_per_min": b.calories_per_min, "times_logged": getattr(b, "times_logged", 0)}


@api_view(["GET", "POST"])
def foods(request):
    if request.method == "GET":
        qs = Food.objects.annotate(times_logged=Count("logged")).order_by("food_type", "name")
        return Response([food_json(f) for f in qs])
    require_staff(request)
    d = request.data
    f = Food.objects.create(name=required_text(d.get("name"), "name"), food_type=choice(d.get("food_type"), FOOD_TYPES, "food_type"),
                            calories_per_serving=number(d.get("calories_per_serving"), "calories_per_serving", int))
    return Response(food_json(f), status=status.HTTP_201_CREATED)


@api_view(["PUT", "DELETE"])
def food_detail(request, food_id):
    require_staff(request)
    f = get_object_or_404(Food, pk=food_id)
    if request.method == "DELETE":
        f.delete()
        return Response({"deleted": food_id})
    d = request.data
    f.name = required_text(d.get("name"), "name")
    f.food_type = choice(d.get("food_type"), FOOD_TYPES, "food_type")
    f.calories_per_serving = number(d.get("calories_per_serving"), "calories_per_serving", int)
    f.save()
    return Response(food_json(f))


@api_view(["GET", "POST"])
def burns(request):
    if request.method == "GET":
        qs = Burn.objects.annotate(times_logged=Count("logged")).order_by("burn_type", "burn_name")
        return Response([burn_json(b) for b in qs])
    require_staff(request)
    d = request.data
    b = Burn.objects.create(burn_name=required_text(d.get("burn_name"), "burn_name"), burn_type=choice(d.get("burn_type"), BURN_TYPES, "burn_type"),
                            calories_per_min=number(d.get("calories_per_min"), "calories_per_min"))
    return Response(burn_json(b), status=status.HTTP_201_CREATED)


@api_view(["PUT", "DELETE"])
def burn_detail(request, burn_id):
    require_staff(request)
    b = get_object_or_404(Burn, pk=burn_id)
    if request.method == "DELETE":
        b.delete()
        return Response({"deleted": burn_id})
    d = request.data
    b.burn_name = required_text(d.get("burn_name"), "burn_name")
    b.burn_type = choice(d.get("burn_type"), BURN_TYPES, "burn_type")
    b.calories_per_min = number(d.get("calories_per_min"), "calories_per_min")
    b.save()
    return Response(burn_json(b))


# ---------------------------------------------------------------- a single day


@api_view(["GET"])
def day(request):
    user = target_user(request)
    when = iso_date(request.query_params.get("date"), "date")
    result = {"daily_id": None, "date": when, "foods": [], "burns": [],
              "calories_in": 0, "calories_out": 0, "net_calories": 0}

    record = DailyRecord.objects.filter(user=user, record_date=when).first()
    if record is None:
        return Response(result)
    result["daily_id"] = record.daily_id

    result["foods"] = list(
        DailyFood.objects.filter(daily=record)
        .annotate(name=F("food__name"), food_type=F("food__food_type"),
                  calories_per_serving=F("food__calories_per_serving"),
                  calories=F("servings") * F("food__calories_per_serving"))
        .order_by("food__food_type", "food__name")
        .values("food_id", "name", "food_type", "servings", "calories_per_serving", "calories"))
    result["burns"] = list(
        DailyBurn.objects.filter(daily=record)
        .annotate(burn_name=F("burn__burn_name"), burn_type=F("burn__burn_type"),
                  calories_per_min=F("burn__calories_per_min"),
                  calories=F("duration_min") * F("burn__calories_per_min"))
        .order_by("burn__burn_name")
        .values("burn_id", "burn_name", "burn_type", "duration_min", "calories_per_min", "calories"))

    totals = rows("SELECT calories_in, calories_out, net_calories FROM vw_daily_summary WHERE daily_id = %s",
                  [record.daily_id])
    if totals:
        result.update(totals[0])
    return Response(result)


def day_record(user, when):
    """The Daily_Record for user + date, created on the first entry of the day."""
    record, _ = DailyRecord.objects.get_or_create(user=user, record_date=when)
    return record


@api_view(["POST", "PUT", "DELETE"])
def day_food(request):
    d = request.data if request.method != "DELETE" else request.query_params

    if request.method == "POST":
        user = target_user(request)
        record = day_record(user, iso_date(d.get("date"), "date"))
        get_object_or_404(Food, pk=number(d.get("food_id"), "food_id", int))
        # the same food twice on one day adds to the servings (business rule)
        with connection.cursor() as cur:
            cur.execute(
                "INSERT INTO Daily_Food (daily_id, food_id, servings) VALUES (%s, %s, %s) "
                "ON DUPLICATE KEY UPDATE servings = servings + VALUES(servings)",
                [record.daily_id, number(d.get("food_id"), "food_id", int), number(d.get("servings"), "servings")])
        return Response({"daily_id": record.daily_id}, status=status.HTTP_201_CREATED)

    record = own_day(request, d.get("daily_id"))
    entries = DailyFood.objects.filter(daily=record, food_id=number(d.get("food_id"), "food_id", int))
    if request.method == "PUT":
        changed = entries.update(servings=number(d.get("servings"), "servings"))
    else:
        changed, _ = entries.delete()
    if not changed:
        raise NotFound("That food is not in this day's log.")
    return Response({"daily_id": record.daily_id})


@api_view(["POST", "PUT", "DELETE"])
def day_burn(request):
    d = request.data if request.method != "DELETE" else request.query_params

    if request.method == "POST":
        user = target_user(request)
        record = day_record(user, iso_date(d.get("date"), "date"))
        get_object_or_404(Burn, pk=number(d.get("burn_id"), "burn_id", int))
        with connection.cursor() as cur:
            cur.execute(
                "INSERT INTO Daily_Burn (daily_id, burn_id, duration_min) VALUES (%s, %s, %s) "
                "ON DUPLICATE KEY UPDATE duration_min = duration_min + VALUES(duration_min)",
                [record.daily_id, number(d.get("burn_id"), "burn_id", int), number(d.get("duration_min"), "duration_min", int)])
        return Response({"daily_id": record.daily_id}, status=status.HTTP_201_CREATED)

    record = own_day(request, d.get("daily_id"))
    entries = DailyBurn.objects.filter(daily=record, burn_id=number(d.get("burn_id"), "burn_id", int))
    if request.method == "PUT":
        changed = entries.update(duration_min=number(d.get("duration_min"), "duration_min", int))
    else:
        changed, _ = entries.delete()
    if not changed:
        raise NotFound("That workout is not in this day's log.")
    return Response({"daily_id": record.daily_id})


# ---------------------------------------------------------------- summaries


@api_view(["GET"])
def summary(request):
    user = target_user(request)
    days = number(request.query_params.get("days") or 14, "days", int)
    return Response(rows("""
SELECT s.record_date, s.calories_in, s.calories_out, s.net_calories,
       COALESCE((SELECT SUM(db.duration_min) FROM Daily_Burn db WHERE db.daily_id = s.daily_id), 0) AS minutes
FROM vw_daily_summary s
WHERE s.user_id = %s
  AND s.record_date > CURDATE() - INTERVAL %s DAY
ORDER BY s.record_date""", [user.user_id, days]))


@api_view(["GET"])
def weekly_average(request):
    user = target_user(request)
    return Response(rows("""
SELECT week_start, days_logged,
       ROUND(avg_calories_in, 0)  AS avg_in,
       ROUND(avg_calories_out, 0) AS avg_out,
       ROUND(avg_net_calories, 0) AS avg_net
FROM vw_weekly_average
WHERE user_id = %s
ORDER BY week_start DESC""", [user.user_id]))


@api_view(["GET"])
def stats(request):
    user = target_user(request)
    totals = rows("""
SELECT COUNT(DISTINCT dr.daily_id)       AS days_logged,
       COUNT(db.burn_id)                 AS workouts,
       COALESCE(SUM(db.duration_min), 0) AS active_minutes
FROM Daily_Record dr
LEFT JOIN Daily_Burn db ON db.daily_id = dr.daily_id
WHERE dr.user_id = %s""", [user.user_id])[0]
    top_foods = rows("""
SELECT f.name, SUM(df.servings) AS total_servings
FROM Daily_Food df
JOIN Daily_Record dr ON dr.daily_id = df.daily_id
JOIN Food f ON f.food_id = df.food_id
WHERE dr.user_id = %s
GROUP BY f.food_id, f.name
ORDER BY total_servings DESC
LIMIT 3""", [user.user_id])
    top_burns = rows("""
SELECT b.burn_name, SUM(db.duration_min) AS total_minutes
FROM Daily_Burn db
JOIN Daily_Record dr ON dr.daily_id = db.daily_id
JOIN Burn b ON b.burn_id = db.burn_id
WHERE dr.user_id = %s
GROUP BY b.burn_id, b.burn_name
ORDER BY total_minutes DESC
LIMIT 3""", [user.user_id])
    return Response({"totals": totals, "top_foods": top_foods, "top_burns": top_burns})


@api_view(["GET"])
def leaderboard(request):
    """Calories burnt in the last 7 days by every athlete (staff accounts left out)."""
    return Response(rows("""
SELECT u.user_id, u.username,
       COALESCE(SUM(db.duration_min * b.calories_per_min), 0) AS calories_burnt,
       COALESCE(SUM(db.duration_min), 0) AS minutes,
       RANK() OVER (ORDER BY COALESCE(SUM(db.duration_min * b.calories_per_min), 0) DESC) AS position
FROM Users u
LEFT JOIN Daily_Record dr ON dr.user_id = u.user_id
      AND dr.record_date > CURDATE() - INTERVAL 7 DAY
LEFT JOIN Daily_Burn db ON db.daily_id = dr.daily_id
LEFT JOIN Burn b ON b.burn_id = db.burn_id
WHERE u.is_staff = 0 AND u.is_active = 1
GROUP BY u.user_id, u.username
ORDER BY position, u.username"""))


# ---------------------------------------------------------------- weekly check-ins


@api_view(["GET", "POST"])
def weekly(request):
    user = target_user(request)
    if request.method == "GET":
        return Response(rows("""
SELECT week_id, week_start_date, height_cm, weight_kg,
       ROUND(weight_kg / POW(height_cm / 100, 2), 1) AS bmi,
       weight_kg - LAG(weight_kg) OVER (ORDER BY week_start_date) AS change_kg
FROM Weekly_Record
WHERE user_id = %s
ORDER BY week_start_date""", [user.user_id]))
    d = request.data
    w = WeeklyRecord.objects.create(
        user=user,
        week_start_date=iso_date(d.get("week_start_date"), "week_start_date"),
        height_cm=number(d.get("height_cm"), "height_cm"),
        weight_kg=number(d.get("weight_kg"), "weight_kg"),
    )
    return Response({"week_id": w.week_id}, status=status.HTTP_201_CREATED)


@api_view(["DELETE"])
def weekly_detail(request, week_id):
    w = get_object_or_404(WeeklyRecord, pk=week_id)
    if w.user_id != request.user.user_id:
        require_staff(request)
    w.delete()
    return Response({"deleted": week_id})


# ---------------------------------------------------------------- SQL playground (staff)


@api_view(["GET"])
def sql_log(request):
    require_staff(request)
    return Response(list(sqlcapture.history))


READ_STATEMENTS = ("SELECT", "SHOW", "DESCRIBE", "DESC", "EXPLAIN", "WITH")


@api_view(["POST"])
def run_sql(request):
    """Runs whatever SQL a staff member types into the SQL tab."""
    require_staff(request)
    query = (request.data.get("query") or "").strip().rstrip(";").strip()
    if not query:
        raise ValidationError({"query": ["Type a query first."]})
    with connection.cursor() as cur:
        cur.execute(query)
        if query.split(None, 1)[0].upper() in READ_STATEMENTS and cur.description:
            return Response({"columns": [c[0] for c in cur.description], "rows": [list(r) for r in cur.fetchall()]})
        return Response({"rows_affected": cur.rowcount})
