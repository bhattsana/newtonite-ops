from functools import lru_cache
from urllib.parse import urlsplit

from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    database_url: str = ""
    app_env: str = "development"
    session_secret: str = ""
    cors_origins: str = "http://localhost:5173"
    cookie_secure: bool = False
    login_max_failures: int = 10
    session_ttl_minutes: int = 15
    port: int = 8000

    @field_validator("cors_origins")
    @classmethod
    def validate_cors_origins(cls, value: str) -> str:
        origins = [origin.strip() for origin in value.split(",") if origin.strip()]
        if not origins:
            raise ValueError("CORS_ORIGINS must list at least one exact frontend origin")
        if "*" in origins:
            raise ValueError("Wildcard CORS origins are not supported")
        if any(origin.endswith("/") for origin in origins):
            raise ValueError("CORS_ORIGINS entries must not include a trailing slash")
        for origin in origins:
            parsed = urlsplit(origin)
            if (
                parsed.scheme not in ("http", "https")
                or not parsed.netloc
                or parsed.path
                or parsed.query
                or parsed.fragment
                or parsed.username
                or parsed.password
            ):
                raise ValueError("CORS_ORIGINS entries must be exact origins without paths or credentials")
        return value

    @field_validator("database_url")
    @classmethod
    def normalize_database_url(cls, value: str) -> str:
        if value.startswith("postgres://"):
            return value.replace("postgres://", "postgresql+psycopg://", 1)
        if value.startswith("postgresql://"):
            return value.replace("postgresql://", "postgresql+psycopg://", 1)
        return value

    @property
    def allowed_origins(self) -> list[str]:
        return [origin.strip() for origin in self.cors_origins.split(",") if origin.strip()]

    def validate_runtime(self) -> None:
        if not self.database_url:
            raise RuntimeError("DATABASE_URL must be set")
        if self.app_env.lower() == "production":
            if len(self.session_secret) < 32:
                raise RuntimeError("SESSION_SECRET must be set to at least 32 characters in production")
            if not self.allowed_origins or any(
                not origin.startswith("https://") for origin in self.allowed_origins
            ):
                raise RuntimeError("Production CORS_ORIGINS must contain exact HTTPS origins only")
            if not self.cookie_secure:
                raise RuntimeError("COOKIE_SECURE must be true in production")


@lru_cache
def get_settings() -> Settings:
    return Settings()
