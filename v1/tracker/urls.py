from django.urls import path

from . import api

urlpatterns = [
    path("register", api.register),
    path("login", api.login),
    path("token/refresh", api.refresh),
    path("logout", api.logout),
    path("me", api.me),
    path("me/password", api.change_password),

    path("today", api.today),

    path("users", api.users),
    path("users/<int:user_id>", api.user_detail),

    path("foods", api.foods),
    path("foods/<int:food_id>", api.food_detail),
    path("burns", api.burns),
    path("burns/<int:burn_id>", api.burn_detail),

    path("day", api.day),
    path("day/food", api.day_food),
    path("day/burn", api.day_burn),

    path("summary", api.summary),
    path("weekly-average", api.weekly_average),
    path("stats", api.stats),
    path("leaderboard", api.leaderboard),

    path("weekly", api.weekly),
    path("weekly/<int:week_id>", api.weekly_detail),

    path("sqllog", api.sql_log),
    path("sql", api.run_sql),
]
