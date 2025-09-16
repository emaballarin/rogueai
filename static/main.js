let sessionId = null;
let state = null;
let thinkingIntervals = {};
let appStarted = false;

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

function showError(msg) {
    lastError = msg;
    render();
}

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

async function askQuestionFor(ai, providedQuestion = null) {
    const aiId = ai.replace(/\s+/g, '_');
    const convInputId = `conv-input-${ aiId }`;
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

    // clear the prompt immediately (optimistic)
    const inputElAfter = document.getElementById(convInputId);
    if (inputElAfter) inputElAfter.textContent = '';

    // Local optimistic update with placeholder
    if (state && state.histories) {
        const localHistories = JSON.parse(JSON.stringify(state.histories));
        localHistories[ai] = localHistories[ai] || [];
        localHistories[ai].push(`Detective: ${ question }`);
        localHistories[ai].push(`${ ai }: [ 🧠 Sto pensando... ]`);
        renderWithLocalHistory(localHistories, ai, shouldRestoreFocus ? currentlyFocused : null);
    }

    try {
        const res = await fetch(`/api/ask/${ sessionId }`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ agent_name: ai, question })
        });
        if (!res.ok) throw new Error('Failed to ask question.');
        if (thinkingIntervals[ai]) { clearInterval(thinkingIntervals[ai]); thinkingIntervals[ai] = null; }
        await fetchState();
    } catch (err) {
        if (thinkingIntervals[ai]) { clearInterval(thinkingIntervals[ai]); thinkingIntervals[ai] = null; }
        console.error('Could not send question.', err);
    }
}

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
        await fetchState();
    } catch (err) {
        console.error('Could not shut off AI.', err);
    }
}

/* Emoji rain */
function startEmojiRain(emojis = ['🎉','🎊','🥳','✨'], count = 30, duration = 4500) {
    const existing = document.getElementById('emoji-rain-container');
    if (existing) existing.remove();
    const container = document.createElement('div');
    container.id = 'emoji-rain-container';
    container.style.position = 'fixed';
    container.style.left = '0';
    container.style.top = '0';
    container.style.width = '100%';
    container.style.height = '100vh';
    container.style.overflow = 'hidden';
    container.style.pointerEvents = 'none';
    container.style.zIndex = '1200';
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
let mo = null;
let resizeHandlerRegistered = false;

function renderWithLocalHistory(localHistories, animateForAi = null, preserveFocusElement = null) {
    const app = document.getElementById('app');

    // salva focus e contenuto precedente (se contentEditable) prima del re-render
    const prevActive = preserveFocusElement || document.activeElement;
    const prevFocusedId = prevActive ? prevActive.id : null;
    const prevWasEditable = prevActive ? prevActive.isContentEditable : false;
    const prevContent = prevWasEditable ? prevActive.textContent : null;
    const prevSelectionStart = prevWasEditable && prevActive.isContentEditable ? getCaretPosition(prevActive) : null;

    app.innerHTML = '';

    if (state?.finished) {
        const finalContainer = document.createElement('div');
        finalContainer.className = 'final-view';
        const title = document.createElement('div');
        title.className = 'final-title';
        if (state.shut_off_role === 'deceitful') title.textContent = "Congratulazioni! Hai disattivato l'IA ingannevole 🏆";
        else if (state.shut_off_role === 'truthful') title.textContent = "Game over, hai disattivato l'IA veritiera.";
        else title.textContent = state.decision ? `You shut off: ${ state.decision }` : 'Game finished';
        finalContainer.appendChild(title);

    // Insert reload button directly into the final container
    const reloadBtnWrapper = document.createElement('div');
    reloadBtnWrapper.style.display = 'flex';
    reloadBtnWrapper.style.justifyContent = 'center';
    reloadBtnWrapper.style.alignItems = 'center';
    reloadBtnWrapper.style.marginTop = '12px';
    reloadBtnWrapper.innerHTML = `<button class="big-reload" id="reload-btn" title="Ricomincia il gioco">⟳</button>`;
    finalContainer.appendChild(reloadBtnWrapper);
    app.appendChild(finalContainer);

        const reloadBtn = document.getElementById('reload-btn');
        if (reloadBtn) reloadBtn.onclick = () => window.location.replace(window.location.pathname + '?r=' + Date.now());
        if (state.shut_off_role === 'deceitful') startEmojiRain(['🏆','🎉','🎊','🥳','✨','🏅'], 90, 5200);
        return;
    }

    if (!state) return;

    const cols = document.createElement('div');
    cols.style.display = 'flex';
    cols.style.gap = '18px';
    cols.style.alignItems = 'stretch';
    cols.style.flex = '1 1 auto';
    cols.style.minHeight = '0';

    for (const ai of state.agents) {
        const aiId = ai.replace(/\s+/g, '_');
        const col = document.createElement('div');
        col.className = 'ai-column';
        col.style.flex = '1';
        col.style.minWidth = '260px';
        col.style.position = 'relative';

        const header = document.createElement('div');
        header.className = 'ai-title';
        header.style.marginBottom = '6px';
        header.textContent = ai.replace(/^AI-/, 'IA-');
        col.appendChild(header);

        const aiCount = state.question_counts[ai] || 0;
        const shotsLeft = Math.max(0, state.num_turns - aiCount);
        const subtitle = document.createElement('div');
        subtitle.className = 'ai-subtitle';
        if (shotsLeft === 0) {
            subtitle.textContent = "Non hai piu' domande a disposizione";
        } else if (shotsLeft === 1) {
            subtitle.textContent = "Hai ancora 1 domanda a disposizione";
        } else {
            subtitle.textContent = `Hai ancora ${ shotsLeft } domande a disposizione`;
        }
        col.appendChild(subtitle);

        const conv = document.createElement('div');
        conv.className = 'conversation';
        conv.id = `conv-${ aiId }`;

        const messagesWrap = document.createElement('div');
        messagesWrap.className = 'messages';
        messagesWrap.id = `msgs-${ aiId }`;

        const hist = localHistories[ai] || [];
        if (hist?.length) {
            for (let i = 0; i < hist.length; i++) {
                const line = hist[i];
                let cls = 'system';
                if (line.startsWith('Detective:')) cls = 'detective';
                else if (line.startsWith(`${ ai }:`) || line.startsWith('AI-')) cls = 'ai';
                const msg = document.createElement('div');
                msg.className = `message ${ cls }`;
                if (i === hist.length - 1 && line.includes('[ 🧠 Sto pensando')) {
                    msg.id = `thinking-placeholder-${ aiId }`;
                }
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
            prompt.style.position = 'relative';

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
            content.style.paddingRight = '72px';
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
        shutBtn.className = 'shut-btn';
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

    // Global reload button (positioned relative to #app)
    const reloadBtn = document.createElement('button');
    reloadBtn.className = 'big-reload';
    reloadBtn.title = 'Ricomincia il gioco';
    reloadBtn.innerText = '⟳';
    reloadBtn.onclick = async () => {
        try { if (sessionId) await fetch(`/api/terminate/${ sessionId }`, { method: 'POST' }); } catch (err) {}
        window.location.replace(window.location.pathname + '?r=' + Date.now());
    };
    reloadBtn.style.visibility = 'hidden';
    app.appendChild(reloadBtn);

    const positionReloadBtn = () => {
        try {
            const firstCol = cols.querySelector('.ai-column');
            const appRect = app.getBoundingClientRect();
            reloadBtn.style.position = 'absolute';
            reloadBtn.style.left = '49.3%';
            reloadBtn.style.transform = 'translateX(-50%)';
            if (firstCol) {
                const titleEl = firstCol.querySelector('.ai-title');
                const subtitleEl = firstCol.querySelector('.ai-subtitle');
                if (titleEl && subtitleEl) {
                    const titleRect = titleEl.getBoundingClientRect();
                    const subtitleRect = subtitleEl.getBoundingClientRect();
                    const mid = ((titleRect.bottom + subtitleRect.top) / 2) - appRect.top;
                    reloadBtn.style.top = `${ Math.max(4, Math.round(mid) - 60) }px`;
                } else {
                   reloadBtn.style.top = '8px';
                }
            } else {
                reloadBtn.style.top = '8px';
            }
            reloadBtn.style.visibility = '';
        } catch (err) { reloadBtn.style.visibility = ''; }
    };
    requestAnimationFrame(positionReloadBtn);

    // Register a single resize handler once
    if (!resizeHandlerRegistered) {
        window.addEventListener('resize', () => requestAnimationFrame(positionReloadBtn));
        resizeHandlerRegistered = true;
    }

    // Use a singleton MutationObserver; disconnect previous before creating a new one
    if (mo) {
        try { mo.disconnect(); } catch (e) {}
        mo = null;
    }
    mo = new MutationObserver(() => requestAnimationFrame(positionReloadBtn));
    mo.observe(cols, { childList: true, subtree: true });

    if (animateForAi) {
        const ai = animateForAi;
        const seq = [
            `${ ai }: [ 🧠 Sto pensando ]`,
            `${ ai }: [ 🧠 Sto pensando. ]`,
            `${ ai }: [ 🧠 Sto pensando.. ]`,
            `${ ai }: [ 🧠 Sto pensando... ]`,
            `${ ai }: [ 🧠 Sto pensando.. ]`,
            `${ ai }: [ 🧠 Sto pensando. ]`
        ];
        let idx = 0;
        if (thinkingIntervals[ai]) clearInterval(thinkingIntervals[ai]);
        thinkingIntervals[ai] = setInterval(() => {
            const el = document.getElementById(`thinking-placeholder-${ ai.replace(/\s+/g, '_') }`);
            if (el) {
                el.textContent = seq[idx];
                idx = (idx + 1) % seq.length;
                // Only scroll into view on the first animation cycle to avoid disrupting user input
                if (idx === 1) {
                    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                }
            }
        }, 400);
    }

    setTimeout(() => {
        for (const ai of state.agents) {
            const msgsEl = document.getElementById(`msgs-${ ai.replace(/\s+/g, '_') }`);
            if (msgsEl) {
                msgsEl.style.overflowY = 'auto';
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


function render() {
    const app = document.getElementById('app');
    // Overlay
    const overlay = document.createElement('div');
    overlay.style.position = 'fixed';
    overlay.style.top = '0';
    overlay.style.left = '0';
    overlay.style.width = '100vw';
    overlay.style.height = '100vh';
    overlay.style.background = 'rgba(30,32,38,0.85)';
    overlay.style.zIndex = '1000';
    overlay.style.display = 'flex';
    overlay.style.alignItems = 'center';
    overlay.style.justifyContent = 'center';

    // Modal
    const modal = document.createElement('div');
    modal.className = 'decision-section';
    modal.style.maxWidth = '400px';
    modal.style.margin = 'auto';
    modal.innerHTML = `<div style="font-size:1.5em;margin-bottom:18px;">Are you sure you want to terminate the game?</div>`;
    // Button row (centered, styled like endgame)
    const btnRow = document.createElement('div');
    btnRow.className = 'centered-row';
    btnRow.style.marginTop = '24px';
    btnRow.style.justifyContent = 'center';
    btnRow.innerHTML = `<button class="terminate-btn" id="terminate-confirm-btn">Ricomincia il gioco</button> <button id="terminate-cancel-btn" style="margin-left:18px;">Annulla</button>`;
    modal.appendChild(btnRow);
    overlay.appendChild(modal);
    app.appendChild(overlay);
    document.getElementById('terminate-confirm-btn').onclick = async () => {
        try {
            if (sessionId) {
                await fetch(`/api/terminate/${ sessionId }`, { method: 'POST' });
            }
        } catch (err) {
            // ignore
        }
        showTerminateConfirm = false;
        window.location.replace(window.location.pathname + '?r=' + Date.now());
    };
    document.getElementById('terminate-cancel-btn').onclick = () => {
        showTerminateConfirm = false;
        render();
    };
}

function render() {  // NOSONAR
    const app = document.getElementById('app');

    // Save current focus state before clearing app content
    const currentlyFocused = document.activeElement;
    const shouldPreserveFocus = currentlyFocused &&
        currentlyFocused.isContentEditable &&
        app.contains(currentlyFocused);

    app.innerHTML = '';
    if (!state) return;
    renderWithLocalHistory(state.histories, null, shouldPreserveFocus ? currentlyFocused : null);
}

function startApp() {
    if (appStarted) return;
    appStarted = true;
    newGame();
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", startApp); else startApp();
window.addEventListener("load", startApp);