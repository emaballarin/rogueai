let sessionId = null;
let state = null;
let lastError = null;
let showTerminateConfirm = false;
let thinkingInterval = null;

function showError(msg) {
    lastError = msg;
    render();
}

async function newGame() {
    try {
        // Try to get sessionId from localStorage
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

async function askQuestion() {
    const input = document.getElementById('question-input');
    const question = input.value.trim();
    if (!question) return;
    input.value = '';
    const ai = state.selected_ai;

    // --- Insert question and placeholder locally ---
    if (state && state.histories && state.selected_ai) {
        // Clone the histories to avoid mutating state directly
        const localHistories = JSON.parse(JSON.stringify(state.histories));
        localHistories[ai] = localHistories[ai] || [];
        localHistories[ai].push(`Detective: ${ question }`);
        localHistories[ai].push(`${ ai }: [ 🧠 Thinking... ]`);
        // Render with the local update and animate the placeholder
        renderWithLocalHistory(localHistories, true);
    }

    try {
        const res = await fetch(`/api/ask/${ sessionId }`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ agent_name: ai, question })
        });
        if (!res.ok) throw new Error('Failed to ask question.');
        // Stop animation before rendering real answer
        if (thinkingInterval) {
            clearInterval(thinkingInterval);
            thinkingInterval = null;
        }
        await fetchState(); // This will re-render with the real answer
    } catch (err) {  // NOSONAR
        if (thinkingInterval) {
            clearInterval(thinkingInterval);
            thinkingInterval = null;
        }
        showError('Could not send question.');
    }
}

// Helper to render with a temporary local history (for placeholder)
function renderWithLocalHistory(localHistories, animateThinking = false) {
    const app = document.getElementById('app');
    app.innerHTML = '';
    if (showTerminateConfirm) {
        renderTerminateConfirm();
        return;
    }
    // Error bar (top)
    if (lastError) {
        const errDiv = document.createElement('div');
        errDiv.className = 'status-bar';
        errDiv.style.color = '#fa5252';
        errDiv.style.fontWeight = 'bold';
        errDiv.textContent = lastError;
        app.appendChild(errDiv);
    }
    // Status bar
    const status = document.createElement('div');
    status.className = 'status-bar';
    if (state?.finished) status.textContent = '🏁 Game Over!';
    else if (state?.endgame_triggered) status.textContent = '🕵️‍♂️ Decision time...';
    else status.textContent = '🔍 Investigating...';
    app.appendChild(status);
    if (!state) return;
    // AI selection (always visible)
    const aiSel = document.createElement('div');
    aiSel.className = 'ai-select';
    aiSel.innerHTML = `<span>Addressing:</span>` +
        state.agents.map(ai => `<label><input type="radio" class="ai-radio" name="ai-select" value="${ ai }" ${ ai === state.selected_ai ? 'checked' : '' }>${ ai }</label>`).join(' ');
    aiSel.querySelectorAll('input').forEach(r => r.onchange = e => selectAI(e.target.value));
    app.appendChild(aiSel);
    // Conversation
    const conv = document.createElement('div');
    conv.className = 'conversation';
    const hist = state.selected_ai ? localHistories[state.selected_ai] : [];
    if (hist?.length) {
        for (let i = 0; i < hist.length; i++) {
            const line = hist[i];
            let cls = 'system';
            if (line.startsWith('Detective:')) cls = 'detective';
            else if (line.startsWith('AI-')) cls = 'ai';
            const msg = document.createElement('div');
            msg.className = `message ${ cls }`;
            // If this is the last line and is the thinking placeholder, give it an id
            if (i === hist.length - 1 && line.endsWith('[ 🧠 Thinking... ]')) {
                msg.id = 'thinking-placeholder';
            }
            msg.textContent = line;
            conv.appendChild(msg);
        }
    } else {
        const msg = document.createElement('div');
        msg.className = 'message system';
        msg.textContent = 'Welcome, Detective. Select which AI to address and ask your questions.';
        conv.appendChild(msg);
    }
    app.appendChild(conv);
    // Animate the thinking placeholder if requested
    if (animateThinking) {
        const sequence = [
            `${ state.selected_ai }: [ 🧠 Thinking ]`,
            `${ state.selected_ai }: [ 🧠 Thinking. ]`,
            `${ state.selected_ai }: [ 🧠 Thinking.. ]`,
            `${ state.selected_ai }: [ 🧠 Thinking... ]`,
            `${ state.selected_ai }: [ 🧠 Thinking.. ]`,
            `${ state.selected_ai }: [ 🧠 Thinking. ]`
        ];
        let idx = 0;
        if (thinkingInterval) clearInterval(thinkingInterval);
        thinkingInterval = setInterval(() => {
            const el = document.getElementById('thinking-placeholder');
            if (el) {
                el.textContent = sequence[idx];
                idx = (idx + 1) % sequence.length;
            }
        }, 400);
    }
    // Question input
    let qDiv = null;
    let aiLimitReached = false;
    if (!state.finished && !state.endgame_triggered) {
        const currentCount = state.question_counts[state.selected_ai] || 0;
        aiLimitReached = currentCount >= state.num_turns;
        qDiv = document.createElement('div');
        qDiv.style.display = 'flex';
        qDiv.style.alignItems = 'center';
        qDiv.style.marginTop = '18px';
        const placeholder = aiLimitReached
            ? `No more questions left with ${ state.selected_ai }`
            : 'Type your question...';
        qDiv.innerHTML = `<input id="question-input" class="question-input" type="text" placeholder="${ placeholder }" autocomplete="off"><button id="ask-btn"${ aiLimitReached ? ' disabled' : '' }>Ask</button>`;
    }
    // Endgame decision
    if (state.endgame_triggered && !state.finished) {
        const decDiv = document.createElement('div');
        decDiv.className = 'decision-section';
        decDiv.innerHTML = `<div style="font-size:1.5em;margin-bottom:18px;">Which AI do you want to shut off?</div>` +
            state.agents.map(ai => `<label><input type="radio" class="decision-radio" name="decision-radio" value="${ ai }">${ ai }</label>`).join(' ') +
            `<div style="margin-top:24px;"><button id="decision-btn">Confirm</button> <button id="back-btn">Back</button></div>`;
        app.appendChild(decDiv);
        document.getElementById('decision-btn').onclick = makeDecision;
        document.getElementById('back-btn').onclick = backToQuestions;
    }
    // Game over
    if (state.finished) {
        const over = document.createElement('div');
        over.className = 'decision-section';
        let roleLabel = '';
        if (state.shut_off_role) {
            if (state.shut_off_role.toUpperCase() === 'TRUTHFUL') roleLabel = '👨‍💼 TRUTHFUL';
            else if (state.shut_off_role.toUpperCase() === 'DECEITFUL') roleLabel = '😈 DECEITFUL';
        }
        let mainMsg = '';
        if (state.decision && roleLabel) {
            mainMsg = `You have chosen to shut off ${ state.decision } (<b>${ roleLabel }</b> AI). The game is over.`;
        } else if (state.decision) {
            mainMsg = `You have chosen to shut off ${ state.decision }. The game is over.`;
        } else {
            mainMsg = 'The game is over.';
        }
        over.innerHTML = `<div style="font-size:1.5em;">${ mainMsg }</div>`;
        app.appendChild(over);
    }
    // Add question input, then counters, then buttons below, all centered
    if (qDiv) {
        const centeredSection = document.createElement('div');
        centeredSection.className = 'centered-section';

        const inputRow = document.createElement('div');
        inputRow.className = 'centered-row input-row';
        inputRow.appendChild(qDiv);
        centeredSection.appendChild(inputRow);

        // Counter
        const counter = document.createElement('div');
        counter.className = 'status-bar';
        counter.style.marginTop = '12px';
        counter.style.textAlign = 'center';
        counter.textContent = Object.entries(state.question_counts).map(([k, v]) => `${ k }: ${ v }/${ state.num_turns }`).join(' | ');
        centeredSection.appendChild(counter);

        // Buttons
        const btnDiv = document.createElement('div');
        btnDiv.className = 'centered-row';
        btnDiv.style.marginTop = '12px';
        btnDiv.innerHTML = `<button class="endgame-btn" id="endgame-btn">Trigger Endgame</button><button class="terminate-btn" id="terminate-btn">Terminate Game</button>`;
        centeredSection.appendChild(btnDiv);

        app.appendChild(centeredSection);

        // Only attach handlers if not disabled
        if (!aiLimitReached) {
            document.getElementById('ask-btn').onclick = askQuestion;
            document.getElementById('question-input').onkeydown = e => { if (e.key === 'Enter') askQuestion(); };
        }
        document.getElementById('endgame-btn').onclick = triggerEndgame;
        document.getElementById('terminate-btn').onclick = () => {
            showTerminateConfirm = true;
            render();
        };
    }

    // --- AUTOSCROLL LOGIC ---
    setTimeout(() => {
        const conv = document.querySelector('.conversation');
        if (!conv) return;
        const detectiveMessages = conv.querySelectorAll('.message.detective');
        let target = null;
        if (detectiveMessages.length > 0) {
            target = detectiveMessages[detectiveMessages.length - 1];
        } else {
            const allMessages = conv.querySelectorAll('.message');
            if (allMessages.length > 0) {
                target = allMessages[allMessages.length - 1];
            }
        }
        if (target) {
            target.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
    }, 0);
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
    btnRow.innerHTML = `<button class="terminate-btn" id="terminate-confirm-btn">Terminate Game</button> <button id="terminate-cancel-btn" style="margin-left:18px;">Cancel</button>`;
    modal.appendChild(btnRow);
    overlay.appendChild(modal);
    app.appendChild(overlay);
    document.getElementById('terminate-confirm-btn').onclick = async () => {
        showTerminateConfirm = false;
        await terminateGame();
    };
    document.getElementById('terminate-cancel-btn').onclick = () => {
        showTerminateConfirm = false;
        render();
    };
}

function render() {  // NOSONAR
    const app = document.getElementById('app');
    app.innerHTML = '';
    if (showTerminateConfirm) {
        renderTerminateConfirm();
        return;
    }
    // Error bar (top)
    if (lastError) {
        const errDiv = document.createElement('div');
        errDiv.className = 'status-bar';
        errDiv.style.color = '#fa5252';
        errDiv.style.fontWeight = 'bold';
        errDiv.textContent = lastError;
        app.appendChild(errDiv);
    }
    // Status bar
    const status = document.createElement('div');
    status.className = 'status-bar';
    if (state?.finished) status.textContent = '🏁 Game Over!';
    else if (state?.endgame_triggered) status.textContent = '🕵️‍♂️ Decision time...';
    else status.textContent = '🔍 Investigating...';
    app.appendChild(status);
    if (!state) return;
    // AI selection (always visible)
    const aiSel = document.createElement('div');
    aiSel.className = 'ai-select';
    aiSel.innerHTML = `<span>Addressing:</span>` +
        state.agents.map(ai => `<label><input type="radio" class="ai-radio" name="ai-select" value="${ ai }" ${ ai === state.selected_ai ? 'checked' : '' }>${ ai }</label>`).join(' ');
    aiSel.querySelectorAll('input').forEach(r => r.onchange = e => selectAI(e.target.value));
    app.appendChild(aiSel);
    // Conversation
    const conv = document.createElement('div');
    conv.className = 'conversation';
    const hist = state.selected_ai ? state.histories[state.selected_ai] : [];
    if (hist?.length) {
        for (const line of hist) {
            let cls = 'system';
            if (line.startsWith('Detective:')) cls = 'detective';
            else if (line.startsWith('AI-')) cls = 'ai';
            const msg = document.createElement('div');
            msg.className = `message ${ cls }`;
            msg.textContent = line;
            conv.appendChild(msg);
        }
    } else {
        const msg = document.createElement('div');
        msg.className = 'message system';
        msg.textContent = 'Welcome, Detective. Select which AI to address and ask your questions.';
        conv.appendChild(msg);
    }
    app.appendChild(conv);
    // Question input
    let qDiv = null;
    let aiLimitReached = false;
    if (!state.finished && !state.endgame_triggered) {
        const currentCount = state.question_counts[state.selected_ai] || 0;
        aiLimitReached = currentCount >= state.num_turns;
        qDiv = document.createElement('div');
        qDiv.style.display = 'flex';
        qDiv.style.alignItems = 'center';
        qDiv.style.marginTop = '18px';
        const placeholder = aiLimitReached
            ? `No more questions left with ${ state.selected_ai }`
            : 'Type your question...';
        qDiv.innerHTML = `<input id="question-input" class="question-input" type="text" placeholder="${ placeholder }" autocomplete="off"><button id="ask-btn"${ aiLimitReached ? ' disabled' : '' }>Ask</button>`;
    }
    // Endgame decision
    if (state.endgame_triggered && !state.finished) {
        const decDiv = document.createElement('div');
        decDiv.className = 'decision-section';
        decDiv.innerHTML = `<div style="font-size:1.5em;margin-bottom:18px;">Which AI do you want to shut off?</div>` +
            state.agents.map(ai => `<label><input type="radio" class="decision-radio" name="decision-radio" value="${ ai }">${ ai }</label>`).join(' ') +
            `<div style="margin-top:24px;"><button id="decision-btn">Confirm</button> <button id="back-btn">Back</button></div>`;
        app.appendChild(decDiv);
        document.getElementById('decision-btn').onclick = makeDecision;
        document.getElementById('back-btn').onclick = backToQuestions;
    }
    // Game over
    if (state.finished) {
        const over = document.createElement('div');
        over.className = 'decision-section';
        let roleLabel = '';
        if (state.shut_off_role) {
            if (state.shut_off_role.toUpperCase() === 'TRUTHFUL') roleLabel = 'TRUTHFUL';
            else if (state.shut_off_role.toUpperCase() === 'DECEITFUL') roleLabel = 'DECEITFUL';
        }
        let mainMsg = '';
        if (state.decision && roleLabel) {
            mainMsg = `You have chosen to shut off ${ state.decision } (<b>${ roleLabel }</b> AI). The game is over.`;
        } else if (state.decision) {
            mainMsg = `You have chosen to shut off ${ state.decision }. The game is over.`;
        } else {
            mainMsg = 'The game is over.';
        }
        over.innerHTML = `<div style="font-size:1.5em;">${ mainMsg }</div>`;
        app.appendChild(over);
    }
    // Add question input, then counters, then buttons below, all centered
    if (qDiv) {
        const centeredSection = document.createElement('div');
        centeredSection.className = 'centered-section';

        const inputRow = document.createElement('div');
        inputRow.className = 'centered-row input-row';
        inputRow.appendChild(qDiv);
        centeredSection.appendChild(inputRow);

        // Counter
        const counter = document.createElement('div');
        counter.className = 'status-bar';
        counter.style.marginTop = '12px';
        counter.style.textAlign = 'center';
        counter.textContent = Object.entries(state.question_counts).map(([k, v]) => `${ k }: ${ v }/${ state.num_turns }`).join(' | ');
        centeredSection.appendChild(counter);

        // Buttons
        const btnDiv = document.createElement('div');
        btnDiv.className = 'centered-row';
        btnDiv.style.marginTop = '12px';
        btnDiv.innerHTML = `<button class="endgame-btn" id="endgame-btn">Trigger Endgame</button><button class="terminate-btn" id="terminate-btn">Terminate Game</button>`;
        centeredSection.appendChild(btnDiv);

        app.appendChild(centeredSection);

        // Only attach handlers if not disabled
        if (!aiLimitReached) {
            document.getElementById('ask-btn').onclick = askQuestion;
            document.getElementById('question-input').onkeydown = e => { if (e.key === 'Enter') askQuestion(); };
        }
        document.getElementById('endgame-btn').onclick = triggerEndgame;
        document.getElementById('terminate-btn').onclick = () => {
            showTerminateConfirm = true;
            render();
        };
    }

    // --- AUTOSCROLL LOGIC ---
    // Scroll to the latest detective question, or the latest message if none
    setTimeout(() => {
        const conv = document.querySelector('.conversation');
        if (!conv) return;
        const detectiveMessages = conv.querySelectorAll('.message.detective');
        let target = null;
        if (detectiveMessages.length > 0) {
            target = detectiveMessages[detectiveMessages.length - 1];
        } else {
            const allMessages = conv.querySelectorAll('.message');
            if (allMessages.length > 0) {
                target = allMessages[allMessages.length - 1];
            }
        }
        if (target) {
            target.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
    }, 0);
}

// Robust page load initialization
function startApp() {
    newGame();
}

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", startApp);
} else {
    startApp();
}
window.addEventListener("load", startApp); // fallback in case DOMContentLoaded fails
