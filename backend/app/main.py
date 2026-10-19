import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from app.api import auth, dashboard, items, teams
from app.config import get_settings
from app.database import engine
from app.errors import ApiError

settings = get_settings()
settings.validate_runtime()
logger = logging.getLogger("newtonite.api")


@asynccontextmanager
async def lifespan(_: FastAPI):
    yield
    engine.dispose()


app = FastAPI(title="Newtonite Ops API", version="1.0.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.allowed_origins,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PATCH", "OPTIONS"],
    allow_headers=["Content-Type", "X-CSRF-Token", "Idempotency-Key"],
)


@app.middleware("http")
async def security_headers(request: Request, call_next):
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "no-referrer"
    response.headers["Content-Security-Policy"] = "default-src 'none'; frame-ancestors 'none'"
    response.headers["Cache-Control"] = "no-store"
    if settings.app_env.lower() == "production":
        response.headers["Strict-Transport-Security"] = "max-age=15552000; includeSubDomains"
    return response


@app.exception_handler(ApiError)
async def api_error_handler(_: Request, exc: ApiError) -> JSONResponse:
    error = {"code": exc.code, "message": exc.message}
    if exc.details is not None:
        error["details"] = exc.details
    return JSONResponse(
        status_code=exc.status_code,
        content={"error": error},
        headers=exc.headers,
    )


@app.exception_handler(RequestValidationError)
async def validation_error_handler(_: Request, exc: RequestValidationError) -> JSONResponse:
    details: dict[str, list[str]] = {}
    for error in exc.errors():
        location = error.get("loc", ())
        field = str(location[-1]) if location else "request"
        details.setdefault(field, []).append(error["msg"])
    return JSONResponse(
        status_code=422,
        content={
            "error": {
                "code": "VALIDATION_ERROR",
                "message": "Invalid request",
                "details": details,
            }
        },
    )


@app.exception_handler(StarletteHTTPException)
async def http_error_handler(_: Request, exc: StarletteHTTPException) -> JSONResponse:
    if exc.status_code == 404:
        return JSONResponse(
            status_code=404,
            content={"error": {"code": "NOT_FOUND", "message": "Not found"}},
            headers=exc.headers,
        )
    if exc.status_code == 405:
        return JSONResponse(
            status_code=405,
            content={"error": {"code": "METHOD_NOT_ALLOWED", "message": "Method not allowed"}},
            headers=exc.headers,
        )
    return JSONResponse(
        status_code=exc.status_code,
        content={"error": {"code": "HTTP_ERROR", "message": str(exc.detail)}},
        headers=exc.headers,
    )


@app.exception_handler(Exception)
async def unexpected_error_handler(_: Request, exc: Exception) -> JSONResponse:
    logger.error("Unhandled API exception type=%s", type(exc).__name__)
    return JSONResponse(
        status_code=500,
        content={"error": {"code": "INTERNAL", "message": "Unexpected error"}},
    )


@app.get("/health")
def health() -> dict[str, bool]:
    from sqlalchemy import text

    with engine.connect() as connection:
        connection.execute(text("SELECT 1"))
    return {"ok": True}


app.include_router(auth.router, prefix="/api/v1")
app.include_router(items.router, prefix="/api/v1")
app.include_router(teams.router, prefix="/api/v1")
app.include_router(dashboard.router, prefix="/api/v1")
