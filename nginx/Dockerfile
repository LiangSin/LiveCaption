FROM tiangolo/nginx-rtmp:latest

# 建立 hls 目錄並設定權限
RUN mkdir -p /var/www/hls \
    && chown -R www-data:www-data /var/www \
    && chmod -R 755 /var/www

COPY nginx/nginx.conf /etc/nginx/nginx.conf
