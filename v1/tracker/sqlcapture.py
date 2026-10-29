"""Shows the SQL behind the site, and gives every API reply the same shape.

* SQLCaptureMiddleware records each statement an /api/ request runs (the
  final SQL with the values filled in), plus a rolling history of the last
  300 for the SQL tab.
* EnvelopeRenderer wraps replies as {"data": ...} or {"error": "..."};
  staff also get "sql": [statements that ran].
* exception_handler turns MySQL errors from constraints and triggers into
  readable messages instead of a 500.
"""

from collections import deque
from datetime import datetime

from django.db import DatabaseError, connection
from django.db.models import ProtectedError, RestrictedError
from rest_framework import status
from rest_framework.exceptions import AuthenticationFailed, NotAuthenticated
from rest_framework.renderers import JSONRenderer
from rest_framework.response import Response

# last statements run by the API, for the SQL tab
history = deque(maxlen=300)

# statements Django runs when it opens a connection, not part of the request's work
CONNECTION_SETUP = ("SELECT VERSION()", "SET SESSION TRANSACTION ISOLATION LEVEL", "SET SQL_AUTO_IS_NULL")


class SQLCaptureMiddleware:
    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        if not request.path.startswith("/api/"):
            return self.get_response(request)

        request.sql = []
        entries = []

        def record(sql, params, context, error=None):
            try:
                text = connection.ops.last_executed_query(context["cursor"], sql, params)
            except Exception:
                text = sql
            text = text.strip()
            if text.startswith(CONNECTION_SETUP):
                return
            request.sql.append(text)
            entries.append({"time": datetime.now().strftime("%H:%M:%S"), "query": text,
                            "error": describe_db_error(error) if error else None})

        def capture(execute, sql, params, many, context):
            try:
                result = execute(sql, params, many, context)
            except Exception as exc:
                record(sql, params, context, exc)
                raise
            record(sql, params, context)
            return result

        with connection.execute_wrapper(capture):
            response = self.get_response(request)

        user = getattr(request, "user", None)
        account = user.username if user is not None and user.is_authenticated else "anonymous"
        for e in entries:
            history.append({**e, "account": account})
        return response


# constraint name in db/01_schema.sql -> what it means to a person
CONSTRAINTS = {
    "uq_users_username": "That username is already taken",
    "uq_food_name": "A food with that name already exists",
    "uq_burn_name": "An exercise with that name already exists",
    "uq_daily_user_date": "That day already has a record",
    "uq_week_user_date": "There is already a check-in for that week",
    "chk_servings_positive": "Servings must be more than 0",
    "chk_duration_positive": "Minutes must be more than 0",
    "chk_food_calories": "Calories can't be negative",
    "chk_burn_calories": "Calories can't be negative",
    "chk_height": "Height must be more than 0",
    "chk_weight": "Weight must be more than 0",
}


def describe_db_error(exc):
    """Friendlier text for the MySQL errors the business rules produce."""
    args = getattr(exc, "args", ())
    if len(args) < 2 or not isinstance(args[0], int):
        return str(exc)
    code, message = args[0], args[1]
    for name, meaning in CONSTRAINTS.items():
        if name in message:
            kind = "UNIQUE" if name.startswith("uq_") else "CHECK"
            return f"{meaning} (MySQL {kind} constraint {name}, error {code})."
    if code == 1062:
        return "Already exists: " + message
    if code == 1451:
        return "Can't delete: it is still used in someone's log (ON DELETE RESTRICT). " + message
    if code in (3819, 4025):
        return "Value breaks a CHECK constraint: " + message
    if code == 1644:  # SIGNAL in a trigger
        return f"{message} (MySQL trigger, error 1644)."

    if code in (1142, 1143, 1044, 1227):
        return f"Permission denied (MySQL error {code}): {message}"
    return f"MySQL error {code}: {message}"


def exception_handler(exc, context):
    # imported here: rest_framework.views reads REST_FRAMEWORK settings that point back at this module
    from rest_framework.views import exception_handler as drf_exception_handler
    from rest_framework.views import set_rollback

    if isinstance(exc, (ProtectedError, RestrictedError)):
        set_rollback()
        used = len(exc.protected_objects if isinstance(exc, ProtectedError) else exc.restricted_objects)
        return Response({"detail": f"Can't delete: {used} logged entries still use it "
                                   "(the foreign key is ON DELETE RESTRICT)."},
                        status=status.HTTP_409_CONFLICT)
    if isinstance(exc, DatabaseError):
        set_rollback()
        return Response({"detail": describe_db_error(exc)}, status=status.HTTP_400_BAD_REQUEST)
    response = drf_exception_handler(exc, context)
    # DRF answers 403 on views without authenticators (login, refresh); a failed sign-in is a 401
    if response is not None and isinstance(exc, (AuthenticationFailed, NotAuthenticated)):
        response.status_code = status.HTTP_401_UNAUTHORIZED
    return response


def error_text(data):
    """Flatten DRF error bodies ({"detail": ...} or {"field": ["msg"]}) to one line."""
    if isinstance(data, dict):
        if "detail" in data:
            return str(data["detail"])
        parts = []
        for field, msgs in data.items():
            msgs = msgs if isinstance(msgs, list) else [msgs]
            text = " ".join(str(m) for m in msgs)
            parts.append(text if field == "non_field_errors" else f"{field.replace('_', ' ').capitalize()}: {text}")
        return " ".join(parts)
    if isinstance(data, list):
        return " ".join(str(d) for d in data)
    return str(data)


class EnvelopeRenderer(JSONRenderer):
    def render(self, data, accepted_media_type=None, renderer_context=None):
        ctx = renderer_context or {}
        response, request = ctx.get("response"), ctx.get("request")
        if response is not None and response.status_code >= 400:
            body = {"error": error_text(data)}
        else:
            body = {"data": data}
        try:
            user = request.user if request is not None else None
        except Exception:  # a bad token on a public endpoint
            user = None
        if user is not None and user.is_authenticated and user.is_staff:
            body["sql"] = getattr(request._request, "sql", [])
        return super().render(body, accepted_media_type, renderer_context)
