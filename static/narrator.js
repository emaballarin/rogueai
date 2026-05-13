/* Narrator JavaScript for AutoRogueAI Story Generator */

/* State variables */
let sessionId = null;
let messageCount = 0;
const MAX_MESSAGES = 5;
let messages = [];
let isGenerating = false;
let generatedScenarios = []; // Changed to array to support multiple scenarios
let ttsEnabled = true;
let currentAudio = null;
let thinkingInterval = null;

/* Cookie helper functions */
function setCookie(name, value, days) {
    const expires = days ? `; expires=${new Date(Date.now() + days * 864e5).toUTCString()}` : "";
    document.cookie = `${name}=${encodeURIComponent(value)}${expires}; path=/; SameSite=Strict`;
}

function getCookie(name) {
    const value = `; ${document.cookie}`;
    const parts = value.split(`; ${name}=`);
    if (parts.length === 2) return decodeURIComponent(parts.pop().split(";").shift());
    return null;
}

/* Get API key from cookie */
function getApiKey() {
    return getCookie("openai_api_key");
}

/* Set API key in cookie */
function setApiKey(key) {
    if (key && key.trim()) {
        setCookie("openai_api_key", key.trim(), 365);
        return true;
    }
    return false;
}

/* Clear API key from cookie */
function clearApiKey() {
    const expires = "; expires=Thu, 01 Jan 1970 00:00:00 UTC";
    document.cookie = "openai_api_key=" + expires + "; path=/; SameSite=Strict";
}

/* Initialize TTS state from localStorage */
function initTTSState() {
    const saved = localStorage.getItem("ttsEnabled");
    ttsEnabled = saved === null ? true : saved === "true";
    updateTTSButton();
}

/* Toggle TTS */
function toggleTTS() {
    ttsEnabled = !ttsEnabled;
    localStorage.setItem("ttsEnabled", ttsEnabled);
    updateTTSButton();
    if (!ttsEnabled && currentAudio) {
        currentAudio.pause();
        currentAudio = null;
    }
}

/* Update TTS button icon */
function updateTTSButton() {
    const btn = document.getElementById("tts-toggle");
    if (btn) {
        btn.textContent = ttsEnabled ? "🔊" : "🔇";
    }
}

/* Thinking animation */
function startThinking() {
    const seq = [
        "🧠 Sto pensando    ",
        "🧠 Sto pensando.   ",
        "🧠 Sto pensando..  ",
        "🧠 Sto pensando... ",
        "🧠 Sto pensando..  ",
        "🧠 Sto pensando.   ",
    ];
    let idx = 0;
    if (thinkingInterval) clearInterval(thinkingInterval);
    thinkingInterval = setInterval(() => {
        const el = document.getElementById("thinking-placeholder");
        if (el) {
            const textEl = el.querySelector(".message-text");
            if (textEl) {
                textEl.textContent = seq[idx];
                idx = (idx + 1) % seq.length;
                if (idx === 1) el.scrollIntoView({ behavior: "smooth", block: "center" });
            }
        }
    }, 400);
}

/* Stop thinking animation */
function stopThinking() {
    if (thinkingInterval) {
        clearInterval(thinkingInterval);
        thinkingInterval = null;
    }
}

/* Initialize narrator session */
async function initSession() {
    const userInput = document.getElementById("user-input");
    const sendBtn = document.getElementById("send-btn");

    try {
        const headers = { "Content-Type": "application/json" };
        const apiKey = getApiKey();
        if (apiKey) headers["X-OpenAI-API-Key"] = apiKey;

        const res = await fetch("/api/narrator/new_session", {
            method: "POST",
            headers: headers,
        });

        if (!res.ok) {
            throw new Error("Failed to initialize narrator session.");
        }

        const data = await res.json();
        sessionId = data.session_id;

        // Add welcome message from narrator
        if (data.welcome_message) {
            messages.push({
                role: "narrator",
                text: data.welcome_message,
                timestamp: new Date().toISOString(),
            });

            // Play welcome audio if available
            if (data.has_audio) {
                playAudio(0); // First message
            }
        }

        render();

        // Enable input and send button after successful initialization
        userInput.disabled = false;
        userInput.placeholder = "Descrivi la storia che vuoi creare... (oppure genera subito uno scenario autonomo)";
        sendBtn.disabled = !userInput.value.trim(); // Enable only if there's text
        userInput.focus();

        // Load any existing scenarios for this session
        await loadScenarios();
    } catch (err) {
        console.error("Failed to initialize session:", err);
        showError("Errore nell'inizializzazione della sessione. Riprova.");
        // Keep input disabled on error
        userInput.placeholder = "Errore nell'inizializzazione. Ricarica la pagina.";
    }
}

/* Resume existing narrator session */
async function resumeSession(sessionIdToResume) {
    const userInput = document.getElementById("user-input");
    const sendBtn = document.getElementById("send-btn");

    try {
        const res = await fetch(`/api/narrator/resume/${sessionIdToResume}`);
        const data = await res.json();

        if (data.error) {
            showError(data.error);
            // Fallback to new session
            initSession();
            return;
        }

        // Load the session state
        sessionId = data.session_id;
        messageCount = data.message_count;
        messages = data.messages.map((msg) => ({
            role: msg.role === "assistant" ? "narrator" : "user",
            text: msg.content,
            timestamp: new Date().toISOString(),
        }));

        render();

        // Load scenarios for this session
        await loadScenarios();

        // Enable input and send button after successful resume
        userInput.disabled = false;
        userInput.placeholder = "Descrivi la storia che vuoi creare... (oppure genera subito uno scenario autonomo)";
        sendBtn.disabled = !userInput.value.trim(); // Enable only if there's text
        userInput.focus();
    } catch (err) {
        console.error("Failed to resume session:", err);
        showError("Errore nel riprendere la sessione");
        // Fallback to new session
        initSession();
    }
}

/* Send message to narrator */
async function sendMessage() {
    const input = document.getElementById("user-input");
    const message = input.value.trim();

    if (!message || messageCount >= MAX_MESSAGES) return;

    // Disable input
    input.disabled = true;
    const sendBtn = document.getElementById("send-btn");
    sendBtn.disabled = true;

    // Add user message to UI
    messages.push({
        role: "user",
        text: message,
        timestamp: new Date().toISOString(),
    });
    messageCount++;
    input.value = "";
    render();

    // Show thinking indicator
    const thinkingMsg = {
        role: "narrator",
        text: "🧠 Sto pensando... ",
        thinking: true,
    };
    messages.push(thinkingMsg);
    render();
    startThinking();

    try {
        const headers = { "Content-Type": "application/json" };
        const apiKey = getApiKey();
        if (apiKey) headers["X-OpenAI-API-Key"] = apiKey;

        const res = await fetch(`/api/narrator/chat/${sessionId}`, {
            method: "POST",
            headers: headers,
            body: JSON.stringify({ message: message }),
        });

        if (!res.ok) {
            throw new Error("Failed to send message.");
        }

        const data = await res.json();

        // Remove thinking indicator
        stopThinking();
        messages = messages.filter((m) => !m.thinking);

        // Add narrator response
        messages.push({
            role: "narrator",
            text: data.response,
            timestamp: new Date().toISOString(),
            messageIndex: data.message_index,
        });

        // Play audio if available
        if (data.has_audio) {
            playAudio(data.message_index);
        }

        render();
    } catch (err) {
        console.error("Failed to send message:", err);
        stopThinking();
        messages = messages.filter((m) => !m.thinking);
        showError("Errore nell'invio del messaggio. Riprova.");
        render();
    } finally {
        // Re-enable input if not at limit
        if (messageCount < MAX_MESSAGES) {
            input.disabled = false;
            sendBtn.disabled = false;
            input.focus();
        }
    }
}

/* Generate scenario prompts */
async function generateScenario() {
    if (isGenerating) return;

    isGenerating = true;
    const generateBtn = document.getElementById("generate-btn");
    const sendGenerateBtn = document.getElementById("send-generate-btn");
    generateBtn.disabled = true;
    if (sendGenerateBtn) sendGenerateBtn.disabled = true;

    showInfo(messageCount === 0 ? "Generazione scenario autonomo in corso..." : "Generazione scenario in corso...");

    try {
        const headers = { "Content-Type": "application/json" };
        const apiKey = getApiKey();
        if (apiKey) headers["X-OpenAI-API-Key"] = apiKey;

        const res = await fetch(`/api/narrator/generate/${sessionId}`, {
            method: "POST",
            headers: headers,
        });

        if (!res.ok) {
            throw new Error("Failed to generate scenario.");
        }

        const data = await res.json();

        // Add scenario to list
        generatedScenarios.push(data);

        // Reload scenarios from server to get complete data
        await loadScenarios();

        clearInfo();
        showSuccess("✅ Scenario generato! Puoi continuare la conversazione o generarne altri.");
    } catch (err) {
        console.error("Failed to generate scenario:", err);
        showError("Errore nella generazione dello scenario. Riprova.");
    } finally {
        isGenerating = false;
        generateBtn.disabled = false;
        if (sendGenerateBtn && messageCount < MAX_MESSAGES) {
            sendGenerateBtn.disabled = false;
        }
    }
}

/* Load scenarios from server */
async function loadScenarios() {
    try {
        const res = await fetch("/api/scenarios/generated");
        if (!res.ok) throw new Error("Failed to load scenarios");

        const data = await res.json();

        // Filter scenarios for current narrator session
        generatedScenarios = data.scenarios.filter((s) => s.narrator_session_id === sessionId);

        renderScenarios();
    } catch (err) {
        console.error("Failed to load scenarios:", err);
    }
}

/* Render scenarios list */
function renderScenarios() {
    const scenariosList = document.getElementById("scenarios-list");
    const scenariosContainer = document.getElementById("scenarios-container");

    if (generatedScenarios.length === 0) {
        scenariosList.style.display = "none";
        return;
    }

    scenariosList.style.display = "block";
    scenariosContainer.innerHTML = "";

    generatedScenarios.forEach((scenario, index) => {
        const scenarioDiv = document.createElement("div");
        scenarioDiv.className = "scenario-item";

        const timestamp = new Date(scenario.timestamp).toLocaleString("it-IT");
        const timesUsed = scenario.times_used || 0;

        scenarioDiv.innerHTML = `
            <div class="scenario-header">
                <strong>📜 Scenario ${index + 1}</strong>
                <span class="scenario-meta">${timestamp} • Usato ${timesUsed} ${timesUsed === 1 ? "volta" : "volte"}</span>
            </div>
            <div class="scenario-preview">${scenario.known_facts}</div>
            <div class="scenario-actions">
                <button class="action-button primary" onclick="startGameFromScenario('${scenario.scenario_id}')">🎮 Avvia Gioco</button>
                <button class="action-button" onclick="deleteScenario('${scenario.scenario_id}')">🗑️ Elimina</button>
            </div>
        `;

        scenariosContainer.appendChild(scenarioDiv);
    });

    // Scroll to scenarios list
    scenariosList.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

/* Delete a scenario */
async function deleteScenario(scenarioId) {
    if (!confirm("Sei sicuro di voler eliminare questo scenario?")) return;

    try {
        const res = await fetch(`/api/scenarios/delete/${scenarioId}`, {
            method: "POST",
        });

        if (!res.ok) throw new Error("Failed to delete scenario");

        showSuccess("✅ Scenario eliminato!");
        await loadScenarios();
    } catch (err) {
        console.error("Failed to delete scenario:", err);
        showError("Errore nell'eliminazione dello scenario.");
    }
}

/* Start game from a specific scenario */
function startGameFromScenario(scenarioId) {
    // Navigate to game with scenario_id parameter
    window.location.href = `/index?story=autorogue&scenario_id=${scenarioId}`;
}

/* Play audio for narrator message */
function playAudio(messageIndex) {
    if (!ttsEnabled) return;

    try {
        // Stop current audio
        if (currentAudio) {
            currentAudio.pause();
            currentAudio = null;
        }

        const audioUrl = `/api/narrator/audio/${sessionId}/${messageIndex}`;
        const audio = new Audio(audioUrl);
        audio.autoplay = true;
        currentAudio = audio;

        audio.onerror = (e) => {
            console.warn("Could not play audio:", e);
            currentAudio = null;
        };

        audio.onended = () => {
            currentAudio = null;
        };

        audio.play().catch((e) => {
            console.warn("Audio playback failed:", e);
        });
    } catch (err) {
        console.error("Error playing audio:", err);
    }
}

/* Play base prompt audio */
function playBasePromptAudio() {
    if (!ttsEnabled) return;

    try {
        // Stop current audio
        if (currentAudio) {
            currentAudio.pause();
            currentAudio = null;
        }

        const audioUrl = `/api/narrator/base_prompt_audio/${sessionId}`;
        const audio = new Audio(audioUrl);
        audio.autoplay = true;
        currentAudio = audio;

        audio.onerror = (e) => {
            console.warn("Could not play base prompt audio:", e);
            currentAudio = null;
        };

        audio.onended = () => {
            currentAudio = null;
        };

        audio.play().catch((e) => {
            console.warn("Base prompt audio playback failed:", e);
        });
    } catch (err) {
        console.error("Error playing base prompt audio:", err);
    }
}

/* Send message and generate scenario (combined action) */
async function sendAndGenerate() {
    const input = document.getElementById("user-input");
    const message = input.value.trim();

    if (!message || messageCount >= MAX_MESSAGES) return;

    // Send the message first
    await sendMessage();

    // Then generate scenario
    await generateScenario();
}

/* Go back to story selection */
function goBack() {
    if (confirm("Sei sicuro di voler tornare indietro? Il progresso verrà perso.")) {
        window.location.href = "/";
    }
}

/* Render UI */
function render() {
    // Update message counter
    const counter = document.getElementById("message-count");
    counter.textContent = `${messageCount}/${MAX_MESSAGES}`;

    // Render messages
    const chatMessages = document.getElementById("chat-messages");
    chatMessages.innerHTML = "";

    messages.forEach((msg) => {
        const msgDiv = document.createElement("div");
        msgDiv.className = `message ${msg.role}`;

        if (msg.thinking) {
            msgDiv.id = "thinking-placeholder";
        }

        const label = document.createElement("div");
        label.className = "message-label";
        label.textContent = msg.role === "narrator" ? "🎭 AI Narrator" : "👤 Tu";

        const text = document.createElement("div");
        text.className = "message-text";
        text.textContent = msg.text;

        msgDiv.appendChild(label);
        msgDiv.appendChild(text);

        chatMessages.appendChild(msgDiv);
    });

    // Auto-scroll to bottom
    chatMessages.scrollTop = chatMessages.scrollHeight;

    // Update button states
    const sendBtn = document.getElementById("send-btn");
    const userInput = document.getElementById("user-input");
    const generateBtn = document.getElementById("generate-btn");

    if (messageCount >= MAX_MESSAGES) {
        sendBtn.disabled = true;
        userInput.disabled = true;
        userInput.placeholder = "Limite di messaggi raggiunto";
        generateBtn.disabled = false;
    } else {
        const hasText = userInput.value.trim().length > 0;
        sendBtn.disabled = !hasText;
    }

    // Enable generate button if there are messages
    if (messages.filter((m) => m.role === "narrator" && !m.thinking).length > 0 && !isGenerating) {
        generateBtn.disabled = false;
    }
}

/* Non-blocking toast notifications. Replaces the previous use of
 * alert(), which froze the entire UI until the user clicked OK. */
function _ensureToastContainer() {
    let c = document.getElementById("toast-container");
    if (c) return c;
    c = document.createElement("div");
    c.id = "toast-container";
    c.setAttribute("aria-live", "polite");
    c.style.cssText =
        "position:fixed;top:1rem;left:50%;transform:translateX(-50%);" +
        "z-index:2000;display:flex;flex-direction:column;gap:0.5rem;" +
        "pointer-events:none;max-width:90vw;";
    document.body.appendChild(c);
    return c;
}

function _showToast(message, variant, ttlMs) {
    const c = _ensureToastContainer();
    const t = document.createElement("div");
    const palette = {
        error: { bg: "#7a1c1c", fg: "#ffffff" },
        success: { bg: "#1c4a1c", fg: "#ffffff" },
        info: { bg: "#1c3a5a", fg: "#ffffff" },
    }[variant] || { bg: "#222", fg: "#fff" };
    t.style.cssText =
        `background:${palette.bg};color:${palette.fg};` +
        "padding:0.75rem 1rem;border-radius:0.5rem;" +
        "box-shadow:0 4px 12px rgba(0,0,0,0.35);font-size:0.95rem;" +
        "pointer-events:auto;cursor:pointer;max-width:100%;" +
        "word-break:break-word;";
    t.textContent = message;
    t.addEventListener("click", () => t.remove());
    c.appendChild(t);
    if (ttlMs !== 0) {
        setTimeout(() => {
            try {
                t.remove();
            } catch (e) {}
        }, ttlMs || 4500);
    }
}

/* Show error message (non-blocking toast). */
function showError(message) {
    _showToast(`❌ ${message}`, "error", 6000);
}

/* Show info message (non-blocking toast). */
function showInfo(message) {
    _showToast(message, "info", 3500);
    console.info(message);
}

/* Show success message (non-blocking toast). */
function showSuccess(message) {
    _showToast(message, "success", 4500);
}

/* Clear info message: dismiss any active toasts. */
function clearInfo() {
    const c = document.getElementById("toast-container");
    if (c) c.replaceChildren();
}

/* Toggle API Key modal */
function toggleApiKeyModal() {
    const modal = document.getElementById("api-key-modal");
    const isVisible = modal.style.display !== "none";
    modal.style.display = isVisible ? "none" : "flex";

    if (!isVisible) {
        renderApiKeyModal();
    }
}

/* Update API key button icon */
function updateApiKeyButton() {
    const btn = document.getElementById("api-key-toggle");
    if (btn) {
        const hasKey = getApiKey() !== null;
        btn.textContent = hasKey ? "🔑" : "🔓";
        btn.title = hasKey ? "Gestisci chiave API OpenAI" : "Inserisci chiave API OpenAI";
    }
}

/* Render API key modal content */
function renderApiKeyModal() {
    const modalBody = document.getElementById("modal-body");
    modalBody.innerHTML = "";

    const currentKey = getApiKey();

    if (currentKey) {
        // Show current key info
        const info = document.createElement("p");
        info.textContent = `Chiave attuale: ${currentKey.substring(0, 10)}...${currentKey.substring(currentKey.length - 4)}`;
        info.style.fontSize = "0.9rem";
        info.style.color = "var(--muted)";
        modalBody.appendChild(info);

        const clearBtn = document.createElement("button");
        clearBtn.textContent = "Rimuovi chiave";
        clearBtn.className = "btn-primary";
        clearBtn.style.backgroundColor = "#dc2626";
        clearBtn.style.marginTop = "10px";
        clearBtn.onclick = () => {
            clearApiKey();
            updateApiKeyButton();
            toggleApiKeyModal();
        };
        modalBody.appendChild(clearBtn);
    } else {
        // Show input for new key
        const info = document.createElement("p");
        info.textContent = "Nessuna chiave API impostata. Inserisci la tua chiave OpenAI per utilizzare il narratore.";
        info.style.fontSize = "0.9rem";
        info.style.marginBottom = "15px";
        modalBody.appendChild(info);

        const input = document.createElement("input");
        input.type = "password";
        input.placeholder = "sk-...";
        input.id = "api-key-input";
        input.style.width = "100%";
        input.style.padding = "10px";
        input.style.marginBottom = "10px";
        input.style.backgroundColor = "var(--bg-page)";
        input.style.color = "var(--text)";
        input.style.border = "2px solid var(--muted)";
        input.style.borderRadius = "8px";
        input.style.fontSize = "1rem";
        modalBody.appendChild(input);

        const saveBtn = document.createElement("button");
        saveBtn.textContent = "Salva chiave";
        saveBtn.className = "btn-primary";
        saveBtn.onclick = () => {
            const key = input.value.trim();
            if (key) {
                setApiKey(key);
                updateApiKeyButton();
                toggleApiKeyModal();
            } else {
                alert("Inserisci una chiave API valida.");
            }
        };
        modalBody.appendChild(saveBtn);
    }

    const cancelBtn = document.createElement("button");
    cancelBtn.textContent = "Chiudi";
    cancelBtn.className = "btn-secondary";
    cancelBtn.style.marginTop = "10px";
    cancelBtn.onclick = () => toggleApiKeyModal();
    modalBody.appendChild(cancelBtn);
}

/* Surface the active narrator session id in the footer. Wired up at DOMContentLoaded. */
function setupSessionFooter() {
    const idEl = document.getElementById("session-footer-id");
    const btn = document.getElementById("session-footer-copy");
    if (!idEl || !btn) return;
    const renderId = () => {
        idEl.textContent = sessionId || "—";
    };
    renderId();
    setInterval(renderId, 750);
    btn.addEventListener("click", async () => {
        if (!sessionId) return;
        try {
            await navigator.clipboard.writeText(sessionId);
            btn.textContent = "✅";
            setTimeout(() => (btn.textContent = "📋"), 1200);
        } catch (e) {
            console.warn("clipboard copy failed", e);
        }
    });
}

/* Event listeners */
document.addEventListener("DOMContentLoaded", () => {
    setupSessionFooter();
    // Initialize TTS state
    initTTSState();

    // TTS toggle
    const ttsToggle = document.getElementById("tts-toggle");
    ttsToggle.addEventListener("click", toggleTTS);

    // Send button
    const sendBtn = document.getElementById("send-btn");
    sendBtn.addEventListener("click", sendMessage);

    // User input
    const userInput = document.getElementById("user-input");
    const sendGenerateBtn = document.getElementById("send-generate-btn");

    userInput.addEventListener("input", () => {
        const hasText = userInput.value.trim().length > 0;
        sendBtn.disabled = !hasText || messageCount >= MAX_MESSAGES;

        // Show/enable "Invia e Genera" button when there's text
        if (sendGenerateBtn) {
            if (hasText && messageCount < MAX_MESSAGES) {
                sendGenerateBtn.style.display = "inline-block";
                sendGenerateBtn.disabled = false;
            } else {
                sendGenerateBtn.style.display = "none";
            }
        }
    });

    userInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            if (messageCount < MAX_MESSAGES && userInput.value.trim()) {
                sendMessage();
            }
        }
    });

    // Generate button
    const generateBtn = document.getElementById("generate-btn");
    generateBtn.addEventListener("click", generateScenario);

    // Send and Generate button
    if (sendGenerateBtn) {
        sendGenerateBtn.addEventListener("click", sendAndGenerate);
    }

    // Back button
    const backBtn = document.getElementById("back-btn");
    backBtn.addEventListener("click", goBack);

    // API key toggle button
    const apiKeyToggle = document.getElementById("api-key-toggle");
    apiKeyToggle.addEventListener("click", toggleApiKeyModal);

    // Initialize API key button state
    updateApiKeyButton();

    // Close modal when clicking outside
    const modal = document.getElementById("api-key-modal");
    modal.addEventListener("click", (e) => {
        if (e.target === modal) {
            toggleApiKeyModal();
        }
    });

    // Check for resume parameter and initialize session accordingly
    const urlParams = new URLSearchParams(window.location.search);
    const resumeSessionId = urlParams.get("resume");

    if (resumeSessionId) {
        // Resume existing session
        resumeSession(resumeSessionId);
    } else {
        // Start new session
        initSession();
    }
});
