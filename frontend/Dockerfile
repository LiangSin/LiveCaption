FROM python:3.10-slim

ENV PYTHONUNBUFFERED=1

WORKDIR /app/frontend

# copy frontend 靜態檔
COPY frontend/ .

# 預設 frontend port（只是文件性質）
EXPOSE 8088

CMD ["python", "./serve_https.py", "--port", "8088", "--bind", "0.0.0.0", "--cert", "/ssl-config/cert.pem", "--key", "/ssl-config/key.pem"]
