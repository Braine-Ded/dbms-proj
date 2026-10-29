from django.conf import settings
from django.contrib import admin
from django.urls import include, path, re_path
from django.views.static import serve

urlpatterns = [
    path("admin/", admin.site.urls),
    path("api/", include("tracker.urls")),
    # the website: one HTML page plus its CSS, JS and images
    path("", serve, {"path": "index.html", "document_root": settings.WEB_DIR}),
    re_path(r"^(?P<path>(?:app\.js|style\.css))$", serve, {"document_root": settings.WEB_DIR}),
]
