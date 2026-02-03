FROM python:3.10-slim

# 1. 安装基础工具（添加内存监控工具）
RUN apt-get update && apt-get install -y \
    nginx \
    supervisor \
    git \
    curl \
    gnupg \
    build-essential \
    procps \
    htop \
    net-tools \
    dstat \
    && rm -rf /var/lib/apt/lists/*

# 2. 安装 Node.js 20
RUN mkdir -p /etc/apt/keyrings
RUN curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg
RUN echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_20.x nodistro main" | tee /etc/apt/sources.list.d/nodesource.list
RUN apt-get update && apt-get install -y nodejs

# 3. 安装 PM2 进程管理器（关键！）
RUN npm install -g pm2@latest

# 4. 部署 Edge TTS
WORKDIR /app/tts
RUN git clone https://github.com/travisvn/openai-edge-tts.git .
RUN pip install --no-cache-dir -r requirements.txt

# 5. 部署 DeepSeek2API
WORKDIR /app/deepseek
RUN git clone https://github.com/iidamie/deepseek2api.git .
RUN pip install --no-cache-dir -r requirements.txt

# 6. 部署 Qwen2API (根目录服务)
WORKDIR /app/qwen
RUN git clone https://github.com/Rfym21/Qwen2API.git .
RUN npm install
WORKDIR /app/qwen/public
RUN npm install
RUN npm run build
WORKDIR /app/qwen
RUN mkdir -p caches data logs && chmod -R 777 caches data logs

# 7. 部署 QwenChat2Api
WORKDIR /app/qw
RUN git clone https://github.com/ckcoding/qwenchat2api.git .
RUN npm install
RUN npm audit fix || true

# 8. 部署 Worker 代理服务
WORKDIR /app/worker
COPY ./worker/package*.json ./
RUN npm install
COPY ./worker/ ./

# 9. 创建监控脚本
WORKDIR /app
COPY monitor.sh /app/monitor.sh
RUN chmod +x /app/monitor.sh

# 10. 配置 Nginx 和 Supervisor
COPY nginx.conf /etc/nginx/sites-available/default
COPY supervisord.conf /etc/supervisor/conf.d/supervisord.conf

# 11. 创建日志轮转配置
COPY logrotate.conf /etc/logrotate.d/app-logs

ENV PORT=8080
EXPOSE 8080 3002

# 健康检查脚本
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD curl -f http://localhost:8080/nginx_status || exit 1

CMD ["/usr/bin/supervisord", "-c", "/etc/supervisor/conf.d/supervisord.conf"]
