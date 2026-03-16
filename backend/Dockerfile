FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

RUN mkdir -p /app/data/gtfs /app/data/stats \
    && useradd --no-create-home --shell /bin/false appuser \
    && chown -R appuser:appuser /app/data

USER appuser

EXPOSE 5000

CMD ["gunicorn", "--bind", "0.0.0.0:5000", "--workers", "1", "--threads", "16", "app:app"]
