"""Stride v1 settings. Every value comes from .env at the project root."""

import os
from datetime import timedelta
from pathlib import Path

from django.urls import reverse_lazy

BASE_DIR = Path(__file__).resolve().parent.parent


def load_env(path):
    """Read KEY=VALUE lines; variables already set in the shell win."""
    if not path.exists():
        return
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip())


load_env(BASE_DIR / ".env")
env = os.environ.get

SECRET_KEY = env("SECRET_KEY", "insecure-dev-key")
DEBUG = env("DEBUG", "true").lower() == "true"
ALLOWED_HOSTS = ["*"]

INSTALLED_APPS = [
    "unfold",  # admin theme, must come before django.contrib.admin
    "unfold.contrib.filters",
    "django.contrib.admin",
    "django.contrib.auth",
    "django.contrib.contenttypes",
    "django.contrib.sessions",
    "django.contrib.messages",
    "django.contrib.staticfiles",
    "django.contrib.humanize",
    "rest_framework",
    "tracker",
]

MIDDLEWARE = [
    "django.middleware.security.SecurityMiddleware",
    "django.contrib.sessions.middleware.SessionMiddleware",
    "django.middleware.common.CommonMiddleware",
    "django.middleware.csrf.CsrfViewMiddleware",
    "django.contrib.auth.middleware.AuthenticationMiddleware",
    "django.contrib.messages.middleware.MessageMiddleware",
    "django.middleware.clickjacking.XFrameOptionsMiddleware",
    "tracker.sqlcapture.SQLCaptureMiddleware",
]

ROOT_URLCONF = "stride.urls"
WSGI_APPLICATION = "stride.wsgi.application"

TEMPLATES = [
    {
        "BACKEND": "django.template.backends.django.DjangoTemplates",
        "DIRS": [BASE_DIR / "templates"],  # admin dashboard override
        "APP_DIRS": True,
        "OPTIONS": {
            "context_processors": [
                "django.template.context_processors.request",
                "django.contrib.auth.context_processors.auth",
                "django.contrib.messages.context_processors.messages",
            ],
        },
    },
]

# MySQL / MariaDB. The tables of the tracker app are created by db/01_schema.sql,
# not by migrations (their models are managed = False).
DATABASES = {
    "default": {
        "ENGINE": "django.db.backends.mysql",
        "NAME": env("DB_NAME", "fitness_tracker_v1"),
        "USER": env("DB_USER", "stride_app"),
        "PASSWORD": env("DB_PASSWORD", ""),
        "HOST": env("DB_HOST", "127.0.0.1"),
        "PORT": env("DB_PORT", "3306"),
        "OPTIONS": {"charset": "utf8mb4"},
        # every API request is one transaction: a failed step undoes the earlier ones
        "ATOMIC_REQUESTS": True,
        "CONN_MAX_AGE": 60,
    }
}

# Users (the Users table) is also the login table
AUTH_USER_MODEL = "tracker.User"

AUTH_PASSWORD_VALIDATORS = [
    {"NAME": "django.contrib.auth.password_validation.UserAttributeSimilarityValidator"},
    {"NAME": "django.contrib.auth.password_validation.MinimumLengthValidator", "OPTIONS": {"min_length": 8}},
    {"NAME": "django.contrib.auth.password_validation.CommonPasswordValidator"},
    {"NAME": "django.contrib.auth.password_validation.NumericPasswordValidator"},
]

LANGUAGE_CODE = "en-gb"
TIME_ZONE = env("TIME_ZONE", "Asia/Kolkata")
USE_I18N = True
# plain local DATETIMEs, so the values in Workbench match what the site shows
USE_TZ = False

STATIC_URL = "static/"
DEFAULT_AUTO_FIELD = "django.db.models.AutoField"

# the website (plain HTML/CSS/JS) lives in web/ and is served by Django
WEB_DIR = BASE_DIR / "web"

# ---------------------------------------------------------------- REST + JWT
REST_FRAMEWORK = {
    "DEFAULT_AUTHENTICATION_CLASSES": ["rest_framework_simplejwt.authentication.JWTAuthentication"],
    "DEFAULT_PERMISSION_CLASSES": ["rest_framework.permissions.IsAuthenticated"],
    "DEFAULT_RENDERER_CLASSES": ["tracker.sqlcapture.EnvelopeRenderer"],
    "DEFAULT_PARSER_CLASSES": ["rest_framework.parsers.JSONParser"],
    "EXCEPTION_HANDLER": "tracker.sqlcapture.exception_handler",
}

SIMPLE_JWT = {
    "ACCESS_TOKEN_LIFETIME": timedelta(minutes=int(env("JWT_ACCESS_MINUTES", "15"))),
    "REFRESH_TOKEN_LIFETIME": timedelta(days=int(env("JWT_REFRESH_DAYS", "7"))),
    "SIGNING_KEY": SECRET_KEY,
    "ALGORITHM": "HS256",
    "AUTH_HEADER_TYPES": ("Bearer",),
    "USER_ID_FIELD": "user_id",
    "USER_ID_CLAIM": "user_id",
    "UPDATE_LAST_LOGIN": True,
}

# ---------------------------------------------------------------- admin theme
UNFOLD = {
    "SITE_TITLE": "Stride admin",
    "SITE_HEADER": "Stride",
    "SITE_SUBHEADER": "fitness_tracker_v1",
    "SITE_URL": "/",
    "SITE_SYMBOL": "directions_run",
    "SHOW_HISTORY": True,
    "SHOW_VIEW_ON_SITE": False,
    "DASHBOARD_CALLBACK": "tracker.admin.dashboard_callback",
    "COLORS": {
        "primary": {  # burnt orange, same as the website
            "50": "253 244 238", "100": "246 227 214", "200": "236 196 172",
            "300": "222 156 122", "400": "195 111 78", "500": "156 66 33",
            "600": "137 57 28", "700": "122 51 25", "800": "98 41 20",
            "900": "74 51 38", "950": "45 25 15",
        },
    },
    "SIDEBAR": {
        "show_search": True,
        "show_all_applications": False,
        "navigation": [
            {
                "title": "Overview",
                "items": [
                    {"title": "Dashboard", "icon": "space_dashboard", "link": reverse_lazy("admin:index")},
                    {"title": "Open the website", "icon": "open_in_new", "link": "/#today", "active": False},
                ],
            },
            {
                "title": "People",
                "items": [
                    {"title": "Users", "icon": "group", "link": reverse_lazy("admin:tracker_user_changelist")},
                    {"title": "Weekly check-ins", "icon": "monitor_weight", "link": reverse_lazy("admin:tracker_weeklyrecord_changelist")},
                ],
            },
            {
                "title": "Logs",
                "items": [
                    {"title": "Daily records", "icon": "calendar_month", "link": reverse_lazy("admin:tracker_dailyrecord_changelist")},
                    {"title": "Food log", "icon": "restaurant", "link": reverse_lazy("admin:tracker_foodlogentry_changelist")},
                    {"title": "Workout log", "icon": "fitness_center", "link": reverse_lazy("admin:tracker_burnlogentry_changelist")},
                    {"title": "Daily summary (view)", "icon": "query_stats", "link": reverse_lazy("admin:tracker_dailysummary_changelist")},
                ],
            },
            {
                "title": "Catalogue",
                "items": [
                    {"title": "Foods", "icon": "nutrition", "link": reverse_lazy("admin:tracker_food_changelist")},
                    {"title": "Exercises", "icon": "sprint", "link": reverse_lazy("admin:tracker_burn_changelist")},
                ],
            },
        ],
    },
}
