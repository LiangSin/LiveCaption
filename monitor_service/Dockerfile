FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1

WORKDIR /app

COPY monitor_service/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY monitor_service/app.py .

CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8080"]
