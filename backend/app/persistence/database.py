import os

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker


def get_database_url() -> str:
    database_url = os.environ["DATABASE_URL"]
    if database_url.startswith("postgresql://"):
        return database_url.replace("postgresql://", "postgresql+psycopg://", 1)
    return database_url


engine = create_engine(get_database_url(), pool_pre_ping=True)
SessionFactory = sessionmaker(bind=engine, expire_on_commit=False)
