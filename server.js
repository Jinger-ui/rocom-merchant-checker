require('dotenv').config();
const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.ROCOM_API_KEY || '';
const UPSTREAM = 'https://wegame.shallow.ink/api/v1/games/rocom/merchant/info';

// 托管前端静态文件（index.html、background.png 等）
app.use(express.static(path.join(__dirname)));

// 代理路由：前端通过 /api/merchant 查询，后端转发到第三方 API
app.get('/api/merchant', async (req, res) => {
  if (!API_KEY) {
    return res.status(500).json({
      code: -1,
      message: '未配置 ROCOM_API_KEY，请在 .env 中填写 API Key。'
    });
  }

  const refresh = req.query.refresh === 'true' ? 'true' : 'false';
  const url = `${UPSTREAM}?refresh=${refresh}`;

  try {
    const upstream = await fetch(url, {
      headers: {
        'X-API-Key': API_KEY,
        'Authorization': API_KEY,
        'Accept': 'application/json'
      }
    });

    if (upstream.status === 401 || upstream.status === 403) {
      return res.status(upstream.status).json({
        code: upstream.status,
        message: 'API Key 缺失或无权限，请检查 .env 中的 ROCOM_API_KEY 是否正确。'
      });
    }

    if (upstream.status === 429) {
      return res.status(429).json({
        code: 429,
        message: '请求过于频繁，请稍后再试。'
      });
    }

    if (upstream.status >= 500) {
      return res.status(502).json({
        code: upstream.status,
        message: '第三方服务异常（HTTP ' + upstream.status + '），请稍后再试。'
      });
    }

    if (!upstream.ok) {
      return res.status(upstream.status).json({
        code: upstream.status,
        message: '第三方接口返回错误（HTTP ' + upstream.status + '）。'
      });
    }

    const data = await upstream.json();
    res.json(data);
  } catch (err) {
    console.error('[proxy] 请求第三方接口失败:', err.message);
    res.status(502).json({
      code: -2,
      message: '无法连接第三方接口，可能是网络问题或服务暂时不可用。'
    });
  }
});

app.listen(PORT, () => {
  console.log(`洛克王国旅行商人查询服务已启动: http://localhost:${PORT}`);
  if (!API_KEY) {
    console.warn('⚠ 未配置 ROCOM_API_KEY，请复制 .env.example 为 .env 并填入你的 API Key。');
  }
});
