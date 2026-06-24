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

  // 从 random_goods 构建名称 -> 价格/限购 映射
  const goodsLookup = {};
  const randomGoods = data.random_goods || data.randomGoods || [];
  if (Array.isArray(randomGoods)) {
    for (const g of randomGoods) {
      const key = (g.goods_name || g.name || '').trim();
      if (key) {
        goodsLookup[key] = {
          price: g.price || g.origin_price || null,
          limit: g.buy_limit_num || g.buyLimit || null
        };
      }
    }
  }

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
    const extra = goodsLookup[name] || {};
    const price = raw.price || raw.cost || raw.value || raw.need || extra.price || null;
    const limit = raw.limit || raw.buyLimit || raw.buy_limit || raw.stock || raw.max || extra.limit || null;
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

/* ========== 定时自动推送 ========== */

const ROUND_HOURS = [8, 12, 16, 20];
const ROUND_LABELS = ['第1轮', '第2轮', '第3轮', '第4轮'];
const RETRY_DELAY_MS = 2 * 60 * 1000;
const MAX_RETRIES = 3;

async function fetchAndPush(roundIndex, attempt) {
  if (!API_KEY || !process.env.SERVER_CHAN_SENDKEY) return;

  const label = ROUND_LABELS[roundIndex];
  const hour = ROUND_HOURS[roundIndex];
  console.log(`[定时推送] ${label}（${hour}:00）第 ${attempt} 次尝试...`);

  try {
    const resp = await fetch(`${UPSTREAM}?refresh=true`, {
      headers: {
        'X-API-Key': API_KEY,
        'Authorization': API_KEY,
        'Accept': 'application/json'
      }
    });

    if (!resp.ok) {
      console.warn(`[定时推送] API 返回 HTTP ${resp.status}`);
      if (attempt < MAX_RETRIES) {
        console.log(`[定时推送] ${RETRY_DELAY_MS / 1000}s 后重试...`);
        setTimeout(() => fetchAndPush(roundIndex, attempt + 1), RETRY_DELAY_MS);
      }
      return;
    }

    const data = await resp.json();
    if (data.code !== undefined && data.code !== 0) {
      console.warn(`[定时推送] API 业务错误: ${data.message}`);
      if (attempt < MAX_RETRIES) {
        setTimeout(() => fetchAndPush(roundIndex, attempt + 1), RETRY_DELAY_MS);
      }
      return;
    }

    const markdown = formatItemsMarkdown(data);
    if (!markdown) {
      console.warn('[定时推送] 无商品数据');
      if (attempt < MAX_RETRIES) {
        setTimeout(() => fetchAndPush(roundIndex, attempt + 1), RETRY_DELAY_MS);
      }
      return;
    }

    const title = `洛克王国远行商人 ${label}（${hour}:00）`;
    const result = await sendToWechat(title, markdown);
    if (result.success) {
      console.log(`[定时推送] ${label} 推送成功`);
    } else {
      console.warn(`[定时推送] ${label} 推送失败: ${result.reason}`);
    }
  } catch (err) {
    console.error(`[定时推送] 请求异常: ${err.message}`);
    if (attempt < MAX_RETRIES) {
      setTimeout(() => fetchAndPush(roundIndex, attempt + 1), RETRY_DELAY_MS);
    }
  }
}

function scheduleRounds() {
  if (!API_KEY) {
    console.warn('[定时推送] 未配置 ROCOM_API_KEY，定时推送不可用');
    return;
  }
  if (!process.env.SERVER_CHAN_SENDKEY) {
    console.warn('[定时推送] 未配置 SERVER_CHAN_SENDKEY，定时推送不可用');
    return;
  }

  function tick() {
    const now = new Date();
    const h = now.getHours();
    const m = now.getMinutes();

    for (let i = 0; i < ROUND_HOURS.length; i++) {
      // 在整点后 1 分钟触发（给 API 一点缓冲时间）
      if (h === ROUND_HOURS[i] && m === 1) {
        fetchAndPush(i, 1);
      }
    }
  }

  // 每 60 秒检查一次是否到了推送时间
  setInterval(tick, 60 * 1000);

  // 启动时立即检查，如果当前恰好在某个轮次的前几分钟内，也触发一次
  const now = new Date();
  const h = now.getHours();
  const m = now.getMinutes();
  for (let i = 0; i < ROUND_HOURS.length; i++) {
    if (h === ROUND_HOURS[i] && m <= 5) {
      console.log(`[定时推送] 启动时检测到当前正处于 ${ROUND_LABELS[i]} 时段，立即推送`);
      fetchAndPush(i, 1);
      break;
    }
  }

  console.log('[定时推送] 定时任务已启动，将在 08:01 / 12:01 / 16:01 / 20:01 自动推送');
}

/* ========== 启动服务 ========== */

app.listen(PORT, () => {
  console.log(`洛克王国旅行商人查询服务已启动: http://localhost:${PORT}`);
  if (!API_KEY) {
    console.warn('⚠ 未配置 ROCOM_API_KEY，请复制 .env.example 为 .env 并填入你的 API Key。');
  }
  if (!process.env.SERVER_CHAN_SENDKEY) {
    console.warn('⚠ 未配置 SERVER_CHAN_SENDKEY，微信推送功能不可用。');
  }
  scheduleRounds();
});
