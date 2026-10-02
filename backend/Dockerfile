FROM python:3.13-slim

WORKDIR /app

# The development override installs requirements-dev.txt to add the test tools.
ARG REQUIREMENTS_FILE=requirements.txt
COPY requirements.txt requirements-dev.txt ./
RUN pip install --no-cache-dir -r ${REQUIREMENTS_FILE}

COPY alembic.ini ./
COPY alembic ./alembic
COPY start.sh ./start.sh
COPY app ./app

RUN chmod +x ./start.sh

EXPOSE 8000

CMD ["./start.sh"]
