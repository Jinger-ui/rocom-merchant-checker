require('dotenv').config();
const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.ROCOM_API_KEY || '';
const UPSTREAM = 'https://wegame.shallow.ink/api/v1/games/rocom/merchant/info';

// 托管前端静态文件（index.html、background.png 等）
app.use(express.static(path.join(__dirname)));

/* ========== Server酱 微信推送 ========== */

async function sendToWechat(title, content) {
  const sendKey = process.env.SERVER_CHAN_SENDKEY;

  if (!sendKey) {
    console.warn('未配置微信推送，已跳过');
    return { success: false, reason: 'not_configured' };
  }

  const url = `https://sctapi.ftqq.com/${sendKey}.send`;
  const body = new URLSearchParams();
  body.append('title', title);
  body.append('desp', content);

  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8' },
      body
    });
    const result = await resp.json();
    console.log('[Server酱] 推送结果:', JSON.stringify(result));

    if (result.code === 0 || result.errno === 0) {
      return { success: true };
    }
    return { success: false, reason: result.message || result.errmsg || '推送返回异常' };
  } catch (err) {
    console.error('[Server酱] 推送失败:', err.message);
    return { success: false, reason: '推送请求失败: ' + err.message };
  }
}

function formatItemsMarkdown(apiData) {
  const data = apiData.data || apiData;
  let items = [];

  // 路径 1：merchantActivities[].get_props[]
  const activities = data.merchantActivities || data.merchant_activities || data.activities;
  if (Array.isArray(activities)) {
    for (const act of activities) {
      const props = act.get_props || act.getProps || act.props || act.items || act.goods || [];
      if (Array.isArray(props)) items.push(...props);
    }
  }

  // 路径 2：扁平数组
  if (items.length === 0) {
    const flat = data.items || data.goods || data.list || data.products || data.props;
    if (Array.isArray(flat)) items = flat;
  }

  // 路径 3：data 本身是数组
  if (items.length === 0 && Array.isArray(data)) items = data;

  if (items.length === 0) return null;

  const now = Date.now();
  const activeItems = items.filter(raw => {
    const start = raw.start_time || raw.startTime || 0;
    const end = raw.end_time || raw.endTime || 0;
    if (!start || !end) return true;
    return start <= now && now <= end;
  });

  const list = (activeItems.length > 0 ? activeItems : items);

  const pad = n => String(n).padStart(2, '0');
  const fmtTime = ts => {
    if (!ts) return '';
    const d = new Date(ts);
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };

  const lines = list.map(raw => {
    const name = raw.name || raw.title || raw.itemName || raw.goodsName || '未知商品';
    const price = raw.price || raw.cost || raw.value || raw.need || null;
    const limit = raw.limit || raw.buyLimit || raw.buy_limit || raw.stock || raw.max || null;
    const start = raw.start_time || raw.startTime || 0;
    const end = raw.end_time || raw.endTime || 0;

    let line = `- **${name}**`;
    if (start && end) line += `  ⏰ ${fmtTime(start)}–${fmtTime(end)}`;
    if (price != null) line += `  💰${price}`;
    if (limit != null) line += `  📦限购${limit}`;
    return line;
  });

  const now_d = new Date();
  const header = `> 查询时间：${now_d.getFullYear()}-${pad(now_d.getMonth()+1)}-${pad(now_d.getDate())} ${pad(now_d.getHours())}:${pad(now_d.getMinutes())}`;

  return `${header}\n\n${lines.join('\n')}`;
}

/* ========== 代理路由 ========== */

app.get('/api/merchant', async (req, res) => {
  if (!API_KEY) {
    return res.status(500).json({
      code: -1,
      message: '未配置 ROCOM_API_KEY，请在 .env 中填写 API Key。'
    });
  }

  const refresh = req.query.refresh === 'true' ? 'true' : 'false';
  const wantPush = req.query.push === 'true';
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

    // 微信推送逻辑
    let pushStatus = null;
    if (wantPush) {
      const markdown = formatItemsMarkdown(data);
      if (markdown) {
        pushStatus = await sendToWechat('洛克王国旅行商人今日商品', markdown);
      } else {
        pushStatus = { success: false, reason: '无可推送的商品数据' };
      }
    }

    const response = Object.assign({}, data);
    response.pushStatus = pushStatus;
    res.json(response);
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
  if (!process.env.SERVER_CHAN_SENDKEY) {
    console.warn('⚠ 未配置 SERVER_CHAN_SENDKEY，微信推送功能不可用。');
  }
});
