import 'dotenv/config';
import express from 'express';
import {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  PermissionsBitField
} from 'discord.js';

import { initDb, ensureTables } from './db.js';

// ---------------------- ENV ----------------------
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;
const PORT = process.env.PORT ?? 3000;
const WEBHOOK_CHANNEL_ID = process.env.WEBHOOK_CHANNEL_ID ?? null;
const DEFAULT_TZ = process.env.TIMEZONE_OFFSET ?? 'UTC+0';
const DEFAULT_LOSS = parseFloat(process.env.LOSS_MULTIPLIER ?? '1.0');

if (!DISCORD_TOKEN || !CLIENT_ID || !GUILD_ID) {
  console.error('Missing DISCORD_TOKEN, CLIENT_ID or GUILD_ID');
  process.exit(1);
}

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('Missing DATABASE_URL');
  process.exit(1);
}

// ---------------------- DB INIT ----------------------
const pool = initDb(DATABASE_URL);

(async () => {
  try {
    await ensureTables();
  } catch (err) {
    console.error("Error initializing database tables:", err);
    process.exit(1);
  }
})();

// ---------------------- UTILS ----------------------
function classifyRarity(kg) {
  if (kg >= 4.0 && kg < 5.0) return 'semi_huge';
  if (kg >= 5.0 && kg < 7.0) return 'huge';
  if (kg >= 7.0 && kg < 8.0) return 'semi_titan';
  if (kg >= 8.0 && kg < 9.0) return 'titan';
  if (kg >= 9.0 && kg <= 15.0) return 'godly';
  return null;
}

async function safeDefer(interaction, ephemeral = false) {
  if (!interaction.deferred && !interaction.replied) {
    try {
      await interaction.deferReply({ ephemeral });
    } catch (_) {}
  }
}

async function getSettings(guildId) {
  const res = await pool.query(
    'SELECT webhook_channel_id, timezone_offset, loss_multiplier FROM settings WHERE guild_id = $1',
    [guildId]
  );

  if (!res.rowCount) {
    return {
      webhook_channel_id: WEBHOOK_CHANNEL_ID,
      timezone_offset: DEFAULT_TZ,
      loss_multiplier: DEFAULT_LOSS
    };
  }

  const r = res.rows[0];
  return {
    webhook_channel_id: r.webhook_channel_id || WEBHOOK_CHANNEL_ID,
    timezone_offset: r.timezone_offset || DEFAULT_TZ,
    loss_multiplier: parseFloat(r.loss_multiplier || DEFAULT_LOSS)
  };
}

async function saveSettings(guildId, channelId, timezone, lossMultiplier) {
  await pool.query(
    `
    INSERT INTO settings (guild_id, webhook_channel_id, timezone_offset, loss_multiplier)
    VALUES ($1,$2,$3,$4)
    ON CONFLICT (guild_id)
    DO UPDATE SET webhook_channel_id=$2, timezone_offset=$3, loss_multiplier=$4
  `,
    [guildId, channelId, timezone, lossMultiplier]
  );
}

async function insertLog(guildId, eggName, weight, rarity) {
  await pool.query(
    'INSERT INTO hatch_logs (guild_id, egg_name, weight, rarity) VALUES ($1,$2,$3,$4)',
    [guildId, eggName, weight, rarity]
  );
}

async function countSince(guildId, sinceTs) {
  const res = await pool.query(
    'SELECT COUNT(*) FROM hatch_logs WHERE guild_id=$1 AND hatched_at >= $2',
    [guildId, sinceTs]
  );
  return parseInt(res.rows[0].count, 10);
}

async function countPerEggSince(guildId, sinceTs) {
  const res = await pool.query(
    'SELECT egg_name, COUNT(*) as cnt FROM hatch_logs WHERE guild_id=$1 AND hatched_at >= $2 GROUP BY egg_name ORDER BY cnt DESC',
    [guildId, sinceTs]
  );
  return res.rows;
}

async function countRaritySince(guildId, sinceTs) {
  const res = await pool.query(
    'SELECT rarity, COUNT(*) as cnt FROM hatch_logs WHERE guild_id=$1 AND hatched_at >= $2 GROUP BY rarity',
    [guildId, sinceTs]
  );

  const map = { semi_huge: 0, huge: 0, semi_titan: 0, titan: 0, godly: 0 };
  for (const row of res.rows) {
    if (row.rarity) map[row.rarity] = parseInt(row.cnt, 10);
  }
  return map;
}

// ---------------------- DISCORD CLIENT ----------------------
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages]
});

client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}`);
});

// ---------------------- REGISTER COMMANDS ----------------------
const commands = [
  new SlashCommandBuilder()
    .setName('setup')
    .setDescription('Configure egg tracker (admin)')
    .addChannelOption(o => o.setName('log_channel').setDescription('Channel to log hatches').setRequired(true))
    .addStringOption(o => o.setName('timezone').setDescription('Timezone like UTC+8'))
    .addNumberOption(o => o.setName('loss_multiplier').setDescription('Loss multiplier')),

  new SlashCommandBuilder()
    .setName('dailycount')
    .setDescription('Show today\'s egg summary'),

  new SlashCommandBuilder()
    .setName('egg')
    .setDescription('Count eggs for a type and period')
    .addStringOption(o => o.setName('egg_type').setDescription('Egg type or All').setRequired(true))
    .addStringOption(o => o.setName('period').setDescription('today|24h|2d|7d|30d').setRequired(true))
];

const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);

(async () => {
  try {
    console.log("Registering commands...");
    await rest.put(
      Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
      { body: commands.map(c => c.toJSON()) }
    );
    console.log("Commands registered.");
  } catch (err) {
    console.error('Failed to register commands:', err);
  }
})();

// ---------------------- INTERACTIONS ----------------------
client.on('interactionCreate', async interaction => {
  try {
    if (!interaction.isChatInputCommand()) return;

    const guildId = interaction.guildId;
    if (!guildId) return;

    // SAFELY defer EVERY command (prevents interaction expiration)
    await safeDefer(interaction, false);

    // ----------- /setup -----------
    if (interaction.commandName === 'setup') {
      const hasAdmin = interaction.memberPermissions?.has(PermissionsBitField.Flags.Administrator);

      // Secure admin-only + EPHEMERAL
      if (!hasAdmin) {
        await interaction.editReply({ content: 'You must be an Administrator to run /setup', ephemeral: true });
        return;
      }

      const channel = interaction.options.getChannel('log_channel', true);
      const tz = interaction.options.getString('timezone') ?? DEFAULT_TZ;
      const loss = interaction.options.getNumber('loss_multiplier') ?? DEFAULT_LOSS;

      await saveSettings(guildId, channel.id, tz, loss);

      await interaction.editReply({
        content: `✅ **Settings updated**\n- Log Channel: <#${channel.id}>\n- Timezone: ${tz}\n- Loss Multiplier: x${loss}`,
        ephemeral: true  // your requested Option B
      });
      return;
    }

    // ----------- /dailycount -----------
    if (interaction.commandName === 'dailycount') {
      const settings = await getSettings(guildId);
      const tz = settings.timezone_offset;
      const match = tz.match(/UTC([+-]\d{1,2})/i);

      let offsetHours = match ? parseInt(match[1], 10) : 0;

      const now = new Date();
      const localMidnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
      localMidnight.setUTCHours(localMidnight.getUTCHours() - offsetHours);
      const sinceTs = localMidnight.toISOString();

      const total = await countSince(guildId, sinceTs);
      const perEgg = await countPerEggSince(guildId, sinceTs);
      const rarity = await countRaritySince(guildId, sinceTs);

      let msg = `**EGG TRACKER — DAILY REPORT**\n\n**Total Eggs:** ${total}\n\n**Eggs:**\n`;
      if (!perEgg.length) msg += `- None -\n`;
      else perEgg.forEach(r => msg += `- ${r.egg_name}: ${r.cnt}\n`);

      msg += `\n**Rarities:**\nSemi-Huge: ${rarity.semi_huge}\nHuge: ${rarity.huge}\nSemi-Titan: ${rarity.semi_titan}\nTitan: ${rarity.titan}\nGodly: ${rarity.godly}\n`;

      await interaction.editReply(msg);
      return;
    }

    // ----------- /egg -----------
    if (interaction.commandName === 'egg') {
      const eggType = interaction.options.getString('egg_type', true);
      const period = interaction.options.getString('period', true);

      const now = new Date();
      let since = new Date();

      if (period === 'today') {
        const settings = await getSettings(guildId);
        const tz = settings.timezone_offset;
        const match = tz.match(/UTC([+-]\d{1,2})/i);
        let offsetHours = match ? parseInt(match[1], 10) : 0;

        const localMidnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
        localMidnight.setUTCHours(localMidnight.getUTCHours() - offsetHours);
        since = localMidnight;
      } else if (period.endsWith('d')) {
        since.setDate(now.getDate() - parseInt(period));
      } else if (period === '24h') {
        since.setHours(now.getHours() - 24);
      } else {
        since.setHours(now.getHours() - 24);
      }

      const sinceTs = since.toISOString();

      if (eggType.toLowerCase() === 'all') {
        const perEgg = await countPerEggSince(guildId, sinceTs);
        let reply = `Egg counts since ${sinceTs}:\n`;
        if (!perEgg.length) reply += '- None -\n';
        else perEgg.forEach(r => reply += `- ${r.egg_name}: ${r.cnt}\n`);
        await interaction.editReply(reply);
      } else {
        const res = await pool.query(
          'SELECT COUNT(*) FROM hatch_logs WHERE guild_id=$1 AND egg_name=$2 AND hatched_at >= $3',
          [guildId, eggType, sinceTs]
        );
        const cnt = parseInt(res.rows[0].count, 10);
        await interaction.editReply(`${eggType} hatched in the period: ${cnt}`);
      }
      return;
    }

  } catch (err) {
    console.error("Interaction error:", err);
    try {
      await interaction.editReply("❌ An internal error occurred.");
    } catch (_) {}
  }
});

// ---------------------- WEBHOOK SERVICE ----------------------
const app = express();
app.use(express.json({ limit: '1mb' }));

function parseWebhookPayload(body) {
  let eggName = null;
  let weight = 0;

  if (body.embeds?.length) {
    const e = body.embeds[0];

    if (Array.isArray(e.fields)) {
      for (const f of e.fields) {
        const name = (f.name || "").toLowerCase();
        const val = (f.value || "").toString();

        if (name.includes("from")) {
          eggName = val.replace(/egg/gi, "").trim();
        }

        if (name.includes("weight")) {
          const m = val.match(/([0-9]+(?:\.[0-9]+)?)/);
          if (m) weight = parseFloat(m[1]);
        }
      }
    }

    if (!eggName && e.title) eggName = e.title;
  }

  if (!eggName && body.content) {
    const m = body.content.match(/Hatched From\s*[:\-]\s*(.+)/i);
    if (m) eggName = m[1].replace(/egg/gi, "").trim();
  }

  const weightMatch = JSON.stringify(body).match(/([0-9]+(\.[0-9]+)?)\s*kg/i);
  if (!weight && weightMatch) weight = parseFloat(weightMatch[1]);

  if (!eggName) eggName = "Unknown";
  return { eggName, weight };
}

app.post('/webhook', async (req, res) => {
  try {
    const payload = req.body;
    const { eggName, weight } = parseWebhookPayload(payload);
    const rarity = classifyRarity(weight);

    const channelId = payload?.channel_id || WEBHOOK_CHANNEL_ID;

    const sres = await pool.query(
      'SELECT guild_id, loss_multiplier FROM settings WHERE webhook_channel_id = $1',
      [channelId]
    );

    let guildId = sres.rowCount ? sres.rows[0].guild_id : null;

    if (!guildId) {
      const fallback = await pool.query('SELECT guild_id FROM settings LIMIT 1');
      if (fallback.rowCount) guildId = fallback.rows[0].guild_id;
    }

    if (!guildId) {
      console.log("Webhook received but no guild found for channel", channelId);
      await insertLog("unknown", eggName, weight, rarity);
    } else {
      await insertLog(guildId, eggName, weight, rarity);
    }

    console.log(`Logged hatch: ${eggName}, ${weight}kg, rarity: ${rarity}`);
    res.sendStatus(200);

  } catch (err) {
    console.error("Webhook parse error:", err);
    res.sendStatus(500);
  }
});

// ---------------------- START SERVER ----------------------
client.login(DISCORD_TOKEN);
app.listen(PORT, () => {
  console.log(`Webhook listener running on port ${PORT}`);
});
