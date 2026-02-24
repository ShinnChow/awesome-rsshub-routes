const fs = require('fs');
const https = require('https');
const http = require('http');

// 从 OPML 文件提取所有 RSS 链接
function extractFeedsFromOPML(opmlPath) {
  const content = fs.readFileSync(opmlPath, 'utf8');
  const feeds = [];
  
  // 匹配所有 outline 标签中的 xmlUrl 和 text
  const regex = /<outline[^>]*text="([^"]*)"[^>]*xmlUrl="([^"]*)"/g;
  let match;
  
  while ((match = regex.exec(content)) !== null) {
    feeds.push({
      name: match[1],
      url: match[2]
    });
  }
  
  return feeds;
}

// 发起单次 HTTP 请求
function doRequest(url, headers, timeout = 30000) {
  return new Promise((resolve) => {
    const protocol = url.startsWith('https') ? https : http;

    const options = {
      timeout: timeout,
      headers: headers,
      rejectUnauthorized: false // 忽略证书错误，避免误报
    };

    const req = protocol.get(url, options, (res) => {
      resolve({ statusCode: res.statusCode, error: null });
    });

    req.on('error', (err) => {
      resolve({ statusCode: null, error: err.message });
    });

    req.on('timeout', () => {
      req.destroy();
      resolve({ statusCode: null, error: 'Timeout' });
    });
  });
}

// 检查单个 URL 是否可访问（带统一重试机制）
async function checkUrl(url, timeout = 30000) {
  const defaultHeaders = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'application/rss+xml, application/xml, text/xml, */*'
  };
  const retryHeaders = {
    'User-Agent': defaultHeaders['User-Agent'],
    'Accept': '*/*'
  };

  let { statusCode, error } = await doRequest(url, defaultHeaders, timeout);

  // 证书错误不算失效
  if (error && error.includes('certificate')) {
    return { valid: true, statusCode: null, error: null };
  }

  // 判断首次请求是否成功
  const isValid = (code) => code && (code < 400 || code === 403 || code === 405);

  if (isValid(statusCode)) {
    return { valid: true, statusCode, error: null };
  }

  // 404 是明确的资源不存在，不重试
  if (statusCode === 404) {
    return { valid: false, statusCode, error: 'HTTP 404' };
  }

  // 其他所有失败情况（4xx/5xx/网络错误/超时）统一重试一次
  await delay(1000);
  const retry = await doRequest(url, retryHeaders, timeout);

  if (retry.error && retry.error.includes('certificate')) {
    return { valid: true, statusCode: null, error: null };
  }

  if (isValid(retry.statusCode)) {
    return { valid: true, statusCode: retry.statusCode, error: null };
  }

  return {
    valid: false,
    statusCode: retry.statusCode || statusCode,
    error: retry.error || `HTTP ${retry.statusCode || statusCode}`
  };
}

// 延迟函数
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// 主函数
async function main() {
  console.log('🔍 开始检测 RSS 订阅源...\n');
  
  const opmlPath = './feeds.opml';
  
  if (!fs.existsSync(opmlPath)) {
    console.error('❌ 找不到 feeds.opml 文件');
    process.exit(1);
  }
  
  const feeds = extractFeedsFromOPML(opmlPath);
  console.log(`📋 共找到 ${feeds.length} 个订阅源\n`);
  
  const results = [];
  let validCount = 0;
  let invalidCount = 0;
  
  for (let i = 0; i < feeds.length; i++) {
    const feed = feeds[i];
    process.stdout.write(`[${i + 1}/${feeds.length}] 检测 ${feed.name}... `);
    
    const result = await checkUrl(feed.url);
    
    if (result.valid) {
      console.log(`✅ OK (${result.statusCode})`);
      validCount++;
    } else {
      console.log(`❌ 失败 (${result.error})`);
      invalidCount++;
    }
    
    results.push({
      name: feed.name,
      url: feed.url,
      valid: result.valid,
      statusCode: result.statusCode,
      error: result.error
    });
    
    // 避免请求过快
    await delay(500);
  }
  
  // 生成北京时间 (UTC+8)
  const now = new Date();
  const beijingTime = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  const checkTimeStr = beijingTime.toISOString().replace('T', ' ').substring(0, 19) + ' (北京时间)';
  
  // 生成报告
  const report = {
    checkTime: checkTimeStr,
    total: feeds.length,
    valid: validCount,
    invalid: invalidCount,
    successRate: `${((validCount / feeds.length) * 100).toFixed(1)}%`,
    feeds: results
  };
  
  // 保存结果
  fs.writeFileSync('feed-status.json', JSON.stringify(report, null, 2));
  
  console.log('\n' + '='.repeat(50));
  console.log(`📊 检测完成！`);
  console.log(`   ✅ 可用: ${validCount}`);
  console.log(`   ❌ 失效: ${invalidCount}`);
  console.log(`   📈 成功率: ${report.successRate}`);
  console.log('='.repeat(50));
  
  // 如果有失效链接，列出来
  if (invalidCount > 0) {
    console.log('\n⚠️ 失效链接列表:');
    results.filter(r => !r.valid).forEach(r => {
      console.log(`   - ${r.name}: ${r.error}`);
    });
    
    // 设置退出码为 1，触发 GitHub Actions 的失败处理
    process.exit(1);
  }
}

main().catch(err => {
  console.error('脚本执行出错:', err);
  process.exit(1);
});
