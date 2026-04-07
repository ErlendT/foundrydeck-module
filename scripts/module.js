/**
 * Foundry Deck - Bitfocus Companion Integration
 * Client Side logic handling for WebSocket relay connection and executing Foundry commands.
 */

const MODULE_ID = "foundrydeck";
let relaySocket = null; // Store the WebSocket connection

// ==========================================
// CLIENT-SIDE LOGIC
// ==========================================

/**
 * Register Module Settings
 */
Hooks.once("init", () => {
    console.log(`${MODULE_ID} | Initializing Client-Side Settings`);

    game.settings.register(MODULE_ID, "apiKey", {
        name: "Companion API Key",
        hint: "A secret key used to authenticate with the Relay Server.",
        scope: "world",
        config: true,
        type: String,
        default: "",
    });

    game.settings.register(MODULE_ID, "relayUrl", {
        name: "Relay Server URL",
        hint: "The WebSocket URL for the Foundrydeck Relay Server (e.g., ws://localhost:3000).",
        scope: "world",
        config: true,
        type: String,
        default: "ws://localhost:3000",
    });
});

/**
 * Setup WebSocket Listeners when the game is ready
 */
Hooks.once("ready", () => {
    // Only the primary GM should connect to the relay to prevent duplicate triggering
    if (!game.user.isGM) return;

    // Ensure we only execute on the first active GM
    const activeGMs = game.users.filter(u => u.isGM && u.active);
    if (activeGMs[0]?.id !== game.user.id) return;

    connectToRelay();

    // Initial sync of data to server
    debouncedSyncCompanionData();
});

// Setup data change hooks to keep Companion UI updated
const syncHooks = [
    "createMacro", "updateMacro", "deleteMacro",
    "createPlaylist", "updatePlaylist", "deletePlaylist",
    "createPlaylistSound", "updatePlaylistSound", "deletePlaylistSound",
    "createRollTable", "updateRollTable", "deleteRollTable"
];
syncHooks.forEach(hook => Hooks.on(hook, debouncedSyncCompanionData));

// Hook to announce when a macro is manually executed
Hooks.on("executeMacro", (macro) => {
    if (!game.user?.isGM) return;
    if (relaySocket && relaySocket.readyState === WebSocket.OPEN) {
        relaySocket.send(JSON.stringify({
            action: "macroExecuted",
            payload: { id: macro.id, name: macro.name }
        }));
    }
});

// ------------------------------------------
// WebSocket Relay Connection
// ------------------------------------------

function connectToRelay() {
    const relayUrl = game.settings.get(MODULE_ID, "relayUrl");
    const apiKey = game.settings.get(MODULE_ID, "apiKey");

    if (!relayUrl) {
        console.warn(`${MODULE_ID} | No Relay URL configured. WebSocket disabled.`);
        return;
    }

    console.log(`${MODULE_ID} | Attempting to connect to Relay Server at ${relayUrl}`);
    
    // Ensure URL is a ws:// or wss:// protocol
    let wsUrl = relayUrl;
    if (wsUrl.startsWith("http://")) wsUrl = wsUrl.replace("http://", "ws://");
    if (wsUrl.startsWith("https://")) wsUrl = wsUrl.replace("https://", "wss://");

    try {
        relaySocket = new WebSocket(wsUrl);

        relaySocket.onopen = () => {
            console.log(`${MODULE_ID} | Connected to Relay Server.`);
            // Send authentication
            relaySocket.send(JSON.stringify({
                action: "authenticate",
                apiKey: apiKey
            }));
            
            // Sync data upon successful connection
            debouncedSyncCompanionData();
        };

        relaySocket.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);
                
                // Ignore success/error messages from auth
                if (data.success || data.error) {
                    if (data.error) console.error(`${MODULE_ID} | Relay Error: ${data.error}`);
                    return;
                }
                
                console.log(`${MODULE_ID} | WebSocket event received, action: ${data.action}`);
                handleSocketAction(data.action, data.payload);
            } catch (err) {
                console.error(`${MODULE_ID} | Error parsing standard message from Relay:`, err);
            }
        };

        relaySocket.onerror = (error) => {
            console.error(`${MODULE_ID} | WebSocket Relay Error:`, error);
        };

        relaySocket.onclose = (event) => {
            console.warn(`${MODULE_ID} | Disconnected from Relay Server (Code: ${event.code}). Retrying in 5 seconds...`);
            relaySocket = null;
            setTimeout(connectToRelay, 5000);
        };

    } catch (err) {
        console.error(`${MODULE_ID} | Failed to initialize WebSocket:`, err);
        setTimeout(connectToRelay, 5000);
    }
}

// ------------------------------------------
// Companion Data Syncing
// ------------------------------------------

let syncTimeout = null;

/**
 * Debounces the sync call to prevent spamming the server when rapid changes occur.
 */
function debouncedSyncCompanionData() {
    if (syncTimeout) clearTimeout(syncTimeout);
    syncTimeout = setTimeout(() => {
        syncCompanionData();
    }, 1000);
}

/**
 * Packages current game data and pushes it to the server cache via REST POST.
 */
async function syncCompanionData() {
    // Only the primary GM needs to sync this
    if (!game.user?.isGM) return;
    const activeGMs = game.users.filter(u => u.isGM && u.active);
    if (activeGMs[0]?.id !== game.user.id) return;

    let relayUrl = game.settings.get(MODULE_ID, "relayUrl");
    const apiKey = game.settings.get(MODULE_ID, "apiKey");
    
    if (!relayUrl) return;

    // Convert ws:// to http:// for REST sync
    if (relayUrl.startsWith("ws://")) relayUrl = relayUrl.replace("ws://", "http://");
    if (relayUrl.startsWith("wss://")) relayUrl = relayUrl.replace("wss://", "https://");
    
    // Ensure no trailing slash
    if (relayUrl.endsWith("/")) relayUrl = relayUrl.slice(0, -1);

    // Collect Macros and Tables safely using .contents
    const macros = game.macros.contents ? game.macros.contents.map(m => ({ id: m.id, name: m.name })) : game.macros.map(m => ({ id: m.id, name: m.name }));
    const tables = game.tables.contents ? game.tables.contents.map(t => ({ id: t.id, name: t.name })) : game.tables.map(t => ({ id: t.id, name: t.name }));

    // Collect Playlists and Sounds
    const playlists = [];
    const sounds = [];
    
    for (let p of game.playlists) {
        playlists.push({ id: p.id, name: p.name, playing: p.playing });
        for (let s of p.sounds) {
            sounds.push({ 
                id: s.id, 
                name: s.name, 
                path: s.path || s.src, 
                playlistId: p.id,
                playlistName: p.name,
                playing: s.playing
            });
        }
    }

    try {
        await fetch(`${relayUrl}/api/sync`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "x-api-key": apiKey
            },
            body: JSON.stringify({ macros, playlists, sounds, tables })
        });
        console.log(`${MODULE_ID} | Successfully synced data to companion relay server cache.`);
    } catch (e) {
        console.error(`${MODULE_ID} | Failed to sync data to relay server`, e);
    }
}

/**
 * Route socket actions to explicit handlers
 * @param {string} action - The type of action to perform
 * @param {Object} [payload={}] - Arguments for the action
 */
async function handleSocketAction(action, payload = {}) {
    try {
        switch (action) {
            case 'executeMacro':
                await executeMacro(payload.id, payload.args);
                break;
            case 'rollDice':
                await rollDice(payload.formula);
                break;
            case 'rollTable':
                await rollTable(payload.id);
                break;
            case 'playSound':
                await playSound(payload.playlistId, payload.soundId, payload.volume);
                break;
            case 'togglePlaylist':
                await togglePlaylist(payload.id);
                break;
            case 'adjustVolume':
                await adjustVolume(payload.channel, payload.amount);
                break;
            case 'setVolume':
                await setVolume(payload.channel, payload.level);
                break;
            case 'toggleMute':
                await toggleMute(payload.channel);
                break;
            case 'adjustZoom':
                await adjustZoom(payload.amount);
                break;
            case 'rotateToken':
                await rotateToken(payload.degree);
                break;
            case 'setTokenRotation':
                await setTokenRotation(payload.degree);
                break;
            case 'cycleToken':
                await cycleToken(payload.direction);
                break;
            default:
                console.warn(`${MODULE_ID} | Unknown action type: ${action}`);
        }
    } catch (error) {
        console.error(`${MODULE_ID} | Error executing action ${action}:`, error);
    }
}

// ------------------------------------------
// Action Handlers
// ------------------------------------------

/**
 * Executes a macro by ID
 * @param {string} id - The exact ID of the macro
 * @param {Object} args - Optional arguments to pass to the macro
 */
async function executeMacro(id, args = {}) {
    const macro = game.macros.get(id);
    if (!macro) {
        console.warn(`${MODULE_ID} | Macro not found: ${id}`);
        return;
    }
    
    console.log(`${MODULE_ID} | Executing macro: ${macro.name}`);
    return macro.execute(args);
}

/**
 * Plays an audio file within a playlist
 * @param {string} playlistId - ID of the playlist
 * @param {string} soundId - ID of the sound
 * @param {number} volume - Volume from 0.0 to 1.0
 */
async function playSound(playlistId, soundId, volume = 1.0) {
    if (!playlistId || !soundId) return;
    
    const playlist = game.playlists.get(playlistId);
    if (!playlist) return;
    
    const sound = playlist.sounds.get(soundId);
    if (!sound) return;

    // Optional: if you plan to override volume, you might need to handle AudioHelper manually.
    // However, the native playSound command works reliably:
    console.log(`${MODULE_ID} | Playing sound: ${sound.name} from playlist ${playlist.name}`);
    return playlist.playSound(sound);
}

/**
 * Toggles a playlist state (Start/Stop)
 * @param {string} id - Exact ID of the playlist
 */
async function togglePlaylist(id) {
    const playlist = game.playlists.get(id);
    if (!playlist) {
        console.warn(`${MODULE_ID} | Playlist not found: ${id}`);
        return;
    }

    if (playlist.playing) {
        console.log(`${MODULE_ID} | Stopping playlist: ${playlist.name}`);
        return playlist.stopAll();
    } else {
        console.log(`${MODULE_ID} | Playing playlist: ${playlist.name}`);
        return playlist.playAll();
    }
}

/**
 * Rolls dice using the Foundry Roll API
 * @param {string} formula - The dice formula (e.g. 2d20 + 1d8)
 */
async function rollDice(formula) {
    if (!formula) return;
    try {
        console.log(`${MODULE_ID} | Rolling dice: ${formula}`);
        const roll = new Roll(formula);
        await roll.evaluate({ async: true });
        await roll.toMessage();
    } catch (e) {
        console.error(`${MODULE_ID} | Error rolling dice formula ${formula}:`, e);
    }
}

/**
 * Draws from a RollTable
 * @param {string} id - Exact ID of the RollTable
 */
async function rollTable(id) {
    const table = game.tables.get(id);
    if (!table) {
        console.warn(`${MODULE_ID} | RollTable not found: ${id}`);
        return;
    }
    console.log(`${MODULE_ID} | Rolling table: ${table.name}`);
    return table.draw();
}

// Cache to keep track of volume levels for unmuting and rapid scrolls
const _volumeMuteCache = {};
const _volumeLocalCache = {};

/**
 * Adjusts global volume channels
 * @param {string} channel - globalVolume, globalPlaylistVolume, globalAmbientVolume, globalInterfaceVolume
 * @param {number} amount - +/- change
 */
async function adjustVolume(channel, amount) {
    if (_volumeLocalCache[channel] === undefined) {
        _volumeLocalCache[channel] = game.settings.get("core", channel) || 0.5;
    }
    
    let newVolume = Math.max(0.0, Math.min(1.0, _volumeLocalCache[channel] + amount));
    _volumeLocalCache[channel] = newVolume;
    
    await game.settings.set("core", channel, newVolume);
    console.log(`${MODULE_ID} | Adjusted ${channel} volume to ${newVolume}`);
}

/**
 * Sets specific volume level
 */
async function setVolume(channel, level) {
    let newVolume = Math.max(0.0, Math.min(1.0, level));
    _volumeLocalCache[channel] = newVolume;
    await game.settings.set("core", channel, newVolume);
    console.log(`${MODULE_ID} | Set ${channel} volume to ${newVolume}`);
}

/**
 * Toggles mute on a global volume channel
 */
async function toggleMute(channel) {
    let current = game.settings.get("core", channel) || 0;
    if (current > 0) {
        _volumeMuteCache[channel] = current;
        _volumeLocalCache[channel] = 0.0;
        await game.settings.set("core", channel, 0.0);
        console.log(`${MODULE_ID} | Muted ${channel}`);
    } else {
        let restored = _volumeMuteCache[channel] || 0.5;
        _volumeLocalCache[channel] = restored;
        await game.settings.set("core", channel, restored);
        console.log(`${MODULE_ID} | Unmuted ${channel} to ${restored}`);
    }
}

/**
 * Adjusts the canvas zoom scale
 */
async function adjustZoom(amount) {
    if (!canvas || !canvas.ready) return;
    let currentScale = canvas.stage.scale.x;
    let newScale = Math.max(0.1, Math.min(3.0, currentScale + amount));
    return canvas.animatePan({ scale: newScale });
}

/**
 * Rotates the currently controlled token(s) by relative amount
 */
async function rotateToken(degree) {
    if (!canvas || !canvas.tokens || !canvas.tokens.controlled.length) return;
    const updates = canvas.tokens.controlled.map(t => ({
        _id: t.id,
        rotation: (t.document.rotation + degree) % 360
    }));
    return canvas.scene.updateEmbeddedDocuments("Token", updates);
}

/**
 * Sets the absolute rotation
 */
async function setTokenRotation(degree) {
    if (!canvas || !canvas.tokens || !canvas.tokens.controlled.length) return;
    const updates = canvas.tokens.controlled.map(t => ({
        _id: t.id,
        rotation: degree % 360
    }));
    return canvas.scene.updateEmbeddedDocuments("Token", updates);
}

/**
 * Cycles selection to the next or previous token in the scene
 * @param {number} dir - 1 for forward, -1 for backward
 */
async function cycleToken(dir = 1) {
    if (!canvas || !canvas.tokens || !canvas.tokens.placeables) return;
    const tokens = canvas.tokens.placeables;
    if (!tokens.length) return;
    
    const controlled = canvas.tokens.controlled;
    let index = -1;
    if (controlled.length > 0) {
        index = tokens.findIndex(t => t.id === controlled[0].id);
    }
    
    index += dir;
    if (index >= tokens.length) index = 0;
    if (index < 0) index = tokens.length - 1;
    
    const nextToken = tokens[index];
    if (nextToken) {
        tokens.forEach(t => t.release());
        nextToken.control({ releaseOthers: true });
        return canvas.animatePan({ x: nextToken.x, y: nextToken.y });
    }
}
