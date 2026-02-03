const http = require('http');
const { URL } = require('url');

// ================= 配置区域 =================
const TIMEOUT_MS = 8000; // 8秒卡顿超时
const TERMINATOR = "FINISHED"; // 特殊终结符
const WORKER_PORT = process.env.PORT || 3002; // Worker 服务端口
// ===========================================

// 创建日志函数
const logger = {
  info: (...args) => {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] [INFO]`, ...args);
  },
  warn: (...args) => {
    const timestamp = new Date().toISOString();
    console.warn(`[${timestamp}] [WARN]`, ...args);
  },
  error: (...args) => {
    const timestamp = new Date().toISOString();
    console.error(`[${timestamp}] [ERROR]`, ...args);
  },
  debug: (...args) => {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] [DEBUG]`, ...args);
  }
};

// Node.js 的 fetch polyfill
let fetch;
if (globalThis.fetch) {
    fetch = globalThis.fetch;
} else {
    fetch = require('node-fetch');
}

// 忽略 SSL 证书验证
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const server = http.createServer(async (req, res) => {
    const requestId = Math.random().toString(36).substring(2, 10);
    const startTime = Date.now();
    
    logger.info(`[${requestId}] 收到请求: ${req.method} ${req.url}`);
    
    try {
        // 1. 解析目标 URL
        const url = new URL(req.url, `http://${req.headers.host}`);
        let targetPath = url.pathname.replace(/^\//, '');
        
        logger.debug(`[${requestId}] 原始路径: "${targetPath}"`);
        
        if (!targetPath) {
            logger.warn(`[${requestId}] 缺少目标URL`);
            res.writeHead(400, { 'Content-Type': 'text/plain' });
            res.end('Missing target URL');
            return;
        }
        
        if (!targetPath.startsWith("http")) {
            logger.debug(`[${requestId}] 添加https前缀`);
            targetPath = "https://" + targetPath;
        }
        
        const targetUrl = new URL(targetPath + url.search);
        logger.info(`[${requestId}] 目标URL: ${targetUrl.toString()}`);

        // 2. 构造请求头
        const headers = { ...req.headers };
        const originalHost = headers.host;
        headers.host = targetUrl.host;
        delete headers['cf-ray'];
        delete headers['cf-connecting-ip'];
        
        logger.debug(`[${requestId}] 原始Host: ${originalHost}, 新Host: ${headers.host}`);

        // 3. 发起请求
        logger.info(`[${requestId}] 开始发起请求到目标服务器`);
        const fetchStartTime = Date.now();
        
        const response = await fetch(targetUrl.toString(), {
            method: req.method,
            headers: headers,
            body: req.body,
            redirect: "manual"
        });
        
        const fetchTime = Date.now() - fetchStartTime;
        logger.info(`[${requestId}] 请求完成，耗时: ${fetchTime}ms，状态码: ${response.status}`);

        // 如果非 200 响应，直接透传错误
        if (response.status !== 200) {
            logger.warn(`[${requestId}] 非200响应，直接透传: ${response.status}`);
            const responseHeaders = {};
            for (const [key, value] of response.headers.entries()) {
                responseHeaders[key] = value;
            }
            
            res.writeHead(response.status, responseHeaders);
            
            if (response.body) {
                for await (const chunk of response.body) {
                    res.write(chunk);
                }
            }
            res.end();
            logger.info(`[${requestId}] 响应已发送，总耗时: ${Date.now() - startTime}ms`);
            return;
        }

        const contentType = response.headers.get('content-type') || '';
        const isStream = contentType.includes('text/event-stream');
        
        logger.info(`[${requestId}] Content-Type: ${contentType}，是否为流式: ${isStream}`);

        // --- 非流式处理 (只删除 content 最后的 FINISHED) ---
        if (!isStream) {
            logger.info(`[${requestId}] 开始处理非流式响应`);
            const textStartTime = Date.now();
            let text = await response.text();
            const textTime = Date.now() - textStartTime;
            logger.info(`[${requestId}] 读取响应体完成，长度: ${text.length}，耗时: ${textTime}ms`);
            
            // 检查原始文本是否为空
            if (!text || text.trim().length === 0) {
                logger.warn(`[${requestId}] 响应体为空`);
                res.writeHead(503, { 'Content-Type': 'text/plain' });
                res.end('Empty Response');
                logger.info(`[${requestId}] 请求结束，总耗时: ${Date.now() - startTime}ms`);
                return;
            }
            
            logger.debug(`[${requestId}] 响应前100字符: ${text.substring(0, 100)}...`);
            
            try {
                const data = JSON.parse(text);
                let content = data.choices?.[0]?.message?.content;
                
                if (content !== undefined && content !== null) {
                    logger.debug(`[${requestId}] 找到content字段，长度: ${content.length}`);
                    
                    // 检查是否包含FINISHED
                    const hasTerminator = content.includes(TERMINATOR);
                    if (hasTerminator) {
                        logger.info(`[${requestId}] 检测到FINISHED终结符`);
                    }
                    
                    // 【核心修改】只删除结尾的 FINISHED
                    const beforeReplace = content;
                    content = content.replace(new RegExp(TERMINATOR + '$'), '');
                    
                    if (beforeReplace !== content) {
                        logger.info(`[${requestId}] 已移除结尾的FINISHED，原长度: ${beforeReplace.length}，新长度: ${content.length}`);
                    }
                    
                    // 更新回数据对象
                    data.choices[0].message.content = content;
                    
                    // 检查去掉后是否实质内容为空
                    if (String(content).trim().length === 0) {
                        logger.warn(`[${requestId}] 移除FINISHED后内容为空`);
                        res.writeHead(503, { 'Content-Type': 'text/plain' });
                        res.end('Empty Content After Filter');
                        logger.info(`[${requestId}] 请求结束，总耗时: ${Date.now() - startTime}ms`);
                        return;
                    }
                    
                    // 重新序列化为 JSON
                    text = JSON.stringify(data);
                } else {
                    logger.debug(`[${requestId}] 未找到content字段或content为空`);
                }
            } catch (e) {
                logger.warn(`[${requestId}] JSON解析失败: ${e.message}`);
                // 如果解析失败，检查普通文本中的 TERMINATOR
                if (text.includes(TERMINATOR)) {
                    logger.info(`[${requestId}] 在非JSON文本中找到FINISHED，准备移除`);
                    text = text.replace(new RegExp(TERMINATOR, 'g'), '');
                }
            }
            
            // 【关键】必须删除 content-length，否则客户端会因为字节数对不上而卡住
            const modifiedHeaders = {};
            for (const [key, value] of response.headers.entries()) {
                if (key.toLowerCase() !== 'content-length') {
                    modifiedHeaders[key] = value;
                } else {
                    logger.debug(`[${requestId}] 移除content-length头: ${value}`);
                }
            }
            
            logger.info(`[${requestId}] 发送非流式响应，长度: ${text.length}`);
            res.writeHead(200, modifiedHeaders);
            res.end(text);
            logger.info(`[${requestId}] 非流式请求完成，总耗时: ${Date.now() - startTime}ms`);
            return;
        }

        // --- 流式处理 (核心逻辑) ---
        logger.info(`[${requestId}] 开始处理流式响应`);
        
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        const encoder = new TextEncoder();
        
        // [步骤 A] 预检首包：拦截空回
        logger.debug(`[${requestId}] 读取首包数据`);
        const { value: firstChunk, done: firstDone } = await reader.read();
        if (firstDone || !firstChunk) {
            logger.warn(`[${requestId}] 流式响应为空`);
            res.writeHead(503, { 'Content-Type': 'text/plain' });
            res.end('Empty Stream');
            logger.info(`[${requestId}] 请求结束，总耗时: ${Date.now() - startTime}ms`);
            return;
        }
        
        const firstText = decoder.decode(firstChunk, { stream: true });
        logger.debug(`[${requestId}] 首包前200字符: ${firstText.substring(0, 200)}...`);
        
        // 如果首包就是 DONE 且没有任何 content，判定为空回
        if (firstText.includes("data: [DONE]") && !firstText.includes('"content"')) {
            logger.warn(`[${requestId}] 流式响应立即结束，无实际内容`);
            res.writeHead(503, { 'Content-Type': 'text/plain' });
            res.end('Stream Closed Immediately');
            logger.info(`[${requestId}] 请求结束，总耗时: ${Date.now() - startTime}ms`);
            return;
        }
        
        // 检查首包是否包含FINISHED
        const firstChunkHasTerminator = firstText.includes(TERMINATOR);
        if (firstChunkHasTerminator) {
            logger.info(`[${requestId}] 首包包含FINISHED终结符`);
        }
        
        // [步骤 B] 构造输出流
        logger.info(`[${requestId}] 开始发送流式响应`);
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive'
        });
        
        let timer = null;
        let chunkCount = 0;
        let totalBytes = 0;
        let terminatorFound = false;
        let streamFinishedNormally = false;
        
        // 强制结束函数
        const terminateStream = () => {
            if (timer) {
                clearTimeout(timer);
                timer = null;
                logger.info(`[${requestId}] 8秒超时计时器已清除`);
            }
            try {
                logger.info(`[${requestId}] 发送流结束标记: data: [DONE]`);
                res.write(encoder.encode("\ndata: [DONE]\n\n"));
                res.end();
                streamFinishedNormally = true;
            } catch (e) {
                logger.warn(`[${requestId}] 发送流结束标记时出错: ${e.message}`);
            }
        };
        
        // 8秒计时器：只有在流运行期间有效
        const resetTimer = () => {
            if (timer) {
                clearTimeout(timer);
            }
            timer = setTimeout(() => {
                logger.info(`[${requestId}] 8秒超时，强制结束流`);
                terminateStream();
            }, TIMEOUT_MS);
            logger.debug(`[${requestId}] 重置8秒超时计时器`);
        };
        
        // 处理并发送数据块
        const processAndEnqueue = (chunk) => {
            chunkCount++;
            totalBytes += chunk.length;
            
            let chunkText = decoder.decode(chunk, { stream: true });
            
            // 检查 FINISHED 终结符
            if (!terminatorFound && chunkText.includes(TERMINATOR)) {
                terminatorFound = true;
                logger.info(`[${requestId}] 第${chunkCount}个数据块中发现FINISHED终结符`);
                
                // 擦除单词
                const beforeReplace = chunkText;
                chunkText = chunkText.replace(new RegExp(TERMINATOR, 'g'), '');
                
                if (beforeReplace !== chunkText) {
                    logger.info(`[${requestId}] 已移除FINISHED，原长度: ${beforeReplace.length}，新长度: ${chunkText.length}`);
                }
                
                res.write(encoder.encode(chunkText));
                // 立即终结
                logger.info(`[${requestId}] 发现FINISHED，立即结束流`);
                terminateStream();
                return true; 
            }
            
            // 检查是否有content字段
            const hasContent = chunkText.includes('"content"');
            if (hasContent) {
                logger.debug(`[${requestId}] 第${chunkCount}个数据块包含content字段`);
            }
            
            res.write(encoder.encode(chunkText));
            return false;
        };
        
        // 发送首包并开始计时
        const wasTerminated = processAndEnqueue(firstChunk);
        if (!wasTerminated) {
            logger.debug(`[${requestId}] 首包发送完成，开始8秒超时计时`);
            resetTimer();
            
            // 循环读取
            try {
                while (true) {
                    const { done, value } = await reader.read();
                    
                    if (done) {
                        logger.info(`[${requestId}] 流式响应自然结束，共${chunkCount}个数据块，${totalBytes}字节`);
                        if (timer) {
                            clearTimeout(timer);
                            timer = null;
                        }
                        try {
                            logger.info(`[${requestId}] 发送自然结束标记: data: [DONE]`);
                            res.write(encoder.encode("\ndata: [DONE]\n\n"));
                            res.end();
                            streamFinishedNormally = true;
                        } catch (e) {
                            logger.warn(`[${requestId}] 发送自然结束标记时出错: ${e.message}`);
                        }
                        break;
                    }
                    
                    const shouldStop = processAndEnqueue(value);
                    if (shouldStop) {
                        logger.info(`[${requestId}] 处理函数要求停止流`);
                        break;
                    }
                    
                    resetTimer(); // 收到新数据，重置 8 秒
                }
            } catch (e) {
                logger.error(`[${requestId}] 读取流时出错: ${e.message}`);
                if (timer) {
                    clearTimeout(timer);
                    timer = null;
                }
                try {
                    res.write(encoder.encode("\ndata: [DONE]\n\n"));
                    res.end();
                    streamFinishedNormally = true;
                } catch (endError) {
                    logger.error(`[${requestId}] 发送错误结束标记时出错: ${endError.message}`);
                }
            }
        }
        
        // 记录流处理结果
        setTimeout(() => {
            const totalTime = Date.now() - startTime;
            logger.info(`[${requestId}] 流式请求处理完成，状态: ${streamFinishedNormally ? '正常结束' : '异常结束'}, 总耗时: ${totalTime}ms, 数据块: ${chunkCount}, 总字节: ${totalBytes}, 发现TERMINATOR: ${terminatorFound}`);
        }, 100);
        
    } catch (err) {
        logger.error(`[${requestId}] Worker处理错误: ${err.message}`);
        logger.error(`[${requestId}] 错误堆栈: ${err.stack}`);
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end(`Worker Error: ${err.message}`);
        logger.info(`[${requestId}] 请求异常结束，总耗时: ${Date.now() - startTime}ms`);
    }
});

// 启动服务器
server.listen(WORKER_PORT, () => {
    logger.info(`Worker代理服务启动成功，监听端口: ${WORKER_PORT}`);
    logger.info(`超时设置: ${TIMEOUT_MS}ms`);
    logger.info(`终结符: "${TERMINATOR}"`);
    logger.info(`使用方法:`);
    logger.info(`  1. 代理外部服务: /worker/https://api.openai.com/v1/...`);
    logger.info(`  2. 代理内部DeepSeek: /worker/http://127.0.0.1:5001/v1/...`);
    logger.info(`  3. 代理内部Qwen: /worker/http://127.0.0.1:3000/v1/...`);
    logger.info(`  4. 代理内部QwenChat: /worker/http://127.0.0.1:8000/v1/...`);
    logger.info(`  5. 代理内部TTS: /worker/http://127.0.0.1:5050/v1/...`);
});

// 优雅关闭
process.on('SIGTERM', () => {
    logger.info('收到SIGTERM信号，准备关闭服务');
    server.close(() => {
        logger.info('Worker服务已关闭');
        process.exit(0);
    });
});

process.on('SIGINT', () => {
    logger.info('收到SIGINT信号，准备关闭服务');
    server.close(() => {
        logger.info('Worker服务已关闭');
        process.exit(0);
    });
});
