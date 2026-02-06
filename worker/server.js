const http = require('http');
const { URL } = require('url');

// ================= 配置区域 =================
const TIMEOUT_MS = 8000; // 8秒卡顿超时
const TERMINATOR = "FINISHED"; // 特殊终结符
const WORKER_PORT = process.env.PORT || 3002; // Worker 服务端口
// ===========================================

// Node.js 的 fetch polyfill
let fetch;
if (globalThis.fetch) {
    fetch = globalThis.fetch;
} else {
    fetch = require('node-fetch');
}

// 忽略 SSL 证书验证（仅用于测试，生产环境请谨慎）
if (process.env.NODE_TLS_REJECT_UNAUTHORIZED !== '1') {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
}

const server = http.createServer(async (req, res) => {
    console.log(`[Worker] ${req.method} ${req.url}`);
    
    // 内存保护：如果内存使用过高，返回 503
    const usedMemory = process.memoryUsage().heapUsed / 1024 / 1024;
    if (usedMemory > 180) { // 接近 200M 重启阈值
        console.warn(`[Worker] High memory usage: ${usedMemory.toFixed(2)}MB`);
        res.writeHead(503, { 'Content-Type': 'text/plain' });
        res.end('Service Temporarily Unavailable');
        return;
    }
    
    try {
        // 1. 解析目标 URL
        const url = new URL(req.url, `http://${req.headers.host}`);
        let targetPath = url.pathname.replace(/^\//, '');
        
        console.log(`[Worker] Original path: "${targetPath}"`);
        
        if (!targetPath) {
            console.log(`[Worker] Missing target URL`);
            res.writeHead(400, { 'Content-Type': 'text/plain' });
            res.end('Missing target URL');
            return;
        }
        
        if (!targetPath.startsWith("http")) targetPath = "https://" + targetPath;
        
        console.log(`[Worker] Target path: "${targetPath}"`);
        const targetUrl = new URL(targetPath + url.search);
        console.log(`[Worker] Target URL: ${targetUrl.toString()}`);

        // 2. 构造请求头
        const headers = { ...req.headers };
        headers.host = targetUrl.host;
        delete headers['cf-ray'];
        delete headers['cf-connecting-ip'];
        delete headers['accept-encoding']; // 避免压缩
        
        // 确保必要的头部
        if (!headers['user-agent']) {
            headers['user-agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
        }
        if (!headers['accept']) {
            headers['accept'] = '*/*';
        }
        
        console.log(`[Worker] Headers: ${JSON.stringify(headers, null, 2)}`);

        // 3. 读取请求体
        let body = null;
        if (req.method !== 'GET' && req.method !== 'HEAD') {
            console.log(`[Worker] Reading request body...`);
            body = await new Promise((resolve) => {
                let chunks = [];
                req.on('data', chunk => chunks.push(chunk));
                req.on('end', () => {
                    const bodyBuffer = Buffer.concat(chunks);
                    console.log(`[Worker] Request body length: ${bodyBuffer.length}`);
                    if (bodyBuffer.length > 0) {
                        console.log(`[Worker] Request body preview: ${bodyBuffer.toString().substring(0, 200)}...`);
                    }
                    resolve(bodyBuffer);
                });
            });
        }

        // 4. 发起请求
        console.log(`[Worker] Making request to: ${targetUrl.toString()}`);
        
        let response;
        try {
            response = await fetch(targetUrl.toString(), {
                method: req.method,
                headers: headers,
                body: body,
                redirect: 'manual',
                timeout: 30000 // 增加超时时间
            });
        } catch (fetchError) {
            console.error(`[Worker] Fetch error: ${fetchError.message}`);
            res.writeHead(500, { 'Content-Type': 'text/plain' });
            res.end(`Fetch Error: ${fetchError.message}`);
            return;
        }

        console.log(`[Worker] Response status: ${response.status} ${response.statusText}`);
        
        // 收集响应头
        const responseHeaders = {};
        for (const [key, value] of response.headers.entries()) {
            responseHeaders[key] = value;
        }
        console.log(`[Worker] Response headers: ${JSON.stringify(responseHeaders, null, 2)}`);

        // 如果非 200 响应，直接透传错误
        if (response.status !== 200) {
            // 移除可能导致问题的头部
            const safeHeaders = {};
            for (const [key, value] of Object.entries(responseHeaders)) {
                const lowerKey = key.toLowerCase();
                if (!['content-length', 'transfer-encoding'].includes(lowerKey)) {
                    safeHeaders[key] = value;
                }
            }
            
            console.log(`[Worker] Non-200 response, sending headers: ${JSON.stringify(safeHeaders)}`);
            
            res.writeHead(response.status, safeHeaders);
            
            // 读取并发送响应体
            try {
                const text = await response.text();
                console.log(`[Worker] Non-200 response body length: ${text.length}`);
                if (text.length > 0) {
                    console.log(`[Worker] Non-200 response body: ${text.substring(0, 500)}`);
                }
                res.end(text);
            } catch (bodyError) {
                console.error(`[Worker] Error reading non-200 response body: ${bodyError.message}`);
                res.end();
            }
            return;
        }

        const contentType = response.headers.get('content-type') || '';
        const isStream = contentType.includes('text/event-stream');
        
        console.log(`[Worker] Content-Type: ${contentType}, IsStream: ${isStream}`);

        // --- 非流式处理 ---
        if (!isStream) {
            let text = await response.text();
            
            console.log(`[Worker] Non-stream response length: ${text.length}`);
            if (text.length > 0) {
                console.log(`[Worker] Response preview: ${text.substring(0, 300)}...`);
            }
            
            // 检查原始文本是否为空
            if (!text || text.trim().length === 0) {
                console.log(`[Worker] Empty response`);
                res.writeHead(503, { 'Content-Type': 'text/plain' });
                res.end('Empty Response');
                return;
            }
            
            try {
                const data = JSON.parse(text);
                let content = data.choices?.[0]?.message?.content;
                
                console.log(`[Worker] Parsed JSON, content exists: ${content !== undefined && content !== null}`);
                
                if (content !== undefined && content !== null) {
                    // 只删除结尾的 FINISHED
                    const originalContent = content;
                    content = content.replace(new RegExp(TERMINATOR + '$'), '');
                    
                    console.log(`[Worker] Original content: "${originalContent.substring(0, 100)}..."`);
                    console.log(`[Worker] After remove FINISHED: "${content.substring(0, 100)}..."`);
                    
                    // 更新回数据对象
                    data.choices[0].message.content = content;
                    
                    // 检查去掉后是否实质内容为空
                    if (String(content).trim().length === 0) {
                        console.log(`[Worker] Empty content after filter`);
                        res.writeHead(503, { 'Content-Type': 'text/plain' });
                        res.end('Empty Content After Filter');
                        return;
                    }
                    
                    // 重新序列化为 JSON
                    text = JSON.stringify(data);
                }
            } catch (e) {
                console.log(`[Worker] JSON parse error: ${e.message}`);
                // 如果解析失败，检查普通文本中的 TERMINATOR
                if (text.includes(TERMINATOR)) {
                    text = text.replace(new RegExp(TERMINATOR, 'g'), '');
                }
            }
            
            // 删除 content-length
            const modifiedHeaders = { ...responseHeaders };
            delete modifiedHeaders['content-length'];
            
            console.log(`[Worker] Sending response with headers: ${JSON.stringify(modifiedHeaders, null, 2)}`);
            
            res.writeHead(200, modifiedHeaders);
            res.end(text);
            return;
        }

        // --- 流式处理 ---
        console.log(`[Worker] Processing stream response`);
        
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        
        // 预检首包：拦截空回
        const { value: firstChunk, done: firstDone } = await reader.read();
        if (firstDone || !firstChunk) {
            console.log(`[Worker] Empty stream`);
            res.writeHead(503, { 'Content-Type': 'text/plain' });
            res.end('Empty Stream');
            return;
        }
        
        const firstText = decoder.decode(firstChunk, { stream: true });
        console.log(`[Worker] First chunk (first 200 chars): ${firstText.substring(0, 200)}...`);
        
        // 如果首包就是 DONE 且没有任何 content，判定为空回
        if (firstText.includes("data: [DONE]") && !firstText.includes('"content"')) {
            console.log(`[Worker] Stream closed immediately`);
            res.writeHead(503, { 'Content-Type': 'text/plain' });
            res.end('Stream Closed Immediately');
            return;
        }
        
        // 构造输出流
        const streamHeaders = {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'Transfer-Encoding': 'chunked'
        };
        
        console.log(`[Worker] Setting stream headers: ${JSON.stringify(streamHeaders)}`);
        res.writeHead(200, streamHeaders);
        
        let timer = null;
        let buffer = [firstChunk]; // 保存首包
        
        // 强制结束函数
        const terminateStream = () => {
            if (timer) clearTimeout(timer);
            try {
                res.write('data: [DONE]\n\n');
                res.end();
                console.log(`[Worker] Stream terminated`);
            } catch (e) {
                console.log(`[Worker] Error terminating stream: ${e.message}`);
            }
        };
        
        // 8秒计时器：只有在流运行期间有效
        const resetTimer = () => {
            if (timer) clearTimeout(timer);
            timer = setTimeout(terminateStream, TIMEOUT_MS);
        };
        
        // 处理并发送数据块
        const processAndEnqueue = (chunk) => {
            try {
                let chunkText = decoder.decode(chunk, { stream: true });
                
                // 检查 FINISHED 终结符
                if (chunkText.includes(TERMINATOR)) {
                    console.log(`[Worker] Found TERMINATOR in chunk`);
                    // 擦除单词
                    chunkText = chunkText.replace(new RegExp(TERMINATOR, 'g'), '');
                    res.write(chunkText);
                    // 立即终结
                    terminateStream();
                    return true; 
                }
                
                res.write(chunkText);
                return false;
            } catch (e) {
                console.log(`[Worker] Error processing chunk: ${e.message}`);
                return false;
            }
        };
        
        // 发送首包并开始计时
        const wasTerminated = processAndEnqueue(firstChunk);
        if (!wasTerminated) {
            resetTimer();
            
            // 循环读取剩余数据
            try {
                while (true) {
                    const { done, value } = await reader.read();
                    
                    if (done) {
                        console.log(`[Worker] Stream reader done`);
                        if (timer) clearTimeout(timer);
                        try {
                            res.write('data: [DONE]\n\n');
                            res.end();
                            console.log(`[Worker] Stream ended normally`);
                        } catch (e) {
                            console.log(`[Worker] Error ending stream: ${e.message}`);
                        }
                        break;
                    }
                    
                    const shouldStop = processAndEnqueue(value);
                    if (shouldStop) break;
                    
                    resetTimer(); // 收到新数据，重置 8 秒
                }
            } catch (e) {
                console.log(`[Worker] Stream reading error: ${e.message}`);
                if (timer) clearTimeout(timer);
                try {
                    res.write('data: [DONE]\n\n');
                    res.end();
                } catch (endError) {
                    console.log(`[Worker] Error ending stream after error: ${endError.message}`);
                }
            }
        }
        
    } catch (err) {
        console.error('[Worker] Top-level error:', err);
        console.error('[Worker] Error stack:', err.stack);
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end(`Worker Error: ${err.message}`);
    }
});

// 启动服务器
server.listen(WORKER_PORT, () => {
    console.log(`========================================`);
    console.log(`Worker proxy service listening on port ${WORKER_PORT}`);
    console.log(`Memory limit: ~200MB (PM2 auto-restart)`);
    console.log(`Available endpoints:`);
    console.log(`  /worker/https://api.openai.com/v1/...`);
    console.log(`  /worker/http://127.0.0.1:5001/v1/... (代理内部DeepSeek)`);
    console.log(`  /worker/http://127.0.0.1:3000/v1/... (代理内部Qwen)`);
    console.log(`  /worker/http://127.0.0.1:8000/v1/... (代理内部QwenChat)`);
    console.log(`  /worker/http://127.0.0.1:5050/v1/... (代理内部TTS)`);
    console.log(`========================================`);
});

// 优雅关闭
process.on('SIGTERM', () => {
    server.close(() => {
        console.log('Worker service stopped');
        process.exit(0);
    });
});

// 内存监控
setInterval(() => {
    const usedMemory = process.memoryUsage().heapUsed / 1024 / 1024;
    console.log(`[Worker] Memory usage: ${usedMemory.toFixed(2)}MB`);
}, 60000); // 每分钟记录一次内存使用情况
