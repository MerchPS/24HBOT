// server.js - Optimized for Replit
const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Client } = require("discord.js-selfbot-v13");

const app = express();
app.use(cors());
app.use(bodyParser.json());

// =======================
// REplit CONFIG
// =======================
const IS_REPLIT = process.env.REPLIT_DB_URL !== undefined;
const PORT = process.env.PORT || 3000;
const CHANNEL_ID = process.env.CHANNEL_ID || "1443222975179391066";

// Storage untuk Replit (gunakan /home/runner/...)
const DATA_DIR = path.join(process.cwd(), "data");
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

const STORAGE_PATH = path.join(DATA_DIR, "tokens.json");
const STATS_PATH = path.join(DATA_DIR, "stats.json");

console.log("🚀 Starting Discord Bot Controller");
console.log("📁 Data directory:", DATA_DIR);
console.log("🌍 Running on Replit:", IS_REPLIT);

// Storage
const bots = new Map();
const globalStats = {
    totalMessagesSent: 0,
    totalWorkCommands: 0,
    totalDepositCommands: 0,
    totalGiveCommands: 0,
    totalEarnings: 0,
    botSessions: 0,
    lastActivity: new Date().toISOString()
};

// Utility
function previewFromToken(token) {
    if (!token) return "invalid";
    const hash = crypto.createHash('md5').update(token.trim()).digest('hex');
    return `bot_${hash.slice(0, 8)}`;
}

function loadSavedTokens() {
    if (!fs.existsSync(STORAGE_PATH)) {
        console.log("📭 No saved tokens file found, creating new...");
        return [];
    }
    try {
        const content = fs.readFileSync(STORAGE_PATH, "utf8");
        const data = JSON.parse(content) || [];
        console.log(`📂 Loaded ${data.length} saved tokens`);
        return data;
    } catch (e) {
        console.error("❌ Error loading tokens:", e.message);
        return [];
    }
}

function saveSavedTokens(list) {
    try {
        fs.writeFileSync(STORAGE_PATH, JSON.stringify(list, null, 2));
        console.log(`💾 Saved ${list.length} tokens`);
    } catch (e) {
        console.error("❌ Error saving tokens:", e.message);
    }
}

function loadStats() {
    if (!fs.existsSync(STATS_PATH)) return globalStats;
    try {
        const content = fs.readFileSync(STATS_PATH, "utf8");
        return JSON.parse(content) || globalStats;
    } catch (e) {
        console.error("Error loading stats:", e.message);
        return globalStats;
    }
}

function saveStats() {
    globalStats.lastActivity = new Date().toISOString();
    try {
        fs.writeFileSync(STATS_PATH, JSON.stringify(globalStats, null, 2));
    } catch (e) {
        console.error("Error saving stats:", e.message);
    }
}

function pushLog(preview, level, text) {
    const b = bots.get(preview);
    if (!b) return;
    
    if (!b.logs) b.logs = [];
    
    const logEntry = { 
        ts: Date.now(), 
        level, 
        text,
        time: new Date().toLocaleTimeString('en-US', { hour12: false })
    };
    
    b.logs.unshift(logEntry);
    if (b.logs.length > 200) b.logs.pop();
    
    // Log ke console juga
    console.log(`[${preview}] ${level}: ${text}`);
}

function formatNumber(num) {
    return num.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
}

// Parse UnbelievaBoat Embed
function parseUnbelievaBoatEmbed(embed, botUsername) {
    try {
        if (embed.author && embed.author.name) {
            const embedUsername = embed.author.name.toLowerCase();
            const botUserLower = botUsername.toLowerCase();
            
            if (embedUsername.includes(botUserLower) || 
                botUserLower.includes(embedUsername.split(' ')[0])) {
                
                if (embed.fields && embed.fields.length >= 3) {
                    let cash = 0, bank = 0, total = 0;
                    
                    embed.fields.forEach(field => {
                        const value = field.value || "";
                        const match = value.match(/Rp\.?\s?([\d,\.]+)/);
                        
                        if (match) {
                            const numericValue = parseFloat(match[1].replace(/[.,]/g, ''));
                            
                            if (field.name && field.name.toLowerCase().includes('cash')) {
                                cash = numericValue;
                            } else if (field.name && field.name.toLowerCase().includes('bank')) {
                                bank = numericValue;
                            } else if (field.name && field.name.toLowerCase().includes('total')) {
                                total = numericValue;
                            }
                        }
                    });
                    
                    return { cash, bank, total: total || (cash + bank), source: 'embed' };
                }
            }
        }
    } catch (error) {
        console.error("Embed parse error:", error);
    }
    return null;
}

// Balance Parser (tetap sama)
function tryParseMessageForBalance(preview, msg) {
    const b = bots.get(preview);
    if (!b) return;

    const username = b.username || "";

    // Check embeds first
    if (msg.embeds && msg.embeds.length > 0) {
        for (const embed of msg.embeds) {
            const balance = parseUnbelievaBoatEmbed(embed, username);
            if (balance) {
                b.lastBalance = {
                    cash: balance.cash,
                    bank: balance.bank,
                    total: balance.total,
                    updated: Date.now()
                };
                
                pushLog(preview, "success", `💰 Balance: Rp ${formatNumber(balance.cash)}`);
                return;
            }
        }
    }

    // Check text content
    const content = msg.content || "";
    
    const balancePattern = /Cash[:\s]*Rp\.?\s?([\d,\.]+).*?Bank[:\s]*Rp\.?\s?([\d,\.]+)/i;
    const match = content.match(balancePattern);
    
    if (match) {
        const cash = parseFloat(match[1].replace(/[.,]/g, ''));
        const bank = parseFloat(match[2].replace(/[.,]/g, ''));
        
        b.lastBalance = {
            cash: cash,
            bank: bank,
            total: cash + bank,
            updated: Date.now()
        };
        
        pushLog(preview, "success", `📊 Balance updated`);
        return;
    }

    // Work earnings
    const workEarn = content.match(/earned\s+Rp\.?\s?([\d.,]+)/i);
    if (workEarn) {
        const amount = workEarn[1].replace(/[.,]/g, "");
        pushLog(preview, "success", `🎯 Work: Rp ${formatNumber(amount)}`);
        b.lastWorkTs = Date.now();
        b.lastEarnAmount = Number(amount);
        b.totalEarnings = (b.totalEarnings || 0) + Number(amount);
        b.workCount = (b.workCount || 0) + 1;
        globalStats.totalEarnings += Number(amount);
        saveStats();
    }

    // Deposit
    const deposited = content.match(/deposited\s+Rp\.?\s?([\d.,]+)/i);
    if (deposited) {
        const amount = deposited[1].replace(/[.,]/g, "");
        pushLog(preview, "success", `💸 Deposit: Rp ${formatNumber(amount)}`);
        b.lastDepTs = Date.now();
        b.totalDeposits = (b.totalDeposits || 0) + Number(amount);
        b.depositCount = (b.depositCount || 0) + 1;
        globalStats.totalEarnings += Number(amount);
        saveStats();
    }

    // Give transactions
    const giveSent = content.match(/gave\s+Rp\.?\s?([\d.,]+)\s+to/i);
    const giveReceived = content.match(/received\s+Rp\.?\s?([\d.,]+)\s+from/i);
    const giveAll = content.match(/gave\s+all\s+money\s+to/i) || 
                    content.match(/transferred\s+all\s+to/i);
    
    if (giveSent) {
        const amount = giveSent[1].replace(/[.,]/g, "");
        pushLog(preview, "info", `🎁 Sent: Rp ${formatNumber(amount)}`);
        b.totalGiveSent = (b.totalGiveSent || 0) + Number(amount);
        globalStats.totalGiveCommands++;
        saveStats();
    }
    
    if (giveAll) {
        pushLog(preview, "info", `🎁 Sent: ALL money`);
        b.totalGiveAll = (b.totalGiveAll || 0) + 1;
        globalStats.totalGiveCommands++;
        saveStats();
    }
    
    if (giveReceived) {
        const amount = giveReceived[1].replace(/[.,]/g, "");
        pushLog(preview, "success", `🎁 Received: Rp ${formatNumber(amount)}`);
        b.totalGiveReceived = (b.totalGiveReceived || 0) + Number(amount);
        globalStats.totalEarnings += Number(amount);
        saveStats();
    }
}

// AutoFarm System (tetap sama)
class AutoFarmManager {
    constructor() {
        this.isRunning = false;
        this.interval = null;
        this.cycleCount = 0;
    }
    
    start() {
        if (this.isRunning) return;
        this.isRunning = true;
        this.interval = setInterval(() => {
            this.executeFarmCycle();
        }, 31000);
        console.log("🚀 AutoFarm started (31s cycle)");
    }
    
    stop() {
        if (!this.isRunning) return;
        clearInterval(this.interval);
        this.isRunning = false;
        console.log("⏹️ AutoFarm stopped");
    }
    
    async executeFarmCycle() {
        this.cycleCount++;
        console.log(`🔄 Cycle #${this.cycleCount}`);
        
        const connectedBots = Array.from(bots.values())
            .filter(b => b.status === "connected" && b.autoFarm);
        
        if (connectedBots.length === 0) return;
        
        await this.sendCommandToAll(connectedBots, "yay.work");
        await this.delay(2000);
        await this.sendCommandToAll(connectedBots, "yay.dep all");
    }
    
    async sendCommandToAll(botList, command) {
        const promises = botList.map(async (bot) => {
            const preview = Array.from(bots.entries())
                .find(([key, value]) => value === bot)?.[0];
            if (!preview) return;
            
            try {
                const channel = await bot.client.channels.fetch(CHANNEL_ID);
                await channel.send(command);
                
                if (command === "yay.work") {
                    globalStats.totalWorkCommands++;
                } else if (command.includes("dep")) {
                    globalStats.totalDepositCommands++;
                }
                
                globalStats.totalMessagesSent++;
                saveStats();
                
                pushLog(preview, "success", `📤 ${command}`);
                
            } catch (error) {
                console.error(`❌ ${preview} failed:`, error.message);
                pushLog(preview, "error", `Failed: ${error.message}`);
            }
        });
        
        await Promise.allSettled(promises);
    }
    
    delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
    
    getStatus() {
        return {
            isRunning: this.isRunning,
            cycleCount: this.cycleCount,
            totalBots: Array.from(bots.values()).filter(b => b.status === "connected" && b.autoFarm).length
        };
    }
}

const autoFarmManager = new AutoFarmManager();

// Mass Command System (tetap sama)
class MassCommandManager {
    async executeCommand(command, selectedBots = "all", delayBetween = 1000) {
        let targetBots = [];
        
        if (selectedBots === "all") {
            targetBots = Array.from(bots.values()).filter(b => b.status === "connected");
        } else if (Array.isArray(selectedBots)) {
            targetBots = Array.from(bots.values())
                .filter(b => b.status === "connected" && selectedBots.includes(
                    Array.from(bots.entries()).find(([key, value]) => value === b)?.[0]
                ));
        }
        
        if (targetBots.length === 0) {
            return { success: 0, failed: 0, total: 0, results: [] };
        }
        
        console.log(`📢 Mass command: "${command}" to ${targetBots.length} bots`);
        
        const results = [];
        
        // Give commands need special handling
        if (command.toLowerCase().includes('yay.give')) {
            for (let i = 0; i < targetBots.length; i++) {
                const bot = targetBots[i];
                const preview = Array.from(bots.entries())
                    .find(([key, value]) => value === bot)?.[0];
                
                try {
                    const channel = await bot.client.channels.fetch(CHANNEL_ID);
                    await channel.send(command);
                    
                    pushLog(preview, "success", `🎁 Sent: ${command}`);
                    results.push({ preview, status: "success", username: bot.username });
                    
                    globalStats.totalMessagesSent++;
                    globalStats.totalGiveCommands++;
                    saveStats();
                    
                    console.log(`✅ ${preview} sent give command`);
                    
                    // Delay between give commands
                    if (i < targetBots.length - 1) {
                        await new Promise(resolve => setTimeout(resolve, delayBetween));
                    }
                    
                } catch (error) {
                    console.error(`❌ ${preview} give failed:`, error.message);
                    pushLog(preview, "error", `Give failed: ${error.message}`);
                    results.push({ preview, status: "error", error: error.message });
                }
            }
        } else {
            // Normal commands
            const promises = targetBots.map(async (bot) => {
                const preview = Array.from(bots.entries())
                    .find(([key, value]) => value === bot)?.[0];
                
                try {
                    const channel = await bot.client.channels.fetch(CHANNEL_ID);
                    await channel.send(command);
                    
                    pushLog(preview, "success", `📤 ${command}`);
                    results.push({ preview, status: "success", username: bot.username });
                    
                    globalStats.totalMessagesSent++;
                    saveStats();
                    
                    return { success: true, preview };
                } catch (error) {
                    console.error(`❌ ${preview} failed:`, error.message);
                    pushLog(preview, "error", `❌ Failed: ${error.message}`);
                    results.push({ preview, status: "error", error: error.message });
                    return { success: false, preview, error: error.message };
                }
            });
            
            await Promise.allSettled(promises);
        }
        
        const successCount = results.filter(r => r.status === "success").length;
        
        return {
            success: successCount,
            failed: targetBots.length - successCount,
            total: targetBots.length,
            results: results,
            command: command
        };
    }
    
    // Mass give with "all" amount support
    async massGive(recipientId, amount, selectedBots = "all", delay = 2000) {
        let command;
        
        if (amount.toLowerCase() === "all") {
            command = `yay.give <@${recipientId}> all`;
        } else if (!isNaN(parseInt(amount))) {
            command = `yay.give <@${recipientId}> ${parseInt(amount)}`;
        } else {
            // Check for "max" or other keywords
            command = `yay.give <@${recipientId}> ${amount}`;
        }
        
        return await this.executeCommand(command, selectedBots, delay);
    }
}

const massCommandManager = new MassCommandManager();

// Connect Bot (tetap sama)
async function connectBot(token, autoFarmInitial = true) {
    token = token.trim();
    if (token.length < 10) return { ok: false, message: "Invalid token" };
    
    const preview = previewFromToken(token);
    console.log(`🔌 Connecting: ${preview}`);
    
    if (bots.has(preview)) {
        const existingBot = bots.get(preview);
        if (existingBot.status === "connected") {
            return { ok: false, message: "Already connected" };
        }
        await disconnectBot(preview);
    }
    
    const client = new Client({ checkUpdate: false });
    
    const meta = {
        token,
        client,
        status: "connecting",
        username: null,
        userId: null,
        connectedAt: null,
        autoFarm: !!autoFarmInitial,
        lastWorkTs: null,
        lastDepTs: null,
        lastBalance: null,
        totalEarnings: 0,
        totalDeposits: 0,
        totalGiveSent: 0,
        totalGiveReceived: 0,
        totalGiveAll: 0,
        workCount: 0,
        depositCount: 0,
        logs: []
    };
    
    bots.set(preview, meta);
    globalStats.botSessions++;
    
    client.on("ready", () => {
        meta.username = client.user.username;
        meta.userId = client.user.id;
        meta.status = "connected";
        meta.connectedAt = new Date();
        
        console.log(`✅ ${meta.username} connected`);
        pushLog(preview, "success", `✅ Connected as ${meta.username}`);
        
        client.on("messageCreate", msg => {
            tryParseMessageForBalance(preview, msg);
        });
        
        // Auto request balance
        setTimeout(async () => {
            try {
                const channel = await client.channels.fetch(CHANNEL_ID);
                await channel.send("yay.bal");
                pushLog(preview, "info", "🔄 Balance check");
            } catch (error) {
                console.error(`Balance check failed for ${preview}:`, error.message);
            }
        }, 3000);
        
        if (meta.autoFarm && autoFarmManager.isRunning) {
            pushLog(preview, "success", "🌱 AutoFarm enabled");
        }
    });
    
    client.on("error", err => {
        console.error(`❌ ${preview} error:`, err.message);
        pushLog(preview, "error", `❌ ${err.message}`);
        meta.status = "error";
    });
    
    try {
        await client.login(token);
        
        const stored = loadSavedTokens();
        const existingIndex = stored.findIndex(x => previewFromToken(x.token) === preview);
        
        if (existingIndex === -1) {
            stored.push({ 
                token, 
                autoFarm: !!autoFarmInitial,
                addedAt: new Date().toISOString(),
                username: meta.username
            });
        } else {
            stored[existingIndex] = { 
                ...stored[existingIndex],
                autoFarm: !!autoFarmInitial,
                username: meta.username
            };
        }
        
        saveSavedTokens(stored);
        
        return { ok: true, preview, username: meta.username };
        
    } catch (err) {
        console.error(`❌ Login failed for ${preview}:`, err.message);
        pushLog(preview, "error", `❌ Login failed: ${err.message}`);
        bots.delete(preview);
        return { ok: false, message: "Login failed: " + err.message };
    }
}

// Disconnect Bot (tetap sama)
async function disconnectBot(preview) {
    const b = bots.get(preview);
    if (!b) return false;
    
    console.log(`🔌 Disconnecting ${preview}`);
    
    try {
        if (b.client && b.client.user) {
            await b.client.destroy();
        }
    } catch (err) {
        console.error(`Error disconnecting ${preview}:`, err.message);
    }
    
    bots.delete(preview);
    
    const stored = loadSavedTokens();
    const updated = stored.map(x => {
        if (previewFromToken(x.token) === preview) {
            return { ...x, autoFarm: false };
        }
        return x;
    });
    saveSavedTokens(updated);
    
    return true;
}

// Restore Tokens (sedikit modifikasi)
(async function restore() {
    console.log("🔄 Restoring saved tokens...");
    const stored = loadSavedTokens();
    
    if (stored.length === 0) {
        console.log("📭 No saved tokens found");
        return;
    }
    
    console.log(`📂 Found ${stored.length} saved tokens`);
    
    for (const data of stored) {
        try {
            await connectBot(data.token, data.autoFarm);
            await new Promise(resolve => setTimeout(resolve, 2000)); // Delay lebih lama
        } catch (e) {
            console.error(`Failed to restore token:`, e.message);
        }
    }
    
    console.log("✅ Token restoration completed");
    
    const autoFarmBots = Array.from(bots.values()).filter(b => b.autoFarm && b.status === "connected");
    if (autoFarmBots.length > 0) {
        console.log(`🌱 Starting AutoFarm for ${autoFarmBots.length} bots`);
        autoFarmManager.start();
    }
})();

// =======================
// ROUTES UNTUK REplit
// =======================

// Root route untuk Replit
app.get("/", (req, res) => {
    res.json({
        message: "🤖 Discord Self-Bot Controller",
        status: "online",
        running_on: "Replit",
        endpoints: {
            api: "/api/bots",
            stats: "/api/stats",
            autofarm: "/api/autofarm/status",
            health: "/api/system/health",
            ping: "/ping"
        },
        note: "Add tokens via POST /add-bot"
    });
});

// Keep-alive endpoint untuk UptimeRobot
app.get("/ping", (req, res) => {
    res.json({ 
        status: "alive", 
        time: Date.now(),
        bots: bots.size,
        uptime: process.uptime()
    });
});

// Routes lainnya tetap sama...
app.post("/add-bot", async (req, res) => {
    const { token, autoFarm = true } = req.body;
    if (!token) return res.status(400).json({ error: "Token required" });
    
    const result = await connectBot(token, autoFarm);
    if (!result.ok) return res.status(400).json({ error: result.message });
    res.json(result);
});

app.post("/remove-bot", async (req, res) => {
    const { preview } = req.body;
    const ok = await disconnectBot(preview);
    res.json({ ok });
});

app.get("/api/bots", (req, res) => {
    const botList = Array.from(bots.entries()).map(([preview, b]) => ({
        preview,
        username: b.username || "Connecting...",
        userId: b.userId,
        status: b.status,
        autoFarm: b.autoFarm,
        connectedAt: b.connectedAt,
        lastBalance: b.lastBalance,
        totalEarnings: b.totalEarnings || 0,
        totalGiveSent: b.totalGiveSent || 0,
        totalGiveAll: b.totalGiveAll || 0,
        workCount: b.workCount || 0,
        logsCount: b.logs ? b.logs.length : 0
    }));
    
    res.json({
        bots: botList,
        total: botList.length,
        connected: botList.filter(b => b.status === "connected").length,
        farming: botList.filter(b => b.status === "connected" && b.autoFarm).length,
        running_on: "Replit"
    });
});

app.get("/api/bot/:preview/logs", (req, res) => {
    const b = bots.get(req.params.preview);
    if (!b) return res.status(404).json({ error: "Bot not found" });
    res.json({ logs: (b.logs || []).slice(0, 50), username: b.username });
});

app.post("/api/bot/:preview/auto", (req, res) => {
    const { preview } = req.params;
    const { enable } = req.body;
    
    const b = bots.get(preview);
    if (!b) return res.status(404).json({ error: "Bot not found" });
    
    b.autoFarm = !!enable;
    
    const stored = loadSavedTokens();
    const updated = stored.map(x => {
        if (previewFromToken(x.token) === preview) {
            return { ...x, autoFarm: !!enable };
        }
        return x;
    });
    saveSavedTokens(updated);
    
    pushLog(preview, "success", `AutoFarm ${enable ? "ENABLED" : "DISABLED"}`);
    res.json({ ok: true, autoFarm: b.autoFarm });
});

// Mass Commands (tetap sama)
app.post("/api/mass-command", async (req, res) => {
    const { command, selectedBots = "all", delay = 1000 } = req.body;
    
    if (!command || command.trim() === "") {
        return res.status(400).json({ error: "Command required" });
    }
    
    try {
        const result = await massCommandManager.executeCommand(command.trim(), selectedBots, delay);
        res.json(result);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Mass Give Command dengan "all" support (tetap sama)
app.post("/api/mass-give", async (req, res) => {
    const { recipientId, amount, selectedBots = "all", delay = 2000 } = req.body;
    
    if (!recipientId) {
        return res.status(400).json({ error: "Recipient ID required" });
    }
    
    if (!amount || amount.trim() === "") {
        return res.status(400).json({ error: "Amount required" });
    }
    
    try {
        const result = await massCommandManager.massGive(recipientId, amount.trim(), selectedBots, delay);
        
        const responseData = {
            success: result.success || 0,
            failed: result.failed || 0,
            total: result.total || 0,
            results: result.results || [],
            command: result.command || "",
            timestamp: new Date().toISOString()
        };
        
        res.json(responseData);
        
    } catch (error) {
        console.error("Mass give error:", error);
        res.status(500).json({ 
            error: error.message,
            success: 0,
            failed: 0,
            total: 0,
            results: []
        });
    }
});

// AutoFarm Control (tetap sama)
app.get("/api/autofarm/status", (req, res) => {
    res.json(autoFarmManager.getStatus());
});

app.post("/api/autofarm/start", (req, res) => {
    autoFarmManager.start();
    res.json({ ok: true, message: "AutoFarm started" });
});

app.post("/api/autofarm/stop", (req, res) => {
    autoFarmManager.stop();
    res.json({ ok: true, message: "AutoFarm stopped" });
});

app.post("/api/autofarm/cycle-now", async (req, res) => {
    try {
        await autoFarmManager.executeFarmCycle();
        res.json({ ok: true, message: "Manual cycle executed" });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Statistics (tetap sama)
app.get("/api/stats", (req, res) => {
    const connectedBots = Array.from(bots.values()).filter(b => b.status === "connected");
    const farmingBots = connectedBots.filter(b => b.autoFarm);
    
    const totalEarnings = connectedBots.reduce((sum, b) => sum + (b.totalEarnings || 0), 0);
    const totalWorkCount = connectedBots.reduce((sum, b) => sum + (b.workCount || 0), 0);
    const totalGiveSent = connectedBots.reduce((sum, b) => sum + (b.totalGiveSent || 0), 0);
    const totalGiveAll = connectedBots.reduce((sum, b) => sum + (b.totalGiveAll || 0), 0);
    
    res.json({
        global: {
            ...globalStats,
            totalEarnings: totalEarnings,
            totalWorkCount: totalWorkCount,
            totalGiveSent: totalGiveSent,
            totalGiveAll: totalGiveAll
        },
        bots: {
            total: bots.size,
            connected: connectedBots.length,
            farming: farmingBots.length
        },
        autoFarm: autoFarmManager.getStatus(),
        platform: "Replit"
    });
});

// Bot Management (tetap sama)
app.post("/api/bots/enable-all-farm", (req, res) => {
    let enabledCount = 0;
    
    for (const [preview, bot] of bots) {
        if (bot.status === "connected") {
            bot.autoFarm = true;
            enabledCount++;
            pushLog(preview, "success", "AutoFarm enabled");
        }
    }
    
    const stored = loadSavedTokens();
    const updated = stored.map(x => {
        const preview = previewFromToken(x.token);
        if (bots.has(preview) && bots.get(preview).status === "connected") {
            return { ...x, autoFarm: true };
        }
        return x;
    });
    saveSavedTokens(updated);
    
    if (enabledCount > 0 && !autoFarmManager.isRunning) {
        autoFarmManager.start();
    }
    
    res.json({ ok: true, enabled: enabledCount });
});

app.post("/api/bots/disable-all-farm", (req, res) => {
    let disabledCount = 0;
    
    for (const [preview, bot] of bots) {
        bot.autoFarm = false;
        disabledCount++;
        pushLog(preview, "warning", "AutoFarm disabled");
    }
    
    const stored = loadSavedTokens();
    const updated = stored.map(x => ({ ...x, autoFarm: false }));
    saveSavedTokens(updated);
    
    if (autoFarmManager.isRunning) {
        autoFarmManager.stop();
    }
    
    res.json({ ok: true, disabled: disabledCount });
});

// System Health
app.get("/api/system/health", (req, res) => {
    res.json({
        status: "ok",
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
        platform: "Replit",
        bots: {
            total: bots.size,
            connected: Array.from(bots.values()).filter(b => b.status === "connected").length
        },
        memory: process.memoryUsage()
    });
});

// =======================
// START SERVER DI REplit
// =======================

// Load stats
Object.assign(globalStats, loadStats());

// Auto-save setiap 5 menit
setInterval(() => {
    saveStats();
    console.log("📊 Stats auto-saved");
}, 5 * 60 * 1000);

// Keep-alive untuk Replit (cegah sleep)
if (IS_REPLIT) {
    setInterval(() => {
        console.log('🔄 Replit keep-alive ping');
    }, 4 * 60 * 1000); // Setiap 4 menit
}

app.listen(PORT, "0.0.0.0", () => {
    console.log("========================================");
    console.log("🤖 DISCORD BOT CONTROLLER - REplit");
    console.log(`📍 Port: ${PORT}`);
    console.log(`📨 Channel ID: ${CHANNEL_ID}`);
    console.log(`📁 Data dir: ${DATA_DIR}`);
    console.log("========================================");
    console.log(`🚀 Server running at http://0.0.0.0:${PORT}`);
    console.log("========================================");
});
