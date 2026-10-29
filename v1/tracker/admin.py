"""Admin panel (django-unfold theme) for browsing and editing every table.

Who may do what follows Users.role (see User.has_perm): admins add, change
and delete; clerks only view and add, and don't see password hashes.

Daily_Food and Daily_Burn have composite primary keys, which the Django
admin can't edit, so their rows are shown through the read-only views
vw_food_log / vw_burn_log (and on each daily record's page).
"""

import json
from datetime import date, timedelta

from django import forms
from django.contrib import admin
from django.contrib.auth.models import Group
from django.db import connection
from django.db.models import Count, OuterRef, Subquery
from django.db.models.functions import Coalesce
from django.urls import reverse
from django.utils.html import format_html, format_html_join
from unfold.admin import ModelAdmin, TabularInline
from unfold.contrib.filters.admin import ChoicesDropdownFilter, RangeDateFilter, RelatedDropdownFilter
from unfold.decorators import display
from unfold.widgets import UnfoldAdminPasswordWidget

from .models import (
    Burn, BurnLogEntry, DailyBurn, DailyFood, DailyRecord, DailySummary, Food, FoodLogEntry, User, WeeklyRecord,
)

admin.site.unregister(Group)  # permissions come from Users.role, groups are not used


def kcal(value):
    return f"{round(float(value or 0)):,}"


def short_date(value, rest=""):
    """'5 Mar' plus the rest of the format; %-d isn't supported on Windows."""
    return f"{value.day} {value.strftime('%b' + rest)}"


def changelist(model, **filters):
    url = reverse(f"admin:tracker_{model}_changelist")
    return url + ("?" + "&".join(f"{k}={v}" for k, v in filters.items()) if filters else "")


class ReadOnlyAdmin(ModelAdmin):
    """For the SQL views: browse, filter and search, but never write."""

    def has_add_permission(self, request):
        return False

    def has_change_permission(self, request, obj=None):
        return False

    def has_delete_permission(self, request, obj=None):
        return False


# ---------------------------------------------------------------- users


class UserForm(forms.ModelForm):
    new_password = forms.CharField(
        label="Set password", required=False, widget=UnfoldAdminPasswordWidget(render_value=False),
        help_text="Stored as a PBKDF2 hash in Users.password. Leave empty to keep the current one.",
    )

    class Meta:
        model = User
        fields = ["username", "user_contact", "dob", "role", "is_active"]

    def clean(self):
        data = super().clean()
        if not self.instance.pk and not data.get("new_password"):
            self.add_error("new_password", "A new user needs a password.")
        return data

    def save(self, commit=True):
        user = super().save(commit=False)
        if self.cleaned_data.get("new_password"):
            user.set_password(self.cleaned_data["new_password"])
        if commit:
            user.save()
        return user


class WeeklyInline(TabularInline):
    model = WeeklyRecord
    extra = 0
    fields = ["week_start_date", "height_cm", "weight_kg", "bmi_value"]
    readonly_fields = ["bmi_value"]
    ordering = ["-week_start_date"]
    tab = True

    @display(description="BMI")
    def bmi_value(self, obj):
        return obj.bmi if obj.pk else "-"


@admin.register(User)
class UserAdmin(ModelAdmin):
    form = UserForm
    inlines = [WeeklyInline]
    list_display = ["username", "role_label", "user_contact", "age_years", "days_logged", "check_ins", "joined", "last_sign_in", "is_active"]
    list_display_links = ["username"]
    list_filter = ["role", "is_active", ("date_joined", RangeDateFilter)]
    list_filter_submit = True
    search_fields = ["username", "user_contact"]
    ordering = ["user_id"]
    readonly_fields = ["user_id", "password_hash", "date_joined", "last_login", "activity"]
    fieldsets = [
        ("Profile", {"fields": ["user_id", "username", "user_contact", "dob"]}),
        ("Sign-in", {"fields": ["new_password", "password_hash", "is_active", "role"]}),
        ("Activity", {"fields": ["date_joined", "last_login", "activity"]}),
    ]

    def get_fieldsets(self, request, obj=None):
        if request.user.is_admin:
            return self.fieldsets
        # clerks: no password hash, and new users are always athletes
        return [(name, {"fields": [f for f in opts["fields"] if f != "password_hash"]})
                for name, opts in self.fieldsets]

    def get_readonly_fields(self, request, obj=None):
        return self.readonly_fields + ([] if request.user.is_admin else ["role"])

    def get_queryset(self, request):
        return super().get_queryset(request).annotate(
            n_days=Count("days", distinct=True), n_weeks=Count("weeks", distinct=True))

    @display(description="Role", label={"Admin": "danger", "Clerk": "warning", "Athlete": "primary"}, ordering="role")
    def role_label(self, obj):
        return obj.get_role_display()

    @display(description="Joined", ordering="date_joined")
    def joined(self, obj):
        return short_date(obj.date_joined, " %y")

    @display(description="Last sign-in", ordering="last_login")
    def last_sign_in(self, obj):
        return short_date(obj.last_login, " %H:%M") if obj.last_login else "never"

    @display(description="Age", ordering="dob")
    def age_years(self, obj):
        return obj.age if obj.age is not None else "-"

    @display(description="Days logged", ordering="n_days")
    def days_logged(self, obj):
        return obj.n_days

    @display(description="Check-ins", ordering="n_weeks")
    def check_ins(self, obj):
        return obj.n_weeks

    @display(description="Password hash")
    def password_hash(self, obj):
        return format_html("<code style='word-break:break-all'>{}</code>", obj.password or "-")

    @display(description="Logs")
    def activity(self, obj):
        if not obj.pk:
            return "-"
        links = [
            (changelist("dailyrecord", user__user_id__exact=obj.pk), f"{obj.days.count()} daily records"),
            (changelist("foodlogentry", user__user_id__exact=obj.pk), f"{FoodLogEntry.objects.filter(user=obj).count()} foods logged"),
            (changelist("burnlogentry", user__user_id__exact=obj.pk), f"{BurnLogEntry.objects.filter(user=obj).count()} workouts logged"),
            (changelist("dailysummary", user__user_id__exact=obj.pk), "calorie summary"),
        ]
        return format_html_join(" · ", "<a class='text-primary-600' href='{}'>{}</a>", links)


# ---------------------------------------------------------------- catalogue


@admin.register(Food)
class FoodAdmin(ModelAdmin):
    list_display = ["name", "type_label", "calories_per_serving", "times_logged"]
    list_filter = [("food_type", ChoicesDropdownFilter)]
    list_filter_submit = True
    search_fields = ["name"]
    readonly_fields = ["food_id"]
    fields = ["food_id", "name", "food_type", "calories_per_serving"]

    def get_queryset(self, request):
        return super().get_queryset(request).annotate(n_logged=Count("logged"))

    @display(description="Type", label=True, ordering="food_type")
    def type_label(self, obj):
        return obj.food_type

    @display(description="Times logged", ordering="n_logged")
    def times_logged(self, obj):
        return obj.n_logged


@admin.register(Burn)
class BurnAdmin(ModelAdmin):
    list_display = ["burn_name", "type_label", "calories_per_min", "times_logged"]
    list_filter = [("burn_type", ChoicesDropdownFilter)]
    list_filter_submit = True
    search_fields = ["burn_name"]
    readonly_fields = ["burn_id"]
    fields = ["burn_id", "burn_name", "burn_type", "calories_per_min"]

    def get_queryset(self, request):
        return super().get_queryset(request).annotate(n_logged=Count("logged"))

    @display(description="Type", label=True, ordering="burn_type")
    def type_label(self, obj):
        return obj.burn_type

    @display(description="Times logged", ordering="n_logged")
    def times_logged(self, obj):
        return obj.n_logged


# ---------------------------------------------------------------- logs


def summary_column(name):
    return Subquery(DailySummary.objects.filter(daily_id=OuterRef("pk")).values(name)[:1])


def entries_of(model, column):
    """Rows of Daily_Food / Daily_Burn for the day (their composite PK can't be COUNTed directly)."""
    per_day = model.objects.filter(daily_id=OuterRef("pk")).order_by().values("daily_id").annotate(n=Count(column))
    return Coalesce(Subquery(per_day.values("n")[:1]), 0)


def entries_table(headers, rows):
    head = format_html_join("", "<th style='text-align:left;padding:4px 12px 4px 0'>{}</th>", ((h,) for h in headers))
    body = format_html_join("", "<tr>" + "<td style='padding:4px 12px 4px 0'>{}</td>" * len(headers) + "</tr>", rows)
    if not rows:
        return "Nothing logged."
    return format_html("<table><thead><tr>{}</tr></thead><tbody>{}</tbody></table>", head, body)


@admin.register(DailyRecord)
class DailyRecordAdmin(ModelAdmin):
    list_display = ["record_date", "user", "kcal_in", "kcal_out", "kcal_net", "n_foods", "n_burns"]
    list_filter = [("user", RelatedDropdownFilter), ("record_date", RangeDateFilter)]
    list_filter_submit = True
    search_fields = ["user__username"]
    list_select_related = ["user"]
    readonly_fields = ["daily_id", "foods_eaten", "workouts_done", "totals"]
    fields = ["daily_id", "user", "record_date", "totals", "foods_eaten", "workouts_done"]

    def get_queryset(self, request):
        return super().get_queryset(request).annotate(
            c_in=summary_column("calories_in"), c_out=summary_column("calories_out"),
            c_net=summary_column("net_calories"),
            foods_n=entries_of(DailyFood, "food_id"), burns_n=entries_of(DailyBurn, "burn_id"))

    @display(description="kcal in", ordering="c_in")
    def kcal_in(self, obj):
        return kcal(obj.c_in)

    @display(description="kcal out", ordering="c_out")
    def kcal_out(self, obj):
        return kcal(obj.c_out)

    @display(description="Net", ordering="c_net")
    def kcal_net(self, obj):
        return ("+" if (obj.c_net or 0) > 0 else "") + kcal(obj.c_net)

    @display(description="Foods", ordering="foods_n")
    def n_foods(self, obj):
        return obj.foods_n

    @display(description="Workouts", ordering="burns_n")
    def n_burns(self, obj):
        return obj.burns_n

    @display(description="Foods eaten (Daily_Food)")
    def foods_eaten(self, obj):
        rows = [(f.food.name, f.food.food_type, f.servings, kcal(f.servings * f.food.calories_per_serving))
                for f in obj.foods.select_related("food").order_by("food__name")] if obj.pk else []
        return entries_table(["Food", "Type", "Servings", "kcal"], rows)

    @display(description="Workouts (Daily_Burn)")
    def workouts_done(self, obj):
        rows = [(b.burn.burn_name, b.burn.burn_type, b.duration_min, kcal(b.duration_min * b.burn.calories_per_min))
                for b in obj.burns.select_related("burn").order_by("burn__burn_name")] if obj.pk else []
        return entries_table(["Exercise", "Type", "Minutes", "kcal"], rows)

    @display(description="Totals (vw_daily_summary)")
    def totals(self, obj):
        s = DailySummary.objects.filter(daily_id=obj.pk).first() if obj.pk else None
        if not s:
            return "-"
        return f"{kcal(s.calories_in)} in, {kcal(s.calories_out)} out, net {kcal(s.net_calories)} kcal"


@admin.register(WeeklyRecord)
class WeeklyRecordAdmin(ModelAdmin):
    list_display = ["week_start_date", "user", "height_cm", "weight_kg", "bmi_value"]
    list_filter = [("user", RelatedDropdownFilter), ("week_start_date", RangeDateFilter)]
    list_filter_submit = True
    search_fields = ["user__username"]
    list_select_related = ["user"]

    @display(description="BMI")
    def bmi_value(self, obj):
        return obj.bmi


@admin.register(DailySummary)
class DailySummaryAdmin(ReadOnlyAdmin):
    list_display = ["record_date", "username", "kcal_in", "kcal_out", "kcal_net"]
    list_filter = [("user", RelatedDropdownFilter), ("record_date", RangeDateFilter)]
    list_filter_submit = True
    search_fields = ["username"]

    @display(description="kcal in", ordering="calories_in")
    def kcal_in(self, obj):
        return kcal(obj.calories_in)

    @display(description="kcal out", ordering="calories_out")
    def kcal_out(self, obj):
        return kcal(obj.calories_out)

    @display(description="Net", ordering="net_calories")
    def kcal_net(self, obj):
        return ("+" if obj.net_calories > 0 else "") + kcal(obj.net_calories)


@admin.register(FoodLogEntry)
class FoodLogAdmin(ReadOnlyAdmin):
    list_display = ["record_date", "username", "food_name", "food_type", "servings", "calories_per_serving", "kcal_total"]
    list_filter = [("user", RelatedDropdownFilter), ("food_type", ChoicesDropdownFilter), ("record_date", RangeDateFilter)]
    list_filter_submit = True
    search_fields = ["username", "food_name"]

    @display(description="kcal", ordering="calories")
    def kcal_total(self, obj):
        return kcal(obj.calories)


@admin.register(BurnLogEntry)
class BurnLogAdmin(ReadOnlyAdmin):
    list_display = ["record_date", "username", "burn_name", "burn_type", "duration_min", "calories_per_min", "kcal_total"]
    list_filter = [("user", RelatedDropdownFilter), ("burn_type", ChoicesDropdownFilter), ("record_date", RangeDateFilter)]
    list_filter_submit = True
    search_fields = ["username", "burn_name"]

    @display(description="kcal", ordering="calories")
    def kcal_total(self, obj):
        return kcal(obj.calories)


# ---------------------------------------------------------------- dashboard


def query(sql, params=()):
    with connection.cursor() as cur:
        cur.execute(sql, params)
        return cur.fetchall()


def dashboard_callback(request, context):
    today = date.today()
    week_ago = today - timedelta(days=7)
    athletes = User.objects.filter(is_staff=False)

    kpis = [
        ("Athletes", athletes.count(), f"{athletes.filter(date_joined__date__gte=week_ago).count()} joined this week", "group"),
        ("Active this week", DailyRecord.objects.filter(record_date__gt=week_ago).values("user").distinct().count(),
         "logged at least one day", "directions_run"),
        ("Days logged", DailyRecord.objects.count(), f"{DailyRecord.objects.filter(record_date=today).count()} today", "calendar_month"),
        ("Foods logged", DailyFood.objects.count(), f"{Food.objects.count()} foods in the catalogue", "restaurant"),
        ("Workouts logged", DailyBurn.objects.count(), f"{Burn.objects.count()} exercises in the catalogue", "fitness_center"),
    ]

    # calories eaten vs burnt by everyone, last 14 days
    days = [today - timedelta(days=i) for i in range(13, -1, -1)]
    per_day = {d: (i, o) for d, i, o in query(
        "SELECT record_date, SUM(calories_in), SUM(calories_out) FROM vw_daily_summary "
        "WHERE record_date > CURDATE() - INTERVAL 14 DAY GROUP BY record_date")}
    chart = {
        "labels": [d.strftime("%d %b") for d in days],
        "datasets": [
            {"label": "Eaten (kcal)", "data": [float(per_day.get(d, (0, 0))[0] or 0) for d in days],
             "backgroundColor": "#D4A017", "borderRadius": 3, "maxBarThickness": 18},
            {"label": "Burnt (kcal)", "data": [float(per_day.get(d, (0, 0))[1] or 0) for d in days],
             "backgroundColor": "#9C4221", "borderRadius": 3, "maxBarThickness": 18},
        ],
    }
    # passing options replaces Unfold's defaults (thin overlapping bars, no y axis), so give them all
    chart_options = {
        "responsive": True, "maintainAspectRatio": False, "animation": False,
        "categoryPercentage": 0.7, "barPercentage": 0.9,
        "plugins": {"legend": {"display": True, "position": "top", "align": "end",
                               "labels": {"usePointStyle": True, "boxWidth": 8}}},
        "scales": {
            "x": {"grid": {"display": False}},
            "y": {"beginAtZero": True, "grid": {"color": "rgba(156, 66, 33, .08)"},
                  "ticks": {"maxTicksLimit": 6}},
        },
    }

    leaders = query("""
SELECT u.username, COALESCE(SUM(db.duration_min * b.calories_per_min), 0) AS kcal, COALESCE(SUM(db.duration_min), 0)
FROM Users u
LEFT JOIN Daily_Record dr ON dr.user_id = u.user_id AND dr.record_date > CURDATE() - INTERVAL 7 DAY
LEFT JOIN Daily_Burn db ON db.daily_id = dr.daily_id
LEFT JOIN Burn b ON b.burn_id = db.burn_id
WHERE u.is_staff = 0
GROUP BY u.user_id, u.username ORDER BY kcal DESC LIMIT 5""")
    top_foods = query("""
SELECT f.name, f.food_type, COUNT(*) AS times, SUM(df.servings * f.calories_per_serving) AS kcal
FROM Daily_Food df JOIN Food f ON f.food_id = df.food_id
GROUP BY f.food_id, f.name, f.food_type ORDER BY times DESC LIMIT 5""")
    newest = User.objects.order_by("-date_joined")[:5]

    context.update({
        "kpis": kpis,
        "chart": json.dumps(chart),
        "chart_options": json.dumps(chart_options),
        "leaders": {"headers": ["Athlete", "kcal burnt", "Min"],
                    "rows": [[n, kcal(k), int(m)] for n, k, m in leaders]},
        "top_foods": {"headers": ["Food", "Logged", "kcal"],
                      "rows": [[n, c, kcal(k)] for n, t, c, k in top_foods]},
        "newest": {"headers": ["Username", "Joined", "Last sign-in"],
                   "rows": [[u.username, short_date(u.date_joined),
                             short_date(u.last_login, " %H:%M") if u.last_login else "never"] for u in newest]},
    })
    return context
