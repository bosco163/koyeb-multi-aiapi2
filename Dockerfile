FROM python:3.10-slim

# 1. 安装 OpenResty（替代 nginx，支持 Lua）和基础工具
RUN apt-get update && apt-get install -y \
    curl \
    gnupg \
    build-essential \
    git \
    wget \
    && rm -rf /var/lib/apt/lists/*

# 2. 安装 OpenResty（支持 Lua）
RUN wget -O - https://openresty.org/package/pubkey.gpg | gpg --dearmor -o /usr/share/keyrings/openresty.gpg \
    && echo "deb [signed-by=/usr/share/keyrings/openresty.gpg] https://openresty.org/package/debian bullseye main" | tee /etc/apt/sources.list.d/openresty.list \
    && apt-get update && apt-get install -y openresty \
    && rm -rf /var/lib/apt/lists/*

# 3. 安装 Node.js 20 和 PM2
RUN mkdir -p /etc/apt/keyrings \
    && curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg \
    && echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_20.x nodistro main" | tee /etc/apt/sources.list.d/nodesource.list \
    && apt-get update && apt-get install -y nodejs \
    && npm install -g pm2

# 4. 安装 supervisor
RUN apt-get update && apt-get install -y supervisor \
    && rm -rf /var/lib/apt/lists/*

# 5. 部署 Edge TTS
WORKDIR /app/tts
RUN git clone https://github.com/travisvn/openai-edge-tts.git .
RUN pip install --no-cache-dir -r requirements.txt

# 6. 部署 DeepSeek2API
WORKDIR /app/deepseek
RUN git clone https://github.com/iidamie/deepseek2api.git .
RUN pip install --no-cache-dir -r requirements.txt

# 7. 部署 Qwen2API
WORKDIR /app/qwen
RUN git clone https://github.com/Rfym21/Qwen2API.git .
RUN npm install
WORKDIR /app/qwen/public
RUN npm install
RUN npm run build
WORKDIR /app/qwen
RUN mkdir -p caches data logs && chmod -R 777 caches data logs

# 8. 部署 QwenChat2Api
WORKDIR /app/qw
RUN git clone https://github.com/ckcoding/qwenchat2api.git .
RUN npm install
RUN npm audit fix || true

# 9. 部署 Worker 代理服务
WORKDIR /app/worker
COPY ./worker/package*.json ./
RUN npm install
COPY ./worker/ ./

# 10. 配置 Nginx 和 Supervisor
WORKDIR /app
COPY nginx.conf /usr/local/openresty/nginx/conf/nginx.conf
COPY supervisord.conf /etc/supervisor/conf.d/supervisord.conf

# 11. 创建必要的目录
RUN mkdir -p /var/log/nginx /var/log/supervisor \
    && touch /usr/local/openresty/nginx/conf/nginx.conf

ENV PORT=8080
EXPOSE 8080 3002

# 12. 启动命令
CMD ["/usr/bin/supervisord", "-c", "/etc/supervisor/conf.d/supervisord.conf"]
