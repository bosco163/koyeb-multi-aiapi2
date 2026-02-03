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

const server = http.createServer(async (req, res) => {
    try {
        // 1. 解析目标 URL
        const url = new URL(req.url, `http://${req.headers.host}`);
        let targetPath = url.pathname.replace(/^\//, '');
        
        if (!targetPath) {
            res.writeHead(400, { 'Content-Type': 'text/plain' });
            res.end('Missing target URL');
            return;
        }
        
        if (!targetPath.startsWith("http")) targetPath = "https://" + targetPath;
        const targetUrl = new URL(targetPath + url.search);

        // 2. 构造请求头
        const headers = { ...req.headers };
        headers.host = targetUrl.host;
        delete headers['cf-ray'];
        delete headers['cf-connecting-ip'];

        // 3. 读取请求体
        let body = null;
        if (req.method !== 'GET' && req.method !== 'HEAD') {
            body = await new Promise((resolve) => {
                let chunks = [];
                req.on('data', chunk => chunks.push(chunk));
                req.on('end', () => resolve(Buffer.concat(chunks)));
            });
        }

        // 4. 发起请求
        const response = await fetch(targetUrl.toString(), {
            method: req.method,
            headers: headers,
            body: body,
            redirect: 'manual'
        });

        // 如果非 200 响应，直接透传错误
        if (response.status !== 200) {
            const headers = Object.fromEntries(response.headers.entries());
            res.writeHead(response.status, headers);
            
            if (response.body) {
                for await (const chunk of response.body) {
                    res.write(chunk);
                }
            }
            res.end();
            return;
        }

        const contentType = response.headers.get('content-type') || '';
        const isStream = contentType.includes('text/event-stream');

        // --- 4. 非流式处理 (只删除 content 最后的 FINISHED) ---
        if (!isStream) {
            let text = await response.text();
            
            // 检查原始文本是否为空
            if (!text || text.trim().length === 0) {
                res.writeHead(503, { 'Content-Type': 'text/plain' });
                res.end('Empty Response');
                return;
            }
            
            try {
                const data = JSON.parse(text);
                let content = data.choices?.[0]?.message?.content;
                
                if (content !== undefined && content !== null) {
                    // 【核心修改】只删除结尾的 FINISHED
                    // $ 符号表示匹配字符串的末尾
                    content = content.replace(new RegExp(TERMINATOR + '$'), '');
                    
                    // 更新回数据对象
                    data.choices[0].message.content = content;
                    
                    // 检查去掉后是否实质内容为空
                    if (String(content).trim().length === 0) {
                        res.writeHead(503, { 'Content-Type': 'text/plain' });
                        res.end('Empty Content After Filter');
                        return;
                    }
                    
                    // 重新序列化为 JSON
                    text = JSON.stringify(data);
                }
            } catch (e) {
                // 如果解析失败，直接透传原始文本
            }
            
            // 【关键】必须删除 content-length，否则客户端会因为字节数对不上而卡住
            const modifiedHeaders = { ...Object.fromEntries(response.headers.entries()) };
            delete modifiedHeaders['content-length'];
            
            res.writeHead(200, modifiedHeaders);
            res.end(text);
            return;
        }

        // --- 5. 流式处理 (核心逻辑 - 完全保留奇迹版，未动任何一行) ---
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        const encoder = new TextEncoder();
        
        // [步骤 A] 预检首包：拦截空回
        const { value: firstChunk, done: firstDone } = await reader.read();
        if (firstDone || !firstChunk) {
            res.writeHead(503, { 'Content-Type': 'text/plain' });
            res.end('Empty Stream');
            return;
        }
        
        const firstText = decoder.decode(firstChunk, { stream: true });
        
        // 如果首包就是 DONE 且没有任何 content，判定为空回
        if (firstText.includes("data: [DONE]") && !firstText.includes('"content"')) {
            res.writeHead(503, { 'Content-Type': 'text/plain' });
            res.end('Stream Closed Immediately');
            return;
        }
        
        // [步骤 B] 构造输出流
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'Transfer-Encoding': 'chunked'
        });
        
        let timer = null;
        
        // 强制结束函数
        const terminateStream = () => {
            if (timer) clearTimeout(timer);
            try {
                res.write(encoder.encode("\ndata: [DONE]\n\n"));
                res.end();
            } catch (e) {}
        };
        
        // 8秒计时器：只有在流运行期间有效
        const resetTimer = () => {
            if (timer) clearTimeout(timer);
            timer = setTimeout(terminateStream, TIMEOUT_MS);
        };
        
        // 处理并发送数据块
        const processAndEnqueue = (chunk) => {
            let chunkText = decoder.decode(chunk, { stream: true });
            
            // 检查 FINISHED 终结符
            if (chunkText.includes(TERMINATOR)) {
                // 擦除单词
                chunkText = chunkText.replace(new RegExp(TERMINATOR, 'g'), '');
                res.write(encoder.encode(chunkText));
                // 立即终结
                terminateStream();
                return true; 
            }
            
            res.write(encoder.encode(chunkText));
            return false;
        };
        
        // 发送首包并开始计时
        const wasTerminated = processAndEnqueue(firstChunk);
        if (!wasTerminated) {
            resetTimer();
            
            // 循环读取
            try {
                while (true) {
                    const { done, value } = await reader.read();
                    
                    if (done) {
                        if (timer) clearTimeout(timer);
                        try {
                            res.write(encoder.encode("\ndata: [DONE]\n\n"));
                            res.end();
                        } catch (e) {}
                        break;
                    }
                    
                    const shouldStop = processAndEnqueue(value);
                    if (shouldStop) break;
                    
                    resetTimer(); // 收到新数据，重置 8 秒
                }
            } catch (e) {
                if (timer) clearTimeout(timer);
                try {
                    res.write(encoder.encode("\ndata: [DONE]\n\n"));
                    res.end();
                } catch (e) {}
            }
        }
        
    } catch (err) {
        console.error('Worker Error:', err);
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end(`Worker Error: ${err.message}`);
    }
});

// 启动服务器
server.listen(WORKER_PORT, () => {
    console.log(`Worker proxy service listening on port ${WORKER_PORT}`);
});

// 优雅关闭
process.on('SIGTERM', () => {
    server.close(() => {
        console.log('Worker service stopped');
        process.exit(0);
    });
});
