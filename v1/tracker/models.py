"""Models mapped onto the tables and views of db/01_schema.sql.

Every model is managed = False: the SQL files own the schema (constraints,
triggers, views) and Django only reads and writes rows. The on_delete rules
mirror the foreign keys in the SQL, so the admin can show what a delete
will take with it.
"""

from datetime import date, datetime

from django.contrib.auth.base_user import AbstractBaseUser, BaseUserManager
from django.core.exceptions import ValidationError
from django.core.validators import MinValueValidator
from django.db import models

FOOD_TYPES = ["Breakfast", "Grain", "Protein", "Dairy", "Fruit", "Vegetable", "Snack", "Beverage", "Dessert", "Fast Food"]
BURN_TYPES = ["Cardio", "Strength", "Flexibility", "Sports", "Outdoor"]


# The same rules the SQL enforces (triggers, CHECKs), repeated here so admin
# forms show a message instead of a database error. The API relies on MySQL.
def not_in_future(value):
    if value > date.today():
        raise ValidationError("Can't be in the future.")


def positive(value):
    if value <= 0:
        raise ValidationError("Must be more than 0.")


class UserManager(BaseUserManager):
    def create_user(self, username, password=None, **fields):
        user = self.model(username=username, **fields)
        user.set_password(password)
        user.save(using=self._db)
        return user

    def create_superuser(self, username, password=None, **fields):
        return self.create_user(username, password, is_staff=True, **fields)


class User(AbstractBaseUser):
    """Users: an athlete and their login. is_staff may open the admin panel."""

    user_id = models.AutoField(primary_key=True)
    username = models.CharField(max_length=50, unique=True)
    user_contact = models.CharField("contact", max_length=100, blank=True, null=True)
    dob = models.DateField("date of birth", blank=True, null=True, validators=[not_in_future])
    is_staff = models.BooleanField("staff", default=False)
    is_active = models.BooleanField("active", default=True)
    date_joined = models.DateTimeField(default=datetime.now)
    # password and last_login come from AbstractBaseUser

    objects = UserManager()

    USERNAME_FIELD = "username"
    REQUIRED_FIELDS = []

    class Meta:
        managed = False
        db_table = "Users"
        ordering = ["user_id"]

    def __str__(self):
        return self.username

    @property
    def age(self):
        if not self.dob:
            return None
        today = date.today()
        return today.year - self.dob.year - ((today.month, today.day) < (self.dob.month, self.dob.day))

    # staff are the admins: no per-model permission tables needed
    @property
    def is_superuser(self):
        return self.is_staff

    def has_perm(self, perm, obj=None):
        return self.is_active and self.is_staff

    def has_perms(self, perms, obj=None):
        return self.is_active and self.is_staff

    def has_module_perms(self, app_label):
        return self.is_active and self.is_staff


class Food(models.Model):
    food_id = models.AutoField(primary_key=True)
    name = models.CharField(max_length=100, unique=True)
    food_type = models.CharField(max_length=20, choices=[(t, t) for t in FOOD_TYPES])
    calories_per_serving = models.IntegerField("kcal per serving", validators=[MinValueValidator(0)])

    class Meta:
        managed = False
        db_table = "Food"
        ordering = ["food_type", "name"]
        verbose_name = "food"

    def __str__(self):
        return self.name


class Burn(models.Model):
    burn_id = models.AutoField(primary_key=True)
    burn_name = models.CharField("exercise", max_length=100, unique=True)
    burn_type = models.CharField("type", max_length=20, choices=[(t, t) for t in BURN_TYPES])
    calories_per_min = models.DecimalField("kcal per minute", max_digits=6, decimal_places=2, validators=[MinValueValidator(0)])

    class Meta:
        managed = False
        db_table = "Burn"
        ordering = ["burn_type", "burn_name"]
        verbose_name = "exercise"

    def __str__(self):
        return self.burn_name


class DailyRecord(models.Model):
    daily_id = models.AutoField(primary_key=True)
    user = models.ForeignKey(User, models.CASCADE, db_column="user_id", related_name="days")
    record_date = models.DateField("date", validators=[not_in_future])

    class Meta:
        managed = False
        db_table = "Daily_Record"
        unique_together = [("user", "record_date")]
        ordering = ["-record_date", "user"]
        verbose_name = "daily record"

    def __str__(self):
        return f"{self.user} on {self.record_date:%d %b %Y}"


class DailyFood(models.Model):
    pk = models.CompositePrimaryKey("daily_id", "food_id")
    daily = models.ForeignKey(DailyRecord, models.CASCADE, db_column="daily_id", related_name="foods")
    food = models.ForeignKey(Food, models.PROTECT, db_column="food_id", related_name="logged")
    servings = models.DecimalField(max_digits=5, decimal_places=2)

    class Meta:
        managed = False
        db_table = "Daily_Food"


class DailyBurn(models.Model):
    pk = models.CompositePrimaryKey("daily_id", "burn_id")
    daily = models.ForeignKey(DailyRecord, models.CASCADE, db_column="daily_id", related_name="burns")
    burn = models.ForeignKey(Burn, models.PROTECT, db_column="burn_id", related_name="logged")
    duration_min = models.IntegerField("minutes")

    class Meta:
        managed = False
        db_table = "Daily_Burn"


class WeeklyRecord(models.Model):
    week_id = models.AutoField(primary_key=True)
    user = models.ForeignKey(User, models.CASCADE, db_column="user_id", related_name="weeks")
    week_start_date = models.DateField("week starting", validators=[not_in_future])
    height_cm = models.DecimalField("height (cm)", max_digits=5, decimal_places=2, validators=[positive])
    weight_kg = models.DecimalField("weight (kg)", max_digits=5, decimal_places=2, validators=[positive])

    class Meta:
        managed = False
        db_table = "Weekly_Record"
        unique_together = [("user", "week_start_date")]
        ordering = ["-week_start_date", "user"]
        verbose_name = "weekly check-in"

    def __str__(self):
        return f"{self.user}, week of {self.week_start_date:%d %b %Y}"

    @property
    def bmi(self):
        h = float(self.height_cm) / 100
        return round(float(self.weight_kg) / (h * h), 1)


# ---------------------------------------------------------------- views (read only)


class DailySummary(models.Model):
    """vw_daily_summary: calories in / out / net per tracked day."""

    daily = models.OneToOneField(DailyRecord, models.DO_NOTHING, primary_key=True, db_column="daily_id", related_name="+")
    user = models.ForeignKey(User, models.DO_NOTHING, db_column="user_id", db_constraint=False, related_name="+")
    username = models.CharField(max_length=50)
    record_date = models.DateField("date")
    calories_in = models.DecimalField(max_digits=12, decimal_places=2)
    calories_out = models.DecimalField(max_digits=12, decimal_places=2)
    net_calories = models.DecimalField(max_digits=12, decimal_places=2)

    class Meta:
        managed = False
        db_table = "vw_daily_summary"
        ordering = ["-record_date", "username"]
        verbose_name = "daily summary"
        verbose_name_plural = "daily summaries"


class FoodLogEntry(models.Model):
    """vw_food_log: one row per Daily_Food row, joined with who, when and calories."""

    entry_id = models.CharField(max_length=30, primary_key=True)
    daily = models.ForeignKey(DailyRecord, models.DO_NOTHING, db_column="daily_id", db_constraint=False, related_name="+")
    user = models.ForeignKey(User, models.DO_NOTHING, db_column="user_id", db_constraint=False, related_name="+")
    username = models.CharField(max_length=50)
    record_date = models.DateField("date")
    food = models.ForeignKey(Food, models.DO_NOTHING, db_column="food_id", db_constraint=False, related_name="+")
    food_name = models.CharField("food", max_length=100)
    food_type = models.CharField("type", max_length=20)
    servings = models.DecimalField(max_digits=5, decimal_places=2)
    calories_per_serving = models.IntegerField("kcal / serving")
    calories = models.DecimalField("kcal", max_digits=12, decimal_places=2)

    class Meta:
        managed = False
        db_table = "vw_food_log"
        ordering = ["-record_date", "username"]
        verbose_name = "food log entry"
        verbose_name_plural = "food log entries"


class BurnLogEntry(models.Model):
    """vw_burn_log: one row per Daily_Burn row, joined with who, when and calories."""

    entry_id = models.CharField(max_length=30, primary_key=True)
    daily = models.ForeignKey(DailyRecord, models.DO_NOTHING, db_column="daily_id", db_constraint=False, related_name="+")
    user = models.ForeignKey(User, models.DO_NOTHING, db_column="user_id", db_constraint=False, related_name="+")
    username = models.CharField(max_length=50)
    record_date = models.DateField("date")
    burn = models.ForeignKey(Burn, models.DO_NOTHING, db_column="burn_id", db_constraint=False, related_name="+")
    burn_name = models.CharField("exercise", max_length=100)
    burn_type = models.CharField("type", max_length=20)
    duration_min = models.IntegerField("minutes")
    calories_per_min = models.DecimalField("kcal / min", max_digits=6, decimal_places=2)
    calories = models.DecimalField("kcal", max_digits=12, decimal_places=2)

    class Meta:
        managed = False
        db_table = "vw_burn_log"
        ordering = ["-record_date", "username"]
        verbose_name = "workout log entry"
        verbose_name_plural = "workout log entries"
