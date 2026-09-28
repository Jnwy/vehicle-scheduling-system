FROM python:3.13-slim

WORKDIR /app

COPY requirements.txt requirements-dev.txt ./
RUN pip install --no-cache-dir -r requirements-dev.txt

COPY alembic.ini ./
COPY alembic ./alembic
COPY start.sh ./start.sh
COPY app ./app
COPY tests ./tests

RUN chmod +x ./start.sh

EXPOSE 8000

CMD ["./start.sh"]
