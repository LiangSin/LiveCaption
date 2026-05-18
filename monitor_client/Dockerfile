FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1

WORKDIR /app

COPY monitor_client/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY monitor_client/client.py .

CMD ["python", "client.py"]
