#!/bin/sh
set -eu

alembic upgrade head
python -m app.persistence.seed

# Extra arguments, such as --reload in development, are passed to uvicorn.
exec uvicorn app.main:app --host 0.0.0.0 --port 8000 "$@"
