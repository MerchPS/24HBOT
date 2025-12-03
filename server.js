// server.js - Updated for Render.com deployment
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
// CONFIG FOR RENDER.COM
// =======================
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const PORT = process.env.PORT || 3000;

// Use environment variable for channel ID or default
const CHANNEL_ID = process.env.CHANNEL_ID || "1443222975179391066";

// Storage paths - for Render we need persistent storage
// Render provides /tmp directory that persists between deploys
const STORAGE_PATH = IS_PRODUCTION 
    ? path.join('/tmp', 'tokens.json') 
    : path.join(__dirname, "tokens.json");
    
const STATS_PATH = IS_PRODUCTION
    ? path.join('/tmp', 'stats.json')
    : path.join(__dirname, "stats.json");

// Ensure /tmp directory exists
if (IS_PRODUCTION) {
    if (!fs.existsSync('/tmp')) {
        fs.mkdirSync('/tmp', { recursive: true });
    }
}

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
    if (!fs.existsSync(STORAGE_PATH)) return [];
    try {
        const content = fs.readFileSync(STORAGE_PATH, "utf8");
        return JSON.parse(content) || [];
    } catch (e) {
        console.error("Error loading tokens:", e.message);
        return [];
    }
}

function saveSavedTokens(list) {
    try {
        fs.writeFileSync(STORAGE_PATH, JSON.stringify(list, null, 2));
        console.log(`✅ Tokens saved: ${list.length} entries`);
    } catch (e) {
        console.error("Error saving tokens:", e.message);
    }
}

function loadStats() {
    if (!fs.existsSync(STATS_PATH)) return globalStats;
    try {
        const content = fs.readFileSync(STATS_PATH, "utf8");
        const saved = JSON.parse(content);
        return { ...globalStats, ...saved };
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
    
    const logEntry = { 
        ts: Date.now(), 
        level, 
        text,
        time: new Date().toLocaleTimeString('en-US', { hour12: false })
    };
    
    if (!b.logs) b.logs = [];
    b.logs.unshift(logEntry);
    
    // Limit logs to 200 entries
    if (b.logs.length > 200) b.logs.pop();
    
    // Also log to console in production
    if (IS_PRODUCTION) {
        console.log(`[${preview}] ${level}: ${text}`);
    }
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

// Balance Parser
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
        globalStats.totalEarnings += Number(amount);
        b.workCount = (b.workCount || 0) + 1;
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

// AutoFarm System
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
        
        // Log to all connected bots
        for (const [preview, bot] of bots) {
            if (bot.status === "connected") {
                pushLog(preview, "success", "🌱 AutoFarm system started");
            }
        }
    }
    
    stop() {
        if (!this.isRunning) return;
        clearInterval(this.interval);
        this.isRunning = false;
        console.log("⏹️ AutoFarm stopped");
        
        // Log to all connected bots
        for (const [preview, bot] of bots) {
            if (bot.status === "connected") {
                pushLog(preview, "warning", "⏹️ AutoFarm stopped");
            }
        }
    }
    
    async executeFarmCycle() {
        this.cycleCount++;
        console.log(`🔄 Cycle #${this.cycleCount}`);
        
        const connectedBots = Array.from(bots.values())
            .filter(b => b.status === "connected" && b.autoFarm);
        
        if (connectedBots.length === 0) {
            console.log("⚠️ No bots available for farming");
            return;
        }
        
        console.log(`🤖 Farming with ${connectedBots.length} bots`);
        
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

// Mass Command System
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

// Connect Bot
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
    
    const client = new Client({ 
        checkUpdate: false,
        // Additional options for production
        ...(IS_PRODUCTION && {
            retryLimit: 3,
            timeout: 30000
        })
    });
    
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
    saveStats();
    
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
    
    client.on("disconnect", () => {
        console.log(`🔌 ${preview} disconnected`);
        pushLog(preview, "warning", "🔌 Disconnected");
        meta.status = "disconnected";
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
                username: meta.username,
                lastConnected: new Date().toISOString()
            });
        } else {
            // Update existing entry
            stored[existingIndex] = { 
                ...stored[existingIndex],
                autoFarm: !!autoFarmInitial,
                username: meta.username,
                lastConnected: new Date().toISOString()
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

// Disconnect Bot
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
            return { ...x, autoFarm: false, lastDisconnected: new Date().toISOString() };
        }
        return x;
    });
    saveSavedTokens(updated);
    
    return true;
}

// Restore Tokens
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
            await new Promise(resolve => setTimeout(resolve, 2000)); // Delay between connections
        } catch (e) {
            console.error(`Failed to restore token:`, e.message);
        }
    }
    
    console.log("✅ Token restoration completed");
    
    // Start AutoFarm if any bot has it enabled
    const autoFarmBots = Array.from(bots.values()).filter(b => b.autoFarm && b.status === "connected");
    if (autoFarmBots.length > 0) {
        console.log(`🌱 Starting AutoFarm for ${autoFarmBots.length} bots`);
        autoFarmManager.start();
    }
})();

// =======================
// ROUTES
// =======================

// Root route - serve HTML or API info
app.get("/", (req, res) => {
    res.json({
        message: "🤖 Discord Self-Bot Controller API",
        status: "online",
        version: "2.0",
        production: IS_PRODUCTION,
        endpoints: {
            api: "/api/bots",
            stats: "/api/stats",
            health: "/api/system/health",
            autofarm: "/api/autofarm/status"
        }
    });
});

// Keep-alive endpoint for Render.com
app.get("/ping", (req, res) => {
    res.json({ 
        status: "alive", 
        timestamp: new Date().toISOString(),
        bots: bots.size,
        uptime: process.uptime()
    });
});

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
        totalDeposits: b.totalDeposits || 0,
        totalGiveSent: b.totalGiveSent || 0,
        totalGiveReceived: b.totalGiveReceived || 0,
        totalGiveAll: b.totalGiveAll || 0,
        workCount: b.workCount || 0,
        depositCount: b.depositCount || 0,
        logsCount: b.logs ? b.logs.length : 0
    }));
    
    res.json({
        bots: botList,
        total: botList.length,
        connected: botList.filter(b => b.status === "connected").length,
        farming: botList.filter(b => b.status === "connected" && b.autoFarm).length,
        production: IS_PRODUCTION
    });
});

app.get("/api/bot/:preview/logs", (req, res) => {
    const b = bots.get(req.params.preview);
    if (!b) return res.status(404).json({ error: "Bot not found" });
    res.json({ 
        logs: b.logs ? b.logs.slice(0, 50) : [], 
        username: b.username,
        preview: req.params.preview 
    });
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

// Mass Commands
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

// Mass Give Command with "all" amount support
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

// AutoFarm Control
app.get("/api/autofarm/status", (req, res) => {
    res.json({
        ...autoFarmManager.getStatus(),
        production: IS_PRODUCTION,
        uptime: process.uptime()
    });
});

app.post("/api/autofarm/start", (req, res) => {
    autoFarmManager.start();
    res.json({ 
        ok: true, 
        message: "AutoFarm started",
        status: autoFarmManager.getStatus()
    });
});

app.post("/api/autofarm/stop", (req, res) => {
    autoFarmManager.stop();
    res.json({ 
        ok: true, 
        message: "AutoFarm stopped",
        status: autoFarmManager.getStatus()
    });
});

app.post("/api/autofarm/cycle-now", async (req, res) => {
    try {
        await autoFarmManager.executeFarmCycle();
        res.json({ 
            ok: true, 
            message: "Manual cycle executed",
            cycleCount: autoFarmManager.cycleCount
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Statistics
app.get("/api/stats", (req, res) => {
    const connectedBots = Array.from(bots.values()).filter(b => b.status === "connected");
    const farmingBots = connectedBots.filter(b => b.autoFarm);
    
    const totalEarnings = connectedBots.reduce((sum, b) => sum + (b.totalEarnings || 0), 0);
    const totalWorkCount = connectedBots.reduce((sum, b) => sum + (b.workCount || 0), 0);
    const totalDepositCount = connectedBots.reduce((sum, b) => sum + (b.depositCount || 0), 0);
    const totalGiveSent = connectedBots.reduce((sum, b) => sum + (b.totalGiveSent || 0), 0);
    const totalGiveAll = connectedBots.reduce((sum, b) => sum + (b.totalGiveAll || 0), 0);
    
    res.json({
        global: {
            ...globalStats,
            totalEarnings: totalEarnings,
            totalWorkCount: totalWorkCount,
            totalDepositCount: totalDepositCount,
            totalGiveSent: totalGiveSent,
            totalGiveAll: totalGiveAll
        },
        bots: {
            total: bots.size,
            connected: connectedBots.length,
            farming: farmingBots.length
        },
        autoFarm: autoFarmManager.getStatus(),
        system: {
            production: IS_PRODUCTION,
            uptime: process.uptime(),
            memory: process.memoryUsage(),
            timestamp: new Date().toISOString()
        }
    });
});

// Bot Management
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

// System
app.get("/api/system/health", (req, res) => {
    res.json({
        status: "ok",
        production: IS_PRODUCTION,
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
        memory: process.memoryUsage(),
        bots: {
            total: bots.size,
            connected: Array.from(bots.values()).filter(b => b.status === "connected").length,
            farming: Array.from(bots.values()).filter(b => b.status === "connected" && b.autoFarm).length
        },
        autofarm: autoFarmManager.getStatus(),
        storage: {
            tokensFile: fs.existsSync(STORAGE_PATH),
            statsFile: fs.existsSync(STATS_PATH)
        }
    });
});

// =======================
// START SERVER
// =======================

// Load stats at startup
Object.assign(globalStats, loadStats());

// Auto-save stats every 5 minutes
setInterval(() => {
    saveStats();
    console.log("📊 Stats auto-saved");
}, 5 * 60 * 1000);

// Keep-alive for Render.com (prevent sleep)
if (IS_PRODUCTION) {
    setInterval(() => {
        console.log('🔄 Render.com keep-alive ping');
    }, 10 * 60 * 1000); // Every 10 minutes
}

const server = app.listen(PORT, () => {
    console.log("========================================");
    console.log("🤖 SELF-BOT CONTROLLER - RENDER.COM");
    console.log(`📍 Port: ${PORT}`);
    console.log(`📨 Channel: ${CHANNEL_ID}`);
    console.log(`🌍 Production: ${IS_PRODUCTION}`);
    console.log("✨ Features: AutoFarm + Mass Give (with 'all')");
    console.log("========================================");
    console.log(`🚀 Server started at http://0.0.0.0:${PORT}`);
    console.log("========================================");
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('🛑 SIGTERM received, shutting down gracefully...');
    
    // Stop AutoFarm
    autoFarmManager.stop();
    
    // Disconnect all bots
    for (const [preview] of bots) {
        disconnectBot(preview);
    }
    
    // Save stats
    saveStats();
    
    server.close(() => {
        console.log('✅ Server closed');
        process.exit(0);
    });
});

process.on('uncaughtException', (error) => {
    console.error('🔥 Uncaught Exception:', error);
    // Don't exit, keep running
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('🔥 Unhandled Rejection at:', promise, 'reason:', reason);
});
