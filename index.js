import { Telegraf } from 'telegraf';
import express from 'express';
import cors from 'cors';
import cron from 'node-cron';
import fs from 'fs/promises';

const {
  BOT_TOKEN,
  CHAT_ID,
  IRIS_USERNAME = '',
  CRON_SCHEDULE = '0 */6 * * *',
  PORT = 3000,
  ALLOWED_ORIGIN = '*',
  STATS_COMMAND = 'Стата вся',
} = process.env;

if (!BOT_TOKEN || !CHAT_ID) {
  console.error('BOT_TOKEN и CHAT_ID обязательны — задайте их в переменных окружения Railway');
  process.exit(1);
}

const STATS_FILE = './stats.json';

const bot = new Telegraf(BOT_TOKEN);
const app = express();
app.use(cors({ origin: ALLOWED_ORIGIN }));

let latestStats = null;

async function loadStats() {
  try {
    const raw = await fs.readFile(STATS_FILE, 'utf-8');
    latestStats = JSON.parse(raw);
    console.log('Загружена сохранённая статистика от', latestStats.updatedAt);
  } catch {
    console.log('Сохранённой статистики пока нет — жду первого ответа Iris');
  }
}

async function saveStats(stats) {
  latestStats = stats;
  await fs.writeFile(STATS_FILE, JSON.stringify(stats, null, 2), 'utf-8');
}

// Разбирает текст ответа Iris вида:
// 1. отец кф — 581
// 2. DESERVELLER — 556
// ...
// Всего сообщений: 2 382
function parseIrisMessage(text) {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const top = [];
  const itemRegex = /^(\d+)\.\s*(.+?)\s*[—-]\s*(\d[\d\s]*)$/;

  for (const line of lines) {
    const m = line.match(itemRegex);
    if (m) {
      top.push({
        place: Number(m[1]),
        name: m[2].trim(),
        count: Number(m[3].replace(/\s/g, '')),
      });
    }
  }

  const totalMatch = text.match(/Всего сообщени[йя]:\s*([\d\s]+)/i);
  const total = totalMatch ? Number(totalMatch[1].replace(/\s/g, '')) : null;

  if (top.length === 0 && total === null) return null;
  return { top, total };
}

// Слушаем все сообщения в нужном чате
bot.on('message', async (ctx) => {
  try {
    if (String(ctx.chat.id) !== String(CHAT_ID)) return;

    const msg = ctx.message;
    const text = msg.text || msg.caption;
    if (!text) return;

    // Если задан username Iris — фильтруем строго по нему
    const fromUsername = msg.from?.username?.toLowerCase() || '';
    if (IRIS_USERNAME && fromUsername !== IRIS_USERNAME.toLowerCase()) return;

    // Грубый фильтр, чтобы не парсить случайные сообщения
    if (!/статистика/i.test(text) && !/Всего сообщени[йя]/i.test(text)) return;

    const parsed = parseIrisMessage(text);
    if (parsed) {
      await saveStats({ ...parsed, updatedAt: new Date().toISOString() });
      console.log('Статистика обновлена, всего сообщений:', parsed.total);
    }
  } catch (err) {
    console.error('Ошибка обработки сообщения:', err);
  }
});

async function requestStats() {
  try {
    await bot.telegram.sendMessage(CHAT_ID, STATS_COMMAND);
    console.log('Команда отправлена в чат:', STATS_COMMAND);
  } catch (err) {
    console.error('Не удалось отправить команду в чат:', err);
  }
}

cron.schedule(CRON_SCHEDULE, requestStats);

app.get('/api/stats', (req, res) => {
  if (!latestStats) {
    return res.status(503).json({ error: 'Статистика ещё не получена, попробуйте позже' });
  }
  res.json(latestStats);
});

// Ручной запуск обновления (для проверки, например /api/refresh?key=...)
app.get('/api/refresh', async (req, res) => {
  await requestStats();
  res.json({ ok: true, message: 'Запрос отправлен в чат, ответ Iris придёт в течение минуты' });
});

app.get('/health', (req, res) => res.json({ ok: true }));

await loadStats();

app.listen(PORT, () => console.log(`HTTP сервер запущен на порту ${PORT}`));

bot.launch().then(() => console.log('Telegram-бот запущен'));

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
