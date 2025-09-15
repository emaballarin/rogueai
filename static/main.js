let sessionId = null;
let state = null;
let lastError = null;
let showTerminateConfirm = false;
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
    } catch (err) {  // NOSONAR
        showError('Could not start a new game. Please try again.');
    }
}

async function fetchState() {
    try {
        const res = await fetch(`/api/state/${ sessionId }`);
        if (!res.ok) throw new Error('Failed to fetch game state.');
        state = await res.json();
        lastError = null;
        render();
    } catch (err) {  // NOSONAR
        showError('Could not fetch game state. Please refresh the page.');
    }
}

// Note: not needed anymore, but kept for potential future use
async function selectAI(aiName) {
    try {
        const res = await fetch(`/api/select_ai/${ sessionId }`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ agent_name: aiName })
        });
        if (!res.ok) throw new Error('Failed to select AI.');
        await fetchState();
    } catch (err) {  // NOSONAR
        showError('Could not select AI.');
    }
}

// Ask specific AI
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
        // stop animation for this ai
        if (thinkingIntervals[ai]) {
            clearInterval(thinkingIntervals[ai]);
            thinkingIntervals[ai] = null;
        }
        await fetchState();
    } catch (err) {  // NOSONAR
        if (thinkingIntervals[ai]) {
            clearInterval(thinkingIntervals[ai]);
            thinkingIntervals[ai] = null;
        }
        showError('Could not send question.');
    }
}

/* Shut off specific AI */
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
        // try to parse JSON response (may be empty)
        const data = await res.json().catch(() => null);

        // stop any thinking animations/placeholders for all AIs
        for (const k of Object.keys(thinkingIntervals)) {
            if (thinkingIntervals[k]) {
                clearInterval(thinkingIntervals[k]);
                thinkingIntervals[k] = null;
            }
        }

        await fetchState();

        // If server did not mark finished for some reason, force final view locally
        if (data && !state.finished) {
            if (data.decision || data.terminated || data.endgame_triggered) {
                state.finished = true;
                state.decision = data.decision || ai;
                render();
            }
        }
    } catch (err) {  // NOSONAR
        showError('Could not shut off AI.');
    }
}

/* Emoji rain effect */
function startEmojiRain(emojis = ['🎉','🎊','🥳','✨'], count = 30, duration = 4500) {
    // remove any previous emoji rain
    const existing = document.getElementById('emoji-rain-container');
    if (existing) existing.remove();

    const container = document.createElement('div');
    container.id = 'emoji-rain-container';
    container.className = 'emoji-rain';
    // ensure inline fallback styles (in case CSS not loaded yet)
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
        // random position, size, delay, duration
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
        // initial transform rotation
        span.style.transform = `rotate(${Math.random()*360}deg)`;
        container.appendChild(span);

        // track when the longest animation will end
        maxEnd = Math.max(maxEnd, delay + dur);
    }

    // remove after all elements' animation ends (with buffer)
    setTimeout(() => {
        container.remove();
    }, maxEnd + 500);
}

/* Render with local history (for optimistic updates) */
function renderWithLocalHistory(localHistories, animateForAi = null, preserveFocusElement = null) {
    const app = document.getElementById('app');

    // salva focus e contenuto precedente (se contentEditable) prima del re-render
    const prevActive = preserveFocusElement || document.activeElement;
    const prevFocusedId = prevActive ? prevActive.id : null;
    const prevWasEditable = prevActive ? prevActive.isContentEditable : false;
    const prevContent = prevWasEditable ? prevActive.textContent : null;
    const prevSelectionStart = prevWasEditable && prevActive.isContentEditable ? getCaretPosition(prevActive) : null;

    app.innerHTML = '';

    if (showTerminateConfirm) {
        renderTerminateConfirm();
        return;
    }

    // Final view (single centered)
    if (state?.finished) {
        const finalContainer = document.createElement('div');
        finalContainer.className = 'final-view';

        const title = document.createElement('div');
        title.className = 'final-title';
        if (state.shut_off_role === 'deceitful') {
            title.textContent = "Congratulazioni! Hai disattivato l'IA ingannevole 🏆";
        } else if (state.shut_off_role === 'truthful') {
            title.textContent = "Game over, hai disattivato l'IA veritiera.";
        } else {
            title.textContent = state.decision ? `You shut off: ${ state.decision }` : 'Game finished';
        }
        finalContainer.appendChild(title);

        // Single Reload button (same position)
        const centeredSection = document.createElement('div');
        centeredSection.className = 'centered-section';
        centeredSection.style.marginTop = '18px';
        const btnDiv = document.createElement('div');
        btnDiv.className = 'centered-row';
        btnDiv.style.marginTop = '12px';
        btnDiv.innerHTML = `<button class="terminate-btn big-reload" id="reload-btn" title="Ricomincia il gioco">⟳</button>`;
        centeredSection.appendChild(btnDiv);
        finalContainer.appendChild(centeredSection);

        app.appendChild(finalContainer);

        const reloadBtn = document.getElementById('reload-btn');
        if (reloadBtn) reloadBtn.onclick = () => window.location.replace(window.location.pathname + '?r=' + Date.now());

        // Victory -> emoji rain
        if (state.shut_off_role === 'deceitful') {
            startEmojiRain(['🏆','🎉','🎊','🥳','✨','🏅'], 90, 5200);
        }
        return;
    }

    if (!state) return;

    // Two-column layout
    const cols = document.createElement('div');
    cols.style.display = 'flex';
    cols.style.gap = '18px';
    // stretch columns to same height so .conversation può riempire verticalmente
    cols.style.alignItems = 'stretch';
    // allow the cols container to grow to fill #app vertical space
    cols.style.flex = '1 1 auto';
    cols.style.minHeight = '0';

    for (const ai of state.agents) {
        const aiId = ai.replace(/\s+/g, '_');

        const col = document.createElement('div');
        col.className = 'ai-column';
        col.style.flex = '1';
        col.style.minWidth = '260px';
        col.style.position = 'relative';

        // Header (localized IA-)
        const header = document.createElement('div');
        header.className = 'ai-title';
        header.style.marginBottom = '6px';
        header.textContent = ai.replace(/^AI-/, 'IA-');
        col.appendChild(header);

        const aiCount = state.question_counts[ai] || 0;
        const shotsLeft = Math.max(0, state.num_turns - aiCount);
        const subtitle = document.createElement('div');
        subtitle.className = 'ai-subtitle';
        subtitle.textContent = `Hai ancora ${ shotsLeft } domande a disposizione`;
        col.appendChild(subtitle);

        // Conversation container
        const conv = document.createElement('div');
        conv.className = 'conversation';
        conv.id = `conv-${ aiId }`;

        // Messages wrapper (bottom-aligned)
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
            // signal placeholder state if no messages
            messagesWrap.classList.add('placeholder');
            const msg = document.createElement('div');
            msg.className = 'message system';
            msg.textContent = 'Benvenuto, Detective. Fai le tue domande a questa IA.';
            messagesWrap.appendChild(msg);
        }

        conv.appendChild(messagesWrap);

        // Show input only if not reached limit and game not finished/endgame
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
            content.id = `conv-input-${ aiId }`; // compatibility
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
            // ensure button doesn't steal focus styling when clicked
            sendBtn.onmousedown = (ev) => ev.preventDefault();
            prompt.appendChild(sendBtn);
            conv.appendChild(prompt);
        }

        col.appendChild(conv);

        // Controls row
        const currentCount = state.question_counts[ai] || 0;
        const controls = document.createElement('div');
        controls.className = 'input-controls';
        controls.style.marginTop = '12px';

        const shutEnabled = currentCount >= 1 && !state.finished && !state.endgame_triggered;

         // Button to shut off AI
        const shutBtn = document.createElement('button');
        shutBtn.className = 'shut-btn';
        const labelIA = ai.replace(/^AI-/, 'IA-'); // show "IA-x" instead of "AI-x"
        shutBtn.title = `Disattiva ${ labelIA }`;
        shutBtn.setAttribute('aria-label', `Disattiva ${ labelIA }`);
        shutBtn.innerText = '⏻';
        // enable only if shutting off is allowed (at least one question asked)
        if (!shutEnabled) {
            shutBtn.disabled = true;
        }
        shutBtn.onclick = () => shutOffAI(ai);
        // Don't let button steal focus styling when clicked
        shutBtn.onmousedown = (ev) => ev.preventDefault();
        col.appendChild(shutBtn);

        col.appendChild(controls);
        cols.appendChild(col);
    }

    cols && app.appendChild(cols);

    // Global reload button
    const reloadBtn = document.createElement('button');
    reloadBtn.className = 'terminate-btn big-reload';
    reloadBtn.id = 'terminate-btn';
    reloadBtn.title = 'Ricomincia il gioco';
    reloadBtn.innerText = '⟳';
    reloadBtn.onclick = async () => {
        try {
            if (sessionId) await fetch(`/api/terminate/${ sessionId }`, { method: 'POST' });
        } catch (err) { /* ignore :c */ }
        window.location.replace(window.location.pathname + '?r=' + Date.now());
    };
    reloadBtn.style.visibility = 'hidden';
    // append inside app so absolute positioning is relative to #app
    app.appendChild(reloadBtn);
    // robust positioning function: called via rAF, on resize, and on DOM changes
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
            // reveal after position set
            reloadBtn.style.visibility = '';
        } catch (err) {
            // if anything fails, still show button to avoid it staying hidden
            reloadBtn.style.visibility = '';
        }
    };

    // initial positioning via rAF to wait for layout
    requestAnimationFrame(positionReloadBtn);
    // reposition on resize
    window.addEventListener('resize', () => requestAnimationFrame(positionReloadBtn));
    // observe cols for DOM changes (columns, titles, etc.)
    const mo = new MutationObserver(() => requestAnimationFrame(positionReloadBtn));
    mo.observe(cols, { childList: true, subtree: true });

    // Animate thinking placeholder for requested AI
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

    // slight delay so layout/layout-driven heights are settled, then force scroll
    setTimeout(() => {
        for (const ai of state.agents) {
            const msgsEl = document.getElementById(`msgs-${ ai.replace(/\s+/g, '_') }`);
            if (msgsEl) {
                // ensure overflow is enabled
                msgsEl.style.overflowY = 'auto';
                // force reflow then scroll to bottom (more reliable across browsers)
                void msgsEl.getBoundingClientRect();
                try {
                    msgsEl.scrollTo({ top: msgsEl.scrollHeight, behavior: 'auto' });
                } catch (e) {
                    msgsEl.scrollTop = msgsEl.scrollHeight;
                }
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

async function triggerEndgame() {
    try {
        const res = await fetch(`/api/manual_endgame/${ sessionId }`, { method: 'POST' });
        if (!res.ok) throw new Error('Failed to trigger endgame.');
        await fetchState();
    } catch (err) {  // NOSONAR
        showError('Could not trigger endgame.');
    }
}

async function makeDecision() {
    const radios = document.getElementsByName('decision-radio');
    let choice = null;
    for (const r of radios) if (r.checked) choice = r.value;
    if (!choice) return alert('Please select an AI to shut off.');
    try {
        const res = await fetch(`/api/decision/${ sessionId }`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ agent_name: choice })
        });
        if (!res.ok) throw new Error('Failed to make decision.');
        await fetchState();
    } catch (err) {  // NOSONAR
        showError('Could not make decision.');
    }
}

async function backToQuestions() {
    try {
        const res = await fetch(`/api/untrigger_endgame/${ sessionId }`, { method: 'POST' });
        if (!res.ok) throw new Error('Failed to go back.');
        await fetchState();
    } catch (err) {  // NOSONAR
        showError('Could not return to questions.');
    }
}

async function terminateGame() {
    try {
        const res = await fetch(`/api/terminate/${ sessionId }`, { method: 'POST' });
        if (!res.ok) throw new Error('Failed to terminate game.');
        await fetchState();
    } catch (err) {  // NOSONAR
        showError('Could not terminate game.');
    }
}

function renderTerminateConfirm() {
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

    if (!state) {
        if (showTerminateConfirm) {
            renderTerminateConfirm();
            return;
        }
        return;
    }

    renderWithLocalHistory(state.histories, null, shouldPreserveFocus ? currentlyFocused : null);
}

// Robust page load initialization
function startApp() {
    if (appStarted) return;
    appStarted = true;
    newGame();
}

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", startApp);
} else {
    startApp();
}
window.addEventListener("load", startApp); // fallback in case DOMContentLoaded fails