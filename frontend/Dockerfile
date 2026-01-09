FROM python:3.10-slim

ENV PYTHONUNBUFFERED=1

WORKDIR /app/frontend

# copy frontend 靜態檔
COPY frontend/ .

# 預設 frontend port（只是文件性質）
EXPOSE 6666

CMD ["python", "-m", "http.server", "6666", "--bind", "0.0.0.0"]
