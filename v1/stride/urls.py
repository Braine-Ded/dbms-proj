from django.conf import settings
from django.contrib import admin
from django.urls import include, path, re_path
from django.views.decorators.cache import never_cache
from django.views.static import serve

# no browser caching, so a changed app.js / style.css shows up on the next reload
serve = never_cache(serve)

urlpatterns = [
    path("admin/", admin.site.urls),
    path("api/", include("tracker.urls")),
    # the website: one HTML page plus its CSS, JS and images
    path("", serve, {"path": "index.html", "document_root": settings.WEB_DIR}),
    re_path(r"^(?P<path>(?:app\.js|style\.css))$", serve, {"document_root": settings.WEB_DIR}),
]
