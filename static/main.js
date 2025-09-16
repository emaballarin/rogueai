/* Main JavaScript for RogueAI web app */

/* State variables */
let sessionId = null;
let state = null;
let thinkingIntervals = {};
let thinkingControllers = {};
let appStarted = false;
let showTerminateConfirm = false;

// Sanitize string to be used as HTML id
function safeId(name) { return name.replace(/\s+/g, '_'); }

// Helper functions for cursor position management
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

// Errors are logged to console;
// TODO: hidden UI banner for errors between the termination buttons

/* Start a new game session */
async function newGame() {
    try {
        let storedSessionId = localStorage.getItem('sessionId');
        const res = await fetch('/api/new_game', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ session_id: storedSessionId })
        });
        if (!res.ok) throw new Error('Failed to start new game.');
        const data = await res.json();
        sessionId = data.session_id;
        localStorage.setItem('sessionId', sessionId);
        await fetchState();
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

    // Store current focus state before clearing
    const currentlyFocused = document.activeElement;
    const shouldRestoreFocus = currentlyFocused && currentlyFocused.id !== convInputId;

    // clear the prompt immediately (optimistic) and mark busy
    const inputElAfter = document.getElementById(convInputId);
    if (inputElAfter) {
        inputElAfter.textContent = '';
        inputElAfter.setAttribute('data-busy', '1');
    }

    // Local optimistic update with placeholder
    if (state && state.histories) {
        const localHistories = JSON.parse(JSON.stringify(state.histories));
        localHistories[ai] = localHistories[ai] || [];
        localHistories[ai].push(`Detective: ${ question }`);
        localHistories[ai].push(`${ ai }: [ 🧠 Sto pensando... ]`);
        renderWithLocalHistory(localHistories, ai, shouldRestoreFocus ? currentlyFocused : null);
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
        stopThinking(ai);
        await fetchState();
    } catch (err) {
        stopThinking(ai);
        if (err.name === 'AbortError') return;
        console.error('Could not send question.', err);
    } finally {
        if (inputElAfter) inputElAfter.removeAttribute('data-busy');
    }
}

/* Shut off an AI */
async function shutOffAI(ai) {
    try {
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
        `${ ai }: [ 🧠 Sto pensando ]`,
        `${ ai }: [ 🧠 Sto pensando. ]`,
        `${ ai }: [ 🧠 Sto pensando.. ]`,
        `${ ai }: [ 🧠 Sto pensando... ]`,
        `${ ai }: [ 🧠 Sto pensando.. ]`,
        `${ ai }: [ 🧠 Sto pensando. ]`
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
        if (state.shut_off_role === 'deceitful') title.textContent = "Congratulazioni! Hai disattivato l'IA ingannevole 🏆";
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
    reloadBtn.onclick = () => window.location.replace(window.location.pathname + '?r=' + Date.now());

    app.appendChild(finalContainer);
        if (state.shut_off_role === 'deceitful') startEmojiRain(['🏆','🎉','🎊','🥳','✨','🏅'], 90, 5200);
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
        header.textContent = ai.replace(/^AI-/, 'IA-');
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
                else if (line.startsWith(`${ ai }:`) || line.startsWith('AI-')) cls = 'ai';
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
            msg.textContent = 'Benvenuto, Detective. Fai le tue domande a questa IA.';
            messagesWrap.appendChild(msg);
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
        }

        col.appendChild(conv);

        const currentCount = state.question_counts[ai] || 0;
        const shutEnabled = currentCount >= 1 && !state.finished && !state.endgame_triggered;
    const shutBtn = document.createElement('button');
    shutBtn.className = 'agent-shutdown';
        const labelIA = ai.replace(/^AI-/, 'IA-');
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

    // Global reload button
    const reloadBtn = document.createElement('button');
    reloadBtn.className = 'big-reload';
    reloadBtn.title = 'Ricomincia il gioco';
    reloadBtn.innerText = '⟳';
    reloadBtn.onclick = async () => {
        try { if (sessionId) await fetch(`/api/terminate/${ sessionId }`, { method: 'POST' }); } catch (err) {}
        window.location.replace(window.location.pathname + '?r=' + Date.now());
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
    renderWithLocalHistory(state.histories, null, shouldPreserveFocus ? currentlyFocused : null);
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