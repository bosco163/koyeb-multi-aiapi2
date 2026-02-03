const http = require('http');
const { URL } = require('url');

// ================= 配置区域 =================
const TIMEOUT_MS = 8000; // 8秒卡顿超时
const TERMINATOR = "FINISHED"; // 特殊终结符
const WORKER_PORT = process.env.PORT || 3002; // Worker 服务端口
// ===========================================

// 内部服务映射表
const INTERNAL_SERVICES = {
    'deepseek': 'http://127.0.0.1:5001',
    'qwen': 'http://127.0.0.1:3000',
    'qw': 'http://127.0.0.1:8000',
    'tts': 'http://127.0.0.1:5050',
    'worker': 'http://127.0.0.1:3002'
};

// Node.js 的 fetch polyfill（Node.js 18+ 自带 fetch）
let fetch;
if (globalThis.fetch) {
    fetch = globalThis.fetch;
} else {
    fetch = require('node-fetch');
}

const server = http.createServer(async (req, res) => {
    try {
        // 1. 解析请求 URL
        const url = new URL(req.url, `http://${req.headers.host}`);
        let targetPath = url.pathname.replace(/^\//, '');
        
        // 如果路径为空，返回错误
        if (!targetPath) {
            res.writeHead(400, { 'Content-Type': 'text/plain' });
            res.end('Missing target URL');
            return;
        }
        
        // 2. 检查是否是内部服务代理请求
        // 格式: /service/deepseek/path 或 /service/qwen/path
        const serviceMatch = targetPath.match(/^service\/([^\/]+)\/(.+)$/);
        let targetUrl;
        
        if (serviceMatch) {
            // 内部服务代理
            const [, serviceName, servicePath] = serviceMatch;
            if (INTERNAL_SERVICES[serviceName]) {
                targetUrl = new URL(servicePath, INTERNAL_SERVICES[serviceName]);
                targetUrl.search = url.search; // 保留查询参数
            } else {
                res.writeHead(404, { 'Content-Type': 'text/plain' });
                res.end(`Service '${serviceName}' not found`);
                return;
            }
        } else {
            // 原始的外部代理逻辑
            if (!targetPath.startsWith('http')) {
                targetPath = 'https://' + targetPath;
            }
            targetUrl = new URL(targetPath + url.search);
        }
        
        // 3. 构造请求头
        const headers = { ...req.headers };
        headers.host = targetUrl.host;
        delete headers['cf-ray'];
        delete headers['cf-connecting-ip'];
        
        // 4. 读取请求体（如果有）
        let body = null;
        if (req.method !== 'GET' && req.method !== 'HEAD') {
            body = await new Promise((resolve) => {
                let chunks = [];
                req.on('data', chunk => chunks.push(chunk));
                req.on('end', () => resolve(Buffer.concat(chunks)));
            });
        }
        
        // 5. 发起请求
        const response = await fetch(targetUrl.toString(), {
            method: req.method,
            headers: headers,
            body: body,
            redirect: 'manual'
        });
        
        // 如果非 200 响应，直接透传
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
        
        // --- 6. 非流式处理 ---
        if (!isStream) {
            let text = await response.text();
            
            // 检查是否为空
            if (!text || text.trim().length === 0) {
                res.writeHead(503, { 'Content-Type': 'text/plain' });
                res.end('Empty Response');
                return;
            }
            
            try {
                // 尝试解析为 JSON（处理 OpenAI 格式）
                const data = JSON.parse(text);
                const content = data.choices?.[0]?.message?.content;
                
                if (content !== undefined && content !== null) {
                    // 只删除结尾的 FINISHED
                    const newContent = content.replace(new RegExp(`${TERMINATOR}$`), '');
                    data.choices[0].message.content = newContent;
                    
                    // 检查去掉后是否为空
                    if (String(newContent).trim().length === 0) {
                        res.writeHead(503, { 'Content-Type': 'text/plain' });
                        res.end('Empty Content After Filter');
                        return;
                    }
                    
                    text = JSON.stringify(data);
                }
            } catch (e) {
                // 如果不是 JSON，检查普通文本中的 TERMINATOR
                const terminatorIndex = text.indexOf(TERMINATOR);
                if (terminatorIndex !== -1) {
                    text = text.substring(0, terminatorIndex);
                }
            }
            
            // 删除 content-length 头
            const headers = { ...Object.fromEntries(response.headers.entries()) };
            delete headers['content-length'];
            
            res.writeHead(200, headers);
            res.end(text);
            return;
        }
        
        // --- 7. 流式处理 ---
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'Transfer-Encoding': 'chunked'
        });
        
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        
        let timer = null;
        
        // 强制结束函数
        const terminateStream = () => {
            if (timer) clearTimeout(timer);
            try {
                res.write('data: [DONE]\n\n');
                res.end();
            } catch (e) {}
        };
        
        // 8秒计时器
        const resetTimer = () => {
            if (timer) clearTimeout(timer);
            timer = setTimeout(terminateStream, TIMEOUT_MS);
        };
        
        resetTimer();
        
        try {
            while (true) {
                const { done, value } = await reader.read();
                
                if (done) {
                    if (timer) clearTimeout(timer);
                    res.write('data: [DONE]\n\n');
                    res.end();
                    break;
                }
                
                let chunkText = decoder.decode(value, { stream: true });
                
                // 检查 FINISHED 终结符
                if (chunkText.includes(TERMINATOR)) {
                    // 擦除单词
                    chunkText = chunkText.replace(new RegExp(TERMINATOR, 'g'), '');
                    res.write(chunkText);
                    terminateStream();
                    break;
                }
                
                res.write(chunkText);
                resetTimer(); // 收到新数据，重置 8 秒
            }
        } catch (e) {
            if (timer) clearTimeout(timer);
            try {
                res.end();
            } catch (e) {}
        }
        
    } catch (err) {
        console.error('Worker Error:', err);
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end(`Worker Error: ${err.message}`);
    }
});

// 启动服务器
server.listen(WORKER_PORT, () => {
    console.log(`Worker service listening on port ${WORKER_PORT}`);
    console.log('Available internal services:', Object.keys(INTERNAL_SERVICES).join(', '));
});

// 优雅关闭
process.on('SIGTERM', () => {
    server.close(() => {
        console.log('Worker service stopped');
        process.exit(0);
    });
});
