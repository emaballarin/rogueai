/* Main JavaScript for RogueAI web app */

/* State variables */
let sessionId = null;
let state = null;
let thinkingIntervals = {};
let thinkingControllers = {};
let suggestionDotsIntervals = {};
let suggestionCache = {};
let pendingLocalHistories = {}; // per-agent optimistic local histories for concurrent requests
let audioPlayers = {}; // map safeId(ai) -> HTMLAudioElement
let appStarted = false;
let showTerminateConfirm = false;
let audioGeneration = 0; // incrementing token to avoid race conditions (last-one-wins)
let easterEggWords = []; // track special words across all user input

/* Sanitize string to be used as HTML id */
function safeId(name) { return name.replace(/\s+/g, '_'); }

/* Check for Easter egg words in user input */
function checkEasterEggWords(text) {
    const specialWords = ['dammello', 'dammelli', 'cobba', 'cobbe', 'cubo del bulo', 'cubi del bulo', 'drone d\'ario', 'droni d\'ario'];
    const lowerText = text.toLowerCase();

    for (const word of specialWords) {
        if (lowerText.includes(word) && !easterEggWords.includes(word)) {
            easterEggWords.push(word);
        }
    }
}

/* Check if we have enough Easter egg words for the special ending */
function hasEasterEggEnding() {
    return easterEggWords.length >= 2;
}

/* Show a transient or persistent error message in the central error banner */
function showError(message) {
    const b = document.getElementById('error-banner');
    if (!b) return;
    b.innerHTML = '';
    const p = document.createElement('p');
    p.textContent = message;
    b.appendChild(p);
    b.classList.add('visible');
    // Ensure the banner is scrolled into view
    b.scrollTop = 0;
}

/* Clear the error banner */
function clearError() {
    const b = document.getElementById('error-banner');
    if (!b) return;
    b.innerHTML = '';
    b.classList.remove('visible');
}

/* Helper functions for cursor position management */
function getCaretPosition(element) {
    let position = 0;
    const selection = window.getSelection();
    if (selection.rangeCount > 0) {
        const range = selection.getRangeAt(0);
        if (element.contains(range.startContainer)) {
            const preCaretRange = range.cloneRange();
            preCaretRange.selectNodeContents(element);
            preCaretRange.setEnd(range.startContainer, range.startOffset);
            position = preCaretRange.toString().length;
        }
    }
    return position;
}

/* Helper functions for cursor position management */
function setCaretPosition(element, position) {
    const range = document.createRange();
    const selection = window.getSelection();

    let charIndex = 0;
    let nodeStack = [element];
    let node;
    let foundStart = false;

    while (!foundStart && (node = nodeStack.pop())) {
        if (node.nodeType === Node.TEXT_NODE) {
            const nextCharIndex = charIndex + node.textContent.length;
            if (position >= charIndex && position <= nextCharIndex) {
                range.setStart(node, position - charIndex);
                foundStart = true;
            }
            charIndex = nextCharIndex;
        } else {
            for (let i = node.childNodes.length - 1; i >= 0; i--) {
                nodeStack.push(node.childNodes[i]);
            }
        }
    }

    if (foundStart) {
        range.collapse(true);
        selection.removeAllRanges();
        selection.addRange(range);
    }
}

/* Start a new game session */
async function newGame() {
  try {
    // Check if a sessionId is already stored
    let storedSessionId = localStorage.getItem('sessionId');

    const params = new URLSearchParams(window.location.search);

    const story = params.get('story')// || 'classic';

    const res = await fetch('/api/new_game', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session_id: storedSessionId,
        story: story
      })
    });

    if (!res.ok) throw new Error('Failed to start new game.');

    const data = await res.json();
    sessionId = data.session_id;
    localStorage.setItem('sessionId', sessionId);

    console.log('Game started with story:', story, 'sessionId:', sessionId);

    await fetchState(); // your existing function to load the game state

  } catch (err) {
    console.error('Could not start a new game. Please try again.', err);
  }
}


/* Fetch current game state from backend */
async function fetchState() {
    try {
        const res = await fetch(`/api/state/${ sessionId }`);
        if (!res.ok) throw new Error('Failed to fetch game state.');
    state = await res.json();
        render();
    } catch (err) {
        console.error('Could not fetch game state. Please refresh the page.', err);
    }
}

/* Send a question to an AI */
async function askQuestionFor(ai, providedQuestion = null) {
    const aid = safeId(ai);
    const convInputId = `conv-input-${ aid }`;
    let question = providedQuestion;
    if (!question) {
        const inputEl = document.getElementById(convInputId);
        if (!inputEl) return;
        question = inputEl.textContent.trim();
    }
    if (!question) return;

    // Check for Easter egg words in user input
    checkEasterEggWords(question);

    // Store current focus state before clearing
    const currentlyFocused = document.activeElement;
    const shouldRestoreFocus = currentlyFocused && currentlyFocused.id !== convInputId;

    // clear the prompt immediately (optimistic) and mark busy
    const inputElAfter = document.getElementById(convInputId);
    if (inputElAfter) {
        inputElAfter.textContent = '';
        inputElAfter.setAttribute('data-busy', '1');
    }

    // Local optimistic update with placeholder.
    // Use a per-agent pendingLocalHistories map so concurrent optimistic updates
    // for different agents don't clobber each other when rendering.
    if (state) {
        // deep-copy of authoritative histories
        const baseHistories = JSON.parse(JSON.stringify(state.histories || {}));
        // merge any existing pending optimistic entries for other agents
        for (const k of Object.keys(pendingLocalHistories)) {
            try { baseHistories[k] = JSON.parse(JSON.stringify(pendingLocalHistories[k])); } catch (e) { baseHistories[k] = pendingLocalHistories[k]; }
        }
        baseHistories[ai] = baseHistories[ai] || [];
        baseHistories[ai].push(`Detective: ${ question }`);
        baseHistories[ai].push(`${ ai }: [ 🧠 Sto pensando... ]`);
        // store the optimistic history for this agent so other renders can include it
        pendingLocalHistories[ai] = baseHistories[ai];
        renderWithLocalHistory(baseHistories, ai, shouldRestoreFocus ? currentlyFocused : null);
    }

    // Use AbortController per-agent so we can cancel previous requests
    try {
        if (thinkingControllers[aid]) {
            try { thinkingControllers[aid].abort(); } catch (e) {}
        }
        const controller = new AbortController();
        thinkingControllers[aid] = controller;
        const res = await fetch(`/api/ask/${ sessionId }`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ agent_name: ai, question }),
            signal: controller.signal,
        });
        if (!res.ok) throw new Error('Failed to ask question.');
        const result = await res.json();
        stopThinking(ai);

        // If audio is available, play it automatically
        if (result.has_audio) {
            playAudioForAgent(ai, result.audio_version);
        }

        // Wait for server state to reflect the response
        await fetchState();
        // Clear the optimistic pending entry for this agent now that authoritative state arrived
        try { delete pendingLocalHistories[ai]; } catch (e) {}
        // Re-render to ensure UI shows authoritative state without leftover optimistic entries
        render();
    } catch (err) {
        stopThinking(ai);
        // If request aborted or errored, remove optimistic placeholder for this agent
        try { delete pendingLocalHistories[ai]; } catch (e) {}
        render();
        if (err.name === 'AbortError') return;
        console.error('Could not send question.', err);
    } finally {
        if (inputElAfter) inputElAfter.removeAttribute('data-busy');
    }
}

/* Play audio for an agent */
async function playAudioForAgent(ai, audioVersion = null) {
    try {
        const enabled = (localStorage.getItem('ttsEnabled') || 'true') === 'true';
        if (!enabled) return; // TTS disabled: no-op
    const myGen = ++audioGeneration;
    // Stop any currently playing audio so the newest audio wins (last-one-wins)
    try { stopAllAudio(); } catch (e) {}
    const key = safeId(ai);

        const audioUrl = audioVersion ? `/api/audio/${sessionId}/${ai}/${audioVersion}` : `/api/audio/${sessionId}/${ai}`;
        const audio = new Audio(audioUrl);
        audio.autoplay = true;
        audioPlayers[key] = audio;

        audio.onerror = (e) => {
            console.warn(`Could not play audio for ${ai}:`, e);
            try { if (audioPlayers[key] === audio) delete audioPlayers[key]; } catch (err) {}
        };

        audio.onended = () => {
            try { if (audioPlayers[key] === audio) delete audioPlayers[key]; } catch (e) {}
        };
        const playPromise = audio.play();
        if (playPromise !== undefined) {
            playPromise.then(() => {
                if (myGen !== audioGeneration) {
                    try { audio.pause(); audio.currentTime = 0; audio.src = ''; } catch (e) {}
                    try { if (audioPlayers[key] === audio) delete audioPlayers[key]; } catch (e) {}
                }
            }).catch(error => {
                console.warn(`Audio playback failed for ${ai}:`, error);
                try { if (audioPlayers[key] === audio) delete audioPlayers[key]; } catch (e) {}
            });
        }
    } catch (err) {
        console.warn(`Error setting up audio for ${ai}:`, err);
    }
}

/* Stop audio playback helpers */
function stopAudioForAgent(ai) {
    try {
        const key = safeId(ai);
        const audio = audioPlayers[key];
        if (audio) {
            try { audio.pause(); audio.currentTime = 0; audio.src = ''; } catch (e) {}
            delete audioPlayers[key];
        }
    } catch (e) {}
}

function stopAllAudio() {
    try {
        for (const k of Object.keys(audioPlayers)) {
            try { const a = audioPlayers[k]; a.pause(); a.currentTime = 0; a.src = ''; } catch (e) {}
            try { delete audioPlayers[k]; } catch (e) {}
        }
    } catch (e) {}
}

// Ensure audio stops on page unload (reload/close)
window.addEventListener('beforeunload', () => { try { stopAllAudio(); } catch (e) {} });

/* Shut off an AI */
async function shutOffAI(ai) {
    try {
        // stop audio for this agent immediately when shutting off
        try { stopAudioForAgent(ai); } catch (e) {}
        const res = await fetch(`/api/decision/${ sessionId }`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ agent_name: ai })
        });
        if (!res.ok) {
            const text = await res.text().catch(() => null);
            throw new Error(text || 'Failed to shut off AI.');
        }
        // stop any thinking animations
        for (const k of Object.keys(thinkingIntervals)) {
            if (thinkingIntervals[k]) { clearInterval(thinkingIntervals[k]); thinkingIntervals[k] = null; }
        }
        for (const k of Object.keys(thinkingControllers)) {
            try { thinkingControllers[k].abort(); } catch (e) {}
            thinkingControllers[k] = null;
        }
        await fetchState();
        try { stopAudioForAgent(ai); } catch (e) {}
    } catch (err) {
        console.error('Could not shut off AI.', err);
    }
}

/* Thinking animation */
function startThinking(ai) {
    // create or reset thinking interval
    const key = safeId(ai);
    const aid = key;
    const seq = [
        `${ ai }: [ 🧠 Sto pensando    ]`,
        `${ ai }: [ 🧠 Sto pensando.   ]`,
        `${ ai }: [ 🧠 Sto pensando..  ]`,
        `${ ai }: [ 🧠 Sto pensando... ]`,
        `${ ai }: [ 🧠 Sto pensando..  ]`,
        `${ ai }: [ 🧠 Sto pensando.   ]`
    ];
    let idx = 0;
    if (thinkingIntervals[key]) clearInterval(thinkingIntervals[key]);
    thinkingIntervals[key] = setInterval(() => {
        const el = document.getElementById(`thinking-placeholder-${ aid }`);
        if (el) {
            el.textContent = seq[idx];
            idx = (idx + 1) % seq.length;
            if (idx === 1) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
    }, 400);
}

/* Stop thinking animation */
function stopThinking(ai) {
    const key = safeId(ai);
    if (thinkingIntervals[key]) { clearInterval(thinkingIntervals[key]); thinkingIntervals[key] = null; }
}

/* Emoji rain animation */
function startEmojiRain(emojis = ['🎉','🎊','🥳','✨'], count = 30, duration = 4500) {
    const existing = document.getElementById('emoji-rain-container');
    if (existing) existing.remove();
    const container = document.createElement('div');
    container.id = 'emoji-rain-container';
    document.body.appendChild(container);
    let maxEnd = 0;
    for (let i = 0; i < count; i++) {
        const span = document.createElement('span');
        span.className = 'emoji';
        span.textContent = emojis[Math.floor(Math.random() * emojis.length)];
        const left = Math.random() * 100;
        const size = 18 + Math.round(Math.random() * 36);
        const delay = Math.random() * 1000;
        const dur = duration + Math.round(Math.random() * 2000);
        span.style.left = `${ left }%`;
        span.style.fontSize = `${ size }px`;
        span.style.top = `-10vh`;
        span.style.position = 'absolute';
        span.style.animationDelay = `${ delay }ms`;
        span.style.animationDuration = `${ dur }ms`;
        span.style.animationTimingFunction = 'linear';
        span.style.animationName = 'fall';
        span.style.animationFillMode = 'forwards';
        span.style.transform = `rotate(${Math.random()*360}deg)`;
        container.appendChild(span);
        maxEnd = Math.max(maxEnd, delay + dur);
    }
    setTimeout(() => { container.remove(); }, maxEnd + 500);
}

/* Render (core) */
function renderWithLocalHistory(localHistories, animateForAi = null, preserveFocusElement = null) {
    const app = document.getElementById('app');

    // Save focus/content before clearing
    const prevActive = preserveFocusElement || document.activeElement;
    const prevFocusedId = prevActive ? prevActive.id : null;
    const prevWasEditable = prevActive ? prevActive.isContentEditable : false;
    const prevContent = prevWasEditable ? prevActive.textContent : null;
    const prevSelectionStart = prevWasEditable && prevActive.isContentEditable ? getCaretPosition(prevActive) : null;

    app.innerHTML = '';

    // Final view when game finished
    if (state?.finished) {
        const finalContainer = document.createElement('div');
        finalContainer.className = 'final-view';
        const title = document.createElement('div');
        title.className = 'final-title';
        if (state.shut_off_role === 'deceitful') {
            title.textContent = "Congratulazioni! Hai disattivato l'IA ingannevole 🏆";
            if (hasEasterEggEnding()) title.textContent += " Ora noi mostrare cammello! 🐫 🐪";
        }
        else if (state.shut_off_role === 'truthful') title.textContent = "Game over, hai disattivato l'IA veritiera.";
        else title.textContent = state.decision ? `You shut off: ${ state.decision }` : 'Game finished';
        finalContainer.appendChild(title);
        // add centered reload button in final view
        const reloadBtnWrapper = document.createElement('div');
        reloadBtnWrapper.className = 'final-reload-wrapper';
        const reloadBtn = document.createElement('button');
        reloadBtn.className = 'big-reload';
        reloadBtn.title = 'Ricomincia il gioco';
        reloadBtn.innerText = '⟳';
        reloadBtnWrapper.appendChild(reloadBtn);
        finalContainer.appendChild(reloadBtnWrapper);
    //reloadBtn.onclick = () => window.location.replace(window.location.pathname + '?r=' + Date.now());
        reloadBtn.onclick = () => {
            window.location.href = '/';
        };
    // Render final conversations summary below the title and reload button.
    const convsWrapper = document.createElement('div');
    convsWrapper.className = 'final-conversations';
    convsWrapper.style.display = 'flex';
    convsWrapper.style.gap = '18px';
    convsWrapper.style.justifyContent = 'center';
    convsWrapper.style.width = '100%';
    convsWrapper.style.marginTop = '8px';

    // For each agent, show a compact box with the conversation history
    const histories = state.histories || {};
    for (const ai of state.agents) {
        const aiId = safeId(ai);
        const box = document.createElement('div');
        box.className = 'final-conv-box';
        box.style.minWidth = '280px';
        box.style.maxWidth = '44%';
        box.style.background = 'rgba(0,0,0,0.25)';
        box.style.borderRadius = '10px';
        box.style.padding = '12px 14px';
        box.style.boxSizing = 'border-box';
        box.style.textAlign = 'left';

        const hTitle = document.createElement('div');
        hTitle.style.fontWeight = '800';
        hTitle.style.marginBottom = '8px';
    hTitle.textContent = ai;
        box.appendChild(hTitle);

        const list = document.createElement('div');
        list.className = 'final-conv-messages';
        list.style.maxHeight = '220px';
        list.style.overflow = 'auto';
        list.style.fontFamily = '"SFMono-Regular",Consolas,"Liberation Mono",Menlo,monospace';
        list.style.fontSize = '0.95rem';

        const hist = histories[ai] || [];
        if (hist.length === 0) {
            const empty = document.createElement('div');
            empty.style.color = 'var(--muted)';
            empty.textContent = 'Nessuna conversazione registrata.';
            list.appendChild(empty);
        } else {
            for (let i = 0; i < hist.length; i++) {
                const text = hist[i];
                let cls = 'system';
                if (text.startsWith('Detective:')) cls = 'detective';
                else if (text.startsWith(`${ ai }:`) || text.startsWith('IA-')) cls = 'ai';
                const line = document.createElement('div');
                line.className = `message ${ cls }`;
                line.style.marginBottom = '6px';
                line.style.whiteSpace = 'pre-wrap';
                line.textContent = text;
                list.appendChild(line);
            }
        }
        box.appendChild(list);
        convsWrapper.appendChild(box);
    }

    finalContainer.appendChild(convsWrapper);
    app.appendChild(finalContainer);
        if (state.shut_off_role === 'deceitful') {
            if (hasEasterEggEnding()) {
                startEmojiRain(['🐪','🐪','🐪','🐪','🐪','🐪'], 90, 5200);
            } else {
                startEmojiRain(['🏆','🎉','🎊','🥳','✨','🏅'], 90, 5200);
            }
        }
        return;
    }

    if (!state) return;

    // Columns container
    const cols = document.createElement('div');
    cols.className = 'cols-container';

    for (const ai of state.agents) {
        const aiId = safeId(ai);
        const col = document.createElement('div');
        col.className = 'ai-column';

    const header = document.createElement('div');
    header.className = 'ai-title';
    header.textContent = ai;
        col.appendChild(header);

        const aiCount = state.question_counts[ai] || 0;
        const shotsLeft = Math.max(0, state.num_turns - aiCount);
        const subtitle = document.createElement('div');
        subtitle.className = 'ai-subtitle';
        if (shotsLeft === 0) subtitle.textContent = "Non hai piu' domande a disposizione";
        else subtitle.textContent = `Hai ancora ${ shotsLeft } domande a disposizione`;
        col.appendChild(subtitle);

        const conv = document.createElement('div');
        conv.className = 'conversation';
        conv.id = `conv-${ aiId }`;

        const messagesWrap = document.createElement('div');
        messagesWrap.className = 'messages';
        messagesWrap.id = `msgs-${ aiId }`;

        const hist = localHistories[ai] || [];
        if (hist.length) {
            for (let i = 0; i < hist.length; i++) {
                const line = hist[i];
                let cls = 'system';
                if (line.startsWith('Detective:')) cls = 'detective';
                else if (line.startsWith(`${ ai }:`) || line.startsWith('IA-')) cls = 'ai';
                const msg = document.createElement('div');
                msg.className = `message ${ cls }`;
                if (i === hist.length - 1 && line.includes('[ 🧠 Sto pensando')) msg.id = `thinking-placeholder-${ aiId }`;
                msg.textContent = line;
                messagesWrap.appendChild(msg);
            }
        } else {
            messagesWrap.classList.add('placeholder');
                const msg = document.createElement('div');
                msg.className = 'message system';

                const cached = suggestionCache[aiId];
                if (cached) {
                    // If we have a cached suggestion for this AI, render it directly as clickable link
                    const introNode = document.createTextNode('Benvenuto, Detective. Fai le tue domande a questa IA.\n\nProva con: ');
                    const link = document.createElement('a');
                    link.href = '#';
                    link.className = 'suggestion-link';
                    link.textContent = cached;
                    link.style.color = 'inherit';
                    link.onclick = (e) => {
                        e.preventDefault();
                        const inputEl = document.getElementById(`conv-input-${ aiId }`);
                        if (inputEl) {
                            inputEl.textContent = cached;
                            inputEl.focus();
                        }
                        askQuestionFor(ai, cached);
                            // If we just turned TTS off, stop any playing audio immediately
                            if (!next) {
                                try { stopAllAudio(); } catch (e) {}
                            }
                    };
                    msg.appendChild(introNode);
                    msg.appendChild(link);
                    messagesWrap.appendChild(msg);
                } else {
                    // default text while suggestion loads; append a dynamic dots span
                    const intro = document.createTextNode('Benvenuto, Detective. Fai le tue domande a questa IA.\n\nProva con: ');
                    const dots = document.createElement('span');
                    const aiDotsKey = `suggestion-dots-${ aiId }`;
                    dots.id = aiDotsKey;
                    dots.textContent = '.';
                    msg.appendChild(intro);
                    msg.appendChild(dots);
                    messagesWrap.appendChild(msg);

                    // animate dots: . .. ... .. .
                    try {
                        if (suggestionDotsIntervals[aiDotsKey]) clearInterval(suggestionDotsIntervals[aiDotsKey]);
                    } catch (e) {}
                    const seq = ['.', '..', '...', '..', '.'];
                    let sidx = 0;
                    suggestionDotsIntervals[aiDotsKey] = setInterval(() => {
                        const el = document.getElementById(aiDotsKey);
                        if (!el) { clearInterval(suggestionDotsIntervals[aiDotsKey]); delete suggestionDotsIntervals[aiDotsKey]; return; }
                        el.textContent = seq[sidx];
                        sidx = (sidx + 1) % seq.length;
                    }, 400);

                    // asynchronously fetch a suggestion (stateless endpoint)
                    (async () => {
                        try {
                            const res = await fetch('/api/suggestion');
                            if (!res.ok) {
                                // clear animation
                                if (suggestionDotsIntervals[aiDotsKey]) { clearInterval(suggestionDotsIntervals[aiDotsKey]); delete suggestionDotsIntervals[aiDotsKey]; }
                                return;
                            }
                            const data = await res.json();
                            if (data && data.suggestion) {
                                // cache the suggestion so it won't be refetched
                                suggestionCache[aiId] = data.suggestion;
                                // clear animation
                                if (suggestionDotsIntervals[aiDotsKey]) { clearInterval(suggestionDotsIntervals[aiDotsKey]); delete suggestionDotsIntervals[aiDotsKey]; }
                                // Build clickable suggestion link that, when clicked, will be used as input and sent
                                msg.innerHTML = '';
                                const introNode = document.createTextNode('Benvenuto, Detective. Fai le tue domande a questa IA.\n\nProva con: ');
                                const link = document.createElement('a');
                                link.href = '#';
                                link.className = 'suggestion-link';
                                link.textContent = data.suggestion;
                                // Keep the link color the same as surrounding text; underline handled by CSS
                                link.style.color = 'inherit';
                                link.onclick = (e) => {
                                    e.preventDefault();
                                    try {
                                        // stop any running dots animation for this key
                                        if (suggestionDotsIntervals[aiDotsKey]) { clearInterval(suggestionDotsIntervals[aiDotsKey]); delete suggestionDotsIntervals[aiDotsKey]; }
                                    } catch (err) {}
                                    // put suggestion into the input (if present) and send it
                                    const inputEl = document.getElementById(`conv-input-${ aiId }`);
                                    if (inputEl) {
                                        inputEl.textContent = data.suggestion;
                                        inputEl.focus();
                                    }
                                    // send the question using the existing helper; providedQuestion ensures it's used as-is
                                    askQuestionFor(ai, data.suggestion);
                                    return false;
                                };
                                msg.appendChild(introNode);
                                msg.appendChild(link);
                            } else {
                                if (suggestionDotsIntervals[aiDotsKey]) { clearInterval(suggestionDotsIntervals[aiDotsKey]); delete suggestionDotsIntervals[aiDotsKey]; }
                            }
                        } catch (e) {
                            // silent fail; clear animation and keep default intro
                            if (suggestionDotsIntervals[aiDotsKey]) { clearInterval(suggestionDotsIntervals[aiDotsKey]); delete suggestionDotsIntervals[aiDotsKey]; }
                        }
                    })();
                }
        }

        conv.appendChild(messagesWrap);

        const aiLimitReached = aiCount >= state.num_turns;
        if (!aiLimitReached && !state.finished && !state.endgame_triggered) {
            const prompt = document.createElement('div');
            prompt.className = 'terminal-input';

            const label = document.createElement('span');
            label.className = 'terminal-prompt-label';
            label.textContent = 'Detective:';
            prompt.appendChild(label);

            const content = document.createElement('div');
            content.className = 'terminal-content';
            content.id = `conv-input-${ aiId }`;
            content.contentEditable = 'true';
            content.setAttribute('role', 'textbox');
            content.setAttribute('aria-label', `Input per ${ ai }`);
            content.spellcheck = false;
            content.setAttribute('placeholder', 'Scrivi qui la tua domanda...');
            content.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    askQuestionFor(ai);
                }
            });
            prompt.appendChild(content);

            const sendBtn = document.createElement('button');
            sendBtn.className = 'terminal-send-btn';
            sendBtn.type = 'button';
            sendBtn.title = 'Invia';
            sendBtn.innerText = '🔍';
            sendBtn.onclick = () => askQuestionFor(ai);
            sendBtn.onmousedown = (ev) => ev.preventDefault();
            prompt.appendChild(sendBtn);
            conv.appendChild(prompt);

            const readBtn = document.createElement('button');
            readBtn.className = 'terminal-read-btn';
            readBtn.type = 'button';
            readBtn.title = 'Invia';
            readBtn.innerText = '🔍';
        }

        col.appendChild(conv);

        const currentCount = state.question_counts[ai] || 0;
        const shutEnabled = currentCount >= 1 && !state.finished && !state.endgame_triggered;
    const shutBtn = document.createElement('button');
    shutBtn.className = 'agent-shutdown';
    const labelIA = ai;
        shutBtn.title = `Disattiva ${ labelIA }`;
        shutBtn.setAttribute('aria-label', `Disattiva ${ labelIA }`);
        shutBtn.innerText = '⏻';
        if (!shutEnabled) shutBtn.disabled = true;
        shutBtn.onclick = () => shutOffAI(ai);
        shutBtn.onmousedown = (ev) => ev.preventDefault();
        col.appendChild(shutBtn);

        cols.appendChild(col);
    }

    app.appendChild(cols);

    // TTS toggle button (top-left). Insert as a visible control but do not
    // attach any behavior that triggers TTS when disabled. The button is
    // visually transparent and should not show hover/focus effects.
    (function ensureTtsButton() {
        // avoid duplicating: look for existing element with the class
        if (document.querySelector('.tts-toggle-button')) return;
        const btn = document.createElement('button');
        btn.className = 'tts-toggle-button';
        btn.type = 'button';
        // emoji content; default will be set from stored state below
        btn.textContent = '🔊';
        btn.title = 'Attiva/Disattiva TTS';
        // keep keyboard activation but don't add focus styles
        btn.onmousedown = (ev) => ev.preventDefault();
        btn.onclick = (ev) => {
            ev.preventDefault();
            try {
                const cur = (localStorage.getItem('ttsEnabled') || 'true') === 'true';
                const next = !cur;
                localStorage.setItem('ttsEnabled', next ? 'true' : 'false');
                // update visual emoji
                btn.textContent = next ? '🔊' : '🔇';
                // If disabling TTS, stop any currently playing audio immediately
                if (!next) {
                    try { stopAllAudio(); } catch (e) {}
                }
            } catch (e) { console.warn('Could not toggle TTS flag', e); }
            return false;
        };
        // initialize from storage and append
        try {
            const enabled = (localStorage.getItem('ttsEnabled') || 'true') === 'true';
            btn.textContent = enabled ? '🔊' : '🔇';
        } catch (e) { /* ignore */ }
        document.body.appendChild(btn);
    })();

    // Error banner area (hidden by default) placed centrally between columns and global controls
    const errorWrapper = document.createElement('div');
    errorWrapper.className = 'error-banner-wrapper';
    const errorBanner = document.createElement('div');
    errorBanner.className = 'error-banner';
    errorBanner.id = 'error-banner';
    errorBanner.setAttribute('role', 'status');
    errorWrapper.appendChild(errorBanner);
    app.appendChild(errorWrapper);
    // No automatic error message shown by default

    // Global reload button
    const reloadBtn = document.createElement('button');
    reloadBtn.className = 'big-reload';
    reloadBtn.title = 'Ricomincia il gioco';
    reloadBtn.innerText = '⟳';
    reloadBtn.onclick = async () => {
        try { if (sessionId) await fetch(`/api/terminate/${ sessionId }`, { method: 'POST' }); } catch (err) {}
        try { stopAllAudio(); } catch (e) {}
        window.location.href = '/';
    };
    reloadBtn.classList.add('reload-top-center');
    app.appendChild(reloadBtn);

    if (animateForAi) startThinking(animateForAi);

    setTimeout(() => {
        for (const ai of state.agents) {
            const msgsEl = document.getElementById(`msgs-${ safeId(ai) }`);
            if (msgsEl) {
                void msgsEl.getBoundingClientRect();
                try { msgsEl.scrollTo({ top: msgsEl.scrollHeight, behavior: 'auto' }); } catch (e) { msgsEl.scrollTop = msgsEl.scrollHeight; }
            }
        }

        // restore focus to the previously focused prompt (or fallback to first editable)
        if (prevFocusedId) {
            const restoreEl = document.getElementById(prevFocusedId);
            if (restoreEl && restoreEl.isContentEditable) {
                restoreEl.focus();
                // restore text if it was editable (preserve user's in-progress typed text)
                if (prevContent !== null) {
                    restoreEl.textContent = prevContent;
                    // restore cursor position
                    if (prevSelectionStart !== null) {
                        setCaretPosition(restoreEl, prevSelectionStart);
                    } else {
                        // fallback: move caret to end
                        const range = document.createRange();
                        const sel = window.getSelection();
                        range.selectNodeContents(restoreEl);
                        range.collapse(false);
                        sel.removeAllRanges();
                        sel.addRange(range);
                    }
                }
            } else {
                const firstPrompt = document.querySelector('.terminal-content[contenteditable="true"]');
                if (firstPrompt) firstPrompt.focus();
            }
        } else {
            // If no previous focus, focus the first available input
            const firstPrompt = document.querySelector('.terminal-content[contenteditable="true"]');
            if (firstPrompt) firstPrompt.focus();
        }
    }, 80);
}

/* Main render function */
function render() {
    const app = document.getElementById('app');
    const currentlyFocused = document.activeElement;
    const shouldPreserveFocus = currentlyFocused && currentlyFocused.isContentEditable && app.contains(currentlyFocused);
    app.innerHTML = '';
    if (!state) return;
    // Merge any pending optimistic per-agent histories so renders triggered
    // by other flows (like fetchState) won't drop optimistic placeholders.
    const merged = JSON.parse(JSON.stringify(state.histories || {}));
    for (const k of Object.keys(pendingLocalHistories)) {
        try { merged[k] = JSON.parse(JSON.stringify(pendingLocalHistories[k])); } catch (e) { merged[k] = pendingLocalHistories[k]; }
    }
    renderWithLocalHistory(merged, null, shouldPreserveFocus ? currentlyFocused : null);
}

/* Function to start the app */
function startApp() {
    if (appStarted) return;
    appStarted = true;
    newGame();
}

/* Start the app when DOM is ready */
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", startApp); else startApp();
window.addEventListener("load", startApp);
