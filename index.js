import 'dotenv/config';
import express from 'express';
import { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, PermissionsBitField } from 'discord.js';
import { initDb, ensureTables } from './db.js';

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID; // register commands to a guild for quick testing
const PORT = process.env.PORT ?? 3000;
const WEBHOOK_CHANNEL_ID = process.env.WEBHOOK_CHANNEL_ID ?? null;
const DEFAULT_TZ = process.env.TIMEZONE_OFFSET ?? 'UTC+0';
const DEFAULT_LOSS = parseFloat(process.env.LOSS_MULTIPLIER ?? '1.0');

if (!DISCORD_TOKEN || !CLIENT_ID || !GUILD_ID) {
  console.error('Missing DISCORD_TOKEN, CLIENT_ID or GUILD_ID in environment variables.');
  process.exit(1);
}

// --- DB init
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('Missing DATABASE_URL in environment variables.');
  process.exit(1);
}

const pool = initDb(DATABASE_URL);

(async () => {
  try {
    await ensureTables();
  } catch (err) {
    console.error('Error initializing database tables:', err);
    process.exit(1);
  }
})();

// --- Helper: classify rarity from kg
function classifyRarity(kg) {
  if (kg >= 4.0 && kg < 5.0) return 'semi_huge';
  if (kg >= 5.0 && kg < 7.0) return 'huge';
  if (kg >= 7.0 && kg < 8.0) return 'semi_titan';
  if (kg >= 8.0 && kg < 9.0) return 'titan';
  if (kg >= 9.0 && kg <= 15.0) return 'godly';
  return null;
}

// --- Discord client
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages]
});

// --- Slash commands to register
const commands = [
  new SlashCommandBuilder()
    .setName('setup')
    .setDescription('Configure egg tracker (admin)')
    .addChannelOption(opt => opt.setName('log_channel').setDescription('Channel where webhook posts').setRequired(true))
    .addStringOption(opt => opt.setName('timezone').setDescription('Timezone offset like UTC+8').setRequired(false))
    .addNumberOption(opt => opt.setName('loss_multiplier').setDescription('Loss multiplier (x1.0)').setRequired(false)),
  new SlashCommandBuilder()
    .setName('dailycount')
    .setDescription('Show today\'s egg summary'),
  new SlashCommandBuilder()
    .setName('egg')
    .setDescription('Count eggs for a type and period')
    .addStringOption(opt => opt.setName('egg_type').setDescription('Egg type or "All"').setRequired(true))
    .addStringOption(opt => opt.setName('period').setDescription('today|24h|2d|7d|30d').setRequired(true))
];

const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);

(async () => {
  try {
    console.log('Registering commands...');
    await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands.map(c => c.toJSON()) });
    console.log('Commands registered to guild.');
  } catch (err) {
    console.error('Failed registering commands', err);
  }
})();

// --- Correct ready event
client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}`);
});

// Helper: get settings for guild or defaults
async function getSettings(guildId) {
  const res = await pool.query('SELECT webhook_channel_id, timezone_offset, loss_multiplier FROM settings WHERE guild_id = $1', [guildId]);
  if (res.rowCount === 0) {
    return { webhook_channel_id: WEBHOOK_CHANNEL_ID, timezone_offset: DEFAULT_TZ, loss_multiplier: DEFAULT_LOSS };
  }
  const r = res.rows[0];
  return { webhook_channel_id: r.webhook_channel_id || WEBHOOK_CHANNEL_ID, timezone_offset: r.timezone_offset || DEFAULT_TZ, loss_multiplier: parseFloat(r.loss_multiplier || DEFAULT_LOSS) };
}

async function saveSettings(guildId, channelId, timezone, lossMultiplier) {
  await pool.query(`
    INSERT INTO settings (guild_id, webhook_channel_id, timezone_offset, loss_multiplier)
    VALUES ($1,$2,$3,$4)
    ON CONFLICT (guild_id) DO UPDATE SET webhook_channel_id = $2, timezone_offset = $3, loss_multiplier = $4
  `, [guildId, channelId, timezone, lossMultiplier]);
}

// Insert a hatch log
async function insertLog(guildId, eggName, weight, rarity) {
  await pool.query('INSERT INTO hatch_logs (guild_id, egg_name, weight, rarity) VALUES ($1,$2,$3,$4)', [guildId, eggName, weight, rarity]);
}

// Query helpers
async function countSince(guildId, sinceTs) {
  const res = await pool.query('SELECT COUNT(*) FROM hatch_logs WHERE guild_id = $1 AND hatched_at >= $2', [guildId, sinceTs]);
  return parseInt(res.rows[0].count, 10);
}

async function countPerEggSince(guildId, sinceTs) {
  const res = await pool.query('SELECT egg_name, COUNT(*) as cnt FROM hatch_logs WHERE guild_id = $1 AND hatched_at >= $2 GROUP BY egg_name ORDER BY cnt DESC', [guildId, sinceTs]);
  return res.rows;
}

async function countRaritySince(guildId, sinceTs) {
  const res = await pool.query(`SELECT rarity, COUNT(*) as cnt FROM hatch_logs WHERE guild_id = $1 AND hatched_at >= $2 GROUP BY rarity`, [guildId, sinceTs]);
  const map = { semi_huge:0, huge:0, semi_titan:0, titan:0, godly:0 };
  for (const row of res.rows) {
    if (row.rarity) map[row.rarity] = parseInt(row.cnt,10);
  }
  return map;
}

// --- Interaction handler
client.on('interactionCreate', async interaction => {
  try {
    if (!interaction.isChatInputCommand()) return;

    const guildId = interaction.guildId;
    if (!guildId) {
      await interaction.reply({ content: 'This command must be used in a server.', ephemeral: true });
      return;
    }

    if (interaction.commandName === 'setup') {
      // admin only: robust permission check
      const member = interaction.member;
      const hasAdmin = member && member.permissions && member.permissions.has && member.permissions.has(PermissionsBitField.Flags.Administrator);
      if (!hasAdmin) {
        await interaction.reply({ content: 'You must be an Administrator to run /setup', ephemeral: true });
        return;
      }

      const channel = interaction.options.getChannel('log_channel', true);
      const tz = interaction.options.getString('timezone') ?? DEFAULT_TZ;
      const loss = interaction.options.getNumber('loss_multiplier') ?? DEFAULT_LOSS;

      await saveSettings(guildId, channel.id, tz, loss);
      await interaction.reply({ content: `Saved settings:\nLog channel: <#${channel.id}>\nTimezone: ${tz}\nLoss multiplier: x${loss}`, ephemeral: false });
      return;
    }

    if (interaction.commandName === 'dailycount') {
      await interaction.deferReply(); // might take a moment
      const settings = await getSettings(guildId);
      const tz = settings.timezone_offset || DEFAULT_TZ;
      const match = tz.match(/UTC([+-]\d{1,2})/i);
      let offsetHours = 0;
      if (match) offsetHours = parseInt(match[1], 10);

      const now = new Date();
      const localMidnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0,0,0));
      localMidnight.setUTCHours(localMidnight.getUTCHours() - offsetHours);
      const sinceTs = localMidnight.toISOString();

      const total = await countSince(guildId, sinceTs);
      const perEgg = await countPerEggSince(guildId, sinceTs);
      const rarity = await countRaritySince(guildId, sinceTs);

      let msg = `EGG TRACKER — DAILY TRACK\n\nTotal Eggs Hatched: ${total}\n\nEggs:\n`;
      if (perEgg.length === 0) msg += '- None -\n';
      else perEgg.forEach(r => { msg += `- ${r.egg_name}: ${r.cnt}\n`; });

      msg += `\nSpecial:\nSemi-Huge: ${rarity.semi_huge || 0}\nHuge: ${rarity.huge || 0}\nSemi-Titan: ${rarity.semi_titan || 0}\nTitan: ${rarity.titan || 0}\nGodly: ${rarity.godly || 0}\n`;

      await interaction.editReply(msg);
      return;
    }

    if (interaction.commandName === 'egg') {
      await interaction.deferReply();
      const eggType = interaction.options.getString('egg_type', true);
      const period = interaction.options.getString('period', true);

      const now = new Date();
      let since = new Date();
      if (period === 'today') {
        const settings = await getSettings(interaction.guildId);
        const tz = settings.timezone_offset || DEFAULT_TZ;
        const match = tz.match(/UTC([+-]\d{1,2})/i);
        let offsetHours = 0;
        if (match) offsetHours = parseInt(match[1],10);
        const localMidnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0,0,0));
        localMidnight.setUTCHours(localMidnight.getUTCHours() - offsetHours);
        since = localMidnight;
      } else if (period.endsWith('d')) {
        const days = parseInt(period.replace('d',''),10) || 1;
        since.setDate(now.getDate() - days);
      } else if (period === '24h') {
        since.setHours(now.getHours() - 24);
      } else {
        since.setHours(now.getHours() - 24);
      }

      const sinceTs = since.toISOString();

      if (eggType.toLowerCase() === 'all') {
        const perEgg = await countPerEggSince(interaction.guildId, sinceTs);
        let reply = `Egg counts since ${sinceTs}:\n`;
        if (perEgg.length === 0) reply += '- None -\n';
        else perEgg.forEach(r => reply += `- ${r.egg_name}: ${r.cnt}\n`);
        await interaction.editReply(reply);
      } else {
        const res = await pool.query('SELECT COUNT(*) FROM hatch_logs WHERE guild_id=$1 AND egg_name=$2 AND hatched_at >= $3', [interaction.guildId, eggType, sinceTs]);
        const cnt = parseInt(res.rows[0].count,10);
        await interaction.editReply(`${eggType} hatched in the period: ${cnt}`);
      }
      return;
    }
  } catch (err) {
    console.error('Interaction handler error', err);
    // if interaction deferred, try to inform user; otherwise ignore
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply('An error occurred while processing the command.');
      } else {
        await interaction.reply({ content: 'An error occurred while processing the command.', ephemeral: true });
      }
    } catch (_) {}
  }
});

// --- Webhook endpoint
const app = express();
app.use(express.json({ limit: '1mb' }));

function parseWebhookPayload(body) {
  let eggName = null;
  let weight = 0;

  if (body.embeds && body.embeds.length > 0) {
    const e = body.embeds[0];
    if (e.fields && e.fields.length) {
      for (const f of e.fields) {
        const name = (f.name||'').toLowerCase();
        const val = (f.value||'').toString();
        if (name.includes('hatched from') || name.includes('from')) {
          eggName = val.replace(/egg/ig,'').trim();
        }
        if (name.includes('weight')) {
          const m = val.match(/([0-9]+(?:\.[0-9]+)?)/);
          if (m) weight = parseFloat(m[1]);
        }
      }
    }
    if (!eggName && e.title) eggName = e.title;
  }

  if (!eggName && body.content) {
    const m = body.content.match(/Hatched From\s*[:\-]\s*(.+)/i);
    if (m) eggName = m[1].replace(/egg/ig,'').trim();
  }

  if (!weight && JSON.stringify(body).match(/([0-9]+(\.[0-9]+)?)\s*kg/i)) {
    const m = JSON.stringify(body).match(/([0-9]+(\.[0-9]+)?)\s*kg/i);
    weight = parseFloat(m[1]);
  }

  if (!eggName) eggName = 'Unknown';
  return { eggName, weight };
}

app.post('/webhook', async (req, res) => {
  try {
    const payload = req.body;
    const { eggName, weight } = parseWebhookPayload(payload);
    const rarity = classifyRarity(weight);

    const channelId = payload?.channel_id || WEBHOOK_CHANNEL_ID;

    const sres = await pool.query('SELECT guild_id, loss_multiplier FROM settings WHERE webhook_channel_id = $1', [channelId]);
    let guildId;
    let lossMultiplier = DEFAULT_LOSS;
    if (sres.rowCount > 0) {
      guildId = sres.rows[0].guild_id;
      lossMultiplier = parseFloat(sres.rows[0].loss_multiplier || DEFAULT_LOSS);
    } else {
      const fall = await pool.query('SELECT guild_id, webhook_channel_id FROM settings LIMIT 1');
      if (fall.rowCount > 0) guildId = fall.rows[0].guild_id;
    }

    if (!guildId) {
      console.log('Webhook received but no guild mapping found for channel', channelId);
      await insertLog('unknown', eggName, weight, rarity);
    } else {
      await insertLog(guildId, eggName, weight, rarity);
    }

    console.log('Logged hatch:', eggName, weight, 'rarity:', rarity);
    res.sendStatus(200);
  } catch (err) {
    console.error('Webhook parse error', err);
    res.sendStatus(500);
  }
});

// Start
client.login(DISCORD_TOKEN);
app.listen(PORT, () => {
  console.log(`Webhook listener listening on port ${PORT}`);
});
