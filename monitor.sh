#!/bin/bash
# 监控脚本 - 每5分钟运行一次

LOG_FILE="/app/logs/monitor.log"
THRESHOLD_MB=800  # 内存阈值800MB
RESTART_THRESHOLD_MB=1000  # 重启阈值1GB

# 创建日志目录
mkdir -p /app/logs

# 获取内存使用情况
TOTAL_MEM=$(free -m | awk '/^Mem:/{print $2}')
USED_MEM=$(free -m | awk '/^Mem:/{print $3}')
PERCENT=$((USED_MEM * 100 / TOTAL_MEM))

# 获取Worker进程内存
WORKER_PID=$(pgrep -f "node.*server.js" | head -1)
if [ -n "$WORKER_PID" ]; then
    WORKER_MEM=$(ps -p $WORKER_PID -o rss= | awk '{print int($1/1024)}')
else
    WORKER_MEM=0
fi

# 获取PM2信息
PM2_INFO=$(pm2 list worker 2>/dev/null || echo "No PM2")

# 记录日志
TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')
echo "[$TIMESTAMP] Total: ${TOTAL_MEM}MB, Used: ${USED_MEM}MB (${PERCENT}%), Worker: ${WORKER_MEM}MB" >> $LOG_FILE

# 如果内存超过阈值，记录详细信息
if [ $USED_MEM -gt $THRESHOLD_MB ]; then
    echo "[$TIMESTAMP] WARNING: High memory usage!" >> $LOG_FILE
    echo "Top processes:" >> $LOG_FILE
    ps aux --sort=-%mem | head -10 >> $LOG_FILE
    echo "---" >> $LOG_FILE
    
    # 如果worker内存特别高，尝试通过PM2重启
    if [ $WORKER_MEM -gt 300 ]; then
        echo "[$TIMESTAMP] Restarting worker via PM2 (memory: ${WORKER_MEM}MB)" >> $LOG_FILE
        pm2 restart worker --update-env >> $LOG_FILE 2>&1
    fi
fi

# 如果内存超过重启阈值，强制重启worker
if [ $USED_MEM -gt $RESTART_THRESHOLD_MB ]; then
    echo "[$TIMESTAMP] CRITICAL: Memory exceeded ${RESTART_THRESHOLD_MB}MB, forcing worker restart" >> $LOG_FILE
    pm2 delete worker >> $LOG_FILE 2>&1
    sleep 2
    pm2 start /app/worker/server.js --name worker --max-memory-restart 300M >> $LOG_FILE 2>&1
    # 记录重启后状态
    sleep 5
    echo "[$TIMESTAMP] After restart - Worker status:" >> $LOG_FILE
    pm2 list worker >> $LOG_FILE 2>&1
fi

# 清理旧日志（保留最近7天）
find /app/logs -name "*.log" -mtime +7 -delete
find /root/.pm2/logs -name "*.log" -mtime +7 -delete

# 日志轮转检查
LOG_SIZE=$(du -m /app/logs/monitor.log 2>/dev/null | cut -f1)
if [ "$LOG_SIZE" -gt 10 ]; then
    mv /app/logs/monitor.log /app/logs/monitor.log.old
    touch /app/logs/monitor.log
fi
