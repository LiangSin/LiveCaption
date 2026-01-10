FROM python:3.10-slim

# 避免 Python stdout buffering
ENV PYTHONUNBUFFERED=1

# 安裝 ffmpeg
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 先裝 dependency（利用 layer cache）
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# 再 copy 程式碼
COPY relay_service relay_service

# Bring in private CA cert bundle
COPY ssl-config ssl-config

# 預設啟動 relay
CMD ["python", "-m", "relay_service.relay_main"]
