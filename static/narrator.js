/* Narrator JavaScript for AutoRogueAI Story Generator */

/* State variables */
let sessionId = null;
let messageCount = 0;
const MAX_MESSAGES = 5;
let messages = [];
let isGenerating = false;
let generatedScenario = null;
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
    } catch (err) {
        console.error("Failed to initialize session:", err);
        showError("Errore nell'inizializzazione della sessione. Riprova.");
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
    if (isGenerating || messages.length === 0) return;

    isGenerating = true;
    document.getElementById("generate-btn").disabled = true;
    showInfo("Generazione scenario in corso...");

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
        generatedScenario = data;

        // Show generation result
        clearInfo();
        showGenerationResult(data);
    } catch (err) {
        console.error("Failed to generate scenario:", err);
        showError("Errore nella generazione dello scenario. Riprova.");
        isGenerating = false;
        document.getElementById("generate-btn").disabled = false;
    }
}

/* Show generation result */
function showGenerationResult(data) {
    const resultDiv = document.getElementById("generation-result");
    const generatedPromptsText = document.getElementById("generated-prompts-text");

    // Display ONLY known_facts (other sections are kept internal)
    generatedPromptsText.textContent = data.prompts.known_facts || "N/A";

    resultDiv.style.display = "block";

    // Scroll to result
    resultDiv.scrollIntoView({ behavior: "smooth" });

    // Play known_facts audio if available
    if (data.has_audio && ttsEnabled) {
        playBasePromptAudio();
    }
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

/* Start game with generated scenario */
function startGame() {
    if (!generatedScenario) return;

    // Store generated scenario in sessionStorage for the game to pick up
    sessionStorage.setItem("generatedScenario", JSON.stringify(generatedScenario));

    // Navigate to game
    window.location.href = `/index?story=autorogue&narrator_session=${sessionId}`;
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

/* Show error message */
function showError(message) {
    // Simple alert for now
    alert(`❌ ${message}`);
}

/* Show info message */
function showInfo(message) {
    // You could implement a toast notification here
    console.info(message);
}

/* Clear info message */
function clearInfo() {
    // Clear any info notifications
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

/* Event listeners */
document.addEventListener("DOMContentLoaded", () => {
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
    userInput.addEventListener("input", () => {
        const hasText = userInput.value.trim().length > 0;
        sendBtn.disabled = !hasText || messageCount >= MAX_MESSAGES;
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

    // Back button
    const backBtn = document.getElementById("back-btn");
    backBtn.addEventListener("click", goBack);

    // Read base prompt button
    const readBasePromptBtn = document.getElementById("read-base-prompt-btn");
    readBasePromptBtn.addEventListener("click", playBasePromptAudio);

    // Start game button
    const startGameBtn = document.getElementById("start-game-btn");
    startGameBtn.addEventListener("click", startGame);

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

    // Initialize session
    initSession();
});
