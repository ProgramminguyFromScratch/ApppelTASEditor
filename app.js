const solver = new BruteForceSolver();

const COMBO_GRID_ORDER = [0,1,2,3, 4,5,6,7, 8,9,10,11, 12,13,14,15];

function maskLabel(m) {
    let s = '';
    if (m & 8) s += 'W';
    if (m & 2) s += 'A';
    if (m & 4) s += 'S';
    if (m & 1) s += 'D';
    return s || '-';
}

const comboEnabled = new Array(16).fill(true);
const comboMaxFramesData = new Array(16).fill(null);

function buildComboGrid() {
    const grid = document.getElementById('s_comboGrid');
    if (!grid) return;
    grid.innerHTML = '';
    for (const mask of COMBO_GRID_ORDER) {
        const cell = document.createElement('div');
        cell.className = 'combo-toggle' + (comboEnabled[mask] ? '' : ' disabled');
        cell.dataset.mask = mask;

        const labelEl = document.createElement('div');
        labelEl.className = 'combo-toggle-label';
        labelEl.textContent = maskLabel(mask);
        labelEl.title = `Mask ${mask} — click to toggle`;
        labelEl.addEventListener('click', () => {
            comboEnabled[mask] = !comboEnabled[mask];
            cell.classList.toggle('disabled', !comboEnabled[mask]);
        });

        const maxEl = document.createElement('input');
        maxEl.type = 'number';
        maxEl.className = 'combo-max-input';
        maxEl.min = '1';
        maxEl.placeholder = '\u221e';
        maxEl.title = `Max total frames for ${maskLabel(mask)}`;
        maxEl.value = comboMaxFramesData[mask] !== null ? comboMaxFramesData[mask] : '';
        maxEl.addEventListener('click', e => e.stopPropagation());
        maxEl.addEventListener('change', () => {
            const v = parseInt(maxEl.value, 10);
            comboMaxFramesData[mask] = (maxEl.value.trim() !== '' && !isNaN(v) && v >= 1) ? v : null;
        });
        maxEl.addEventListener('input', () => {
            const v = parseInt(maxEl.value, 10);
            comboMaxFramesData[mask] = (maxEl.value.trim() !== '' && !isNaN(v) && v >= 1) ? v : null;
        });

        cell.appendChild(labelEl);
        cell.appendChild(maxEl);
        grid.appendChild(cell);
    }
}

function setAllCombos(enabled) {
    comboEnabled.fill(enabled);
    document.querySelectorAll('.combo-toggle').forEach(cell => {
        cell.classList.toggle('disabled', !enabled);
    });
}

// Run after DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', buildComboGrid);
} else {
    buildComboGrid();
}

const THUMB_W = 170;
const THUMB_H = 128;
const THUMB_ZOOM = 0.5;

let frameRenderer = null;
let frameRendererCanvas = null;
let frameRendererReady = false;
let currentLevelDataForRenderer = null;
let pendingFrameStrip = null;

function initFrameRenderer(levelCode) {
    frameRendererCanvas = document.createElement('canvas');
    frameRendererCanvas.width = THUMB_W / THUMB_ZOOM;
    frameRendererCanvas.height = THUMB_H / THUMB_ZOOM;

    frameRenderer = new LevelRenderer(frameRendererCanvas);
    currentLevelDataForRenderer = LevelRenderer.getDataFromCode(levelCode);

    document.getElementById('s_assetsStatus').textContent = 'Loading assets...';
    document.getElementById('s_assetsStatus').className = 'loading';

    frameRenderer.loadAssets(() => {}).then(() => {
        frameRendererReady = true;
        document.getElementById('s_assetsStatus').textContent = 'Renderer ready';
        document.getElementById('s_assetsStatus').className = 'ready';
        if (pendingFrameStrip) {
            renderFrameStrip(pendingFrameStrip.inputs, pendingFrameStrip.states);
            pendingFrameStrip = null;
        }
    });
}


function renderFrameThumb(playerState) {
    if (!frameRendererReady || !currentLevelDataForRenderer) return null;

    const camera = {
        x: playerState.PLAYER_X,
        y: playerState.PLAYER_Y,
        zoom: 1
    };

    frameRenderer.render(currentLevelDataForRenderer, camera);

    const playerPos = {
        x: playerState.PLAYER_X,
        y: playerState.PLAYER_Y,
        angle: playerState.direction || 0,
        crouched: playerState.player_state === 2,
        onWall: playerState.player_wall != null,
        dir: playerState.PLAYER_DIR
    };
    frameRenderer.renderPlayer(playerPos, camera);

    const thumb = document.createElement('canvas');
    thumb.width = THUMB_W;
    thumb.height = THUMB_H;
    const tctx = thumb.getContext('2d');
    tctx.drawImage(frameRendererCanvas, 0, 0, THUMB_W, THUMB_H);
    return thumb;
}

function renderFrameStrip(inputs, states) {
    if (!frameRendererReady) {
        pendingFrameStrip = { inputs, states };
        return;
    }

    // Update the copyable TAS-format output box
    const tasOut = document.getElementById('s_tasOutput');
    if (tasOut) {
        tasOut.value = inputsToTASFormat(inputs);
    }

    const strip = document.getElementById('s_frameStrip');
    strip.innerHTML = '';

    states.forEach((state, i) => {
        const inputLabel = i === 0 ? '-' : inputsToString([inputs[i - 1]]);
        const isDeath = state.death;

        const thumb = renderFrameThumb(state);
        if (!thumb) return;

        const wrapper = document.createElement('div');
        wrapper.className = 'frame-thumb' + (isDeath ? ' death-frame' : '');
        wrapper.title = `Frame ${i} | Input: ${inputLabel} | X: ${state.x.toFixed(1)} Y: ${state.y.toFixed(1)}`;

        const numEl = document.createElement('div');
        numEl.className = 'frame-num';
        numEl.textContent = `F${i}`;

        const inputEl = document.createElement('div');
        inputEl.className = 'frame-input';
        inputEl.textContent = isDeath ? 'DEAD' : inputLabel;

        wrapper.appendChild(thumb);
        wrapper.appendChild(inputEl);
        wrapper.appendChild(numEl);

        wrapper.addEventListener('click', () => {
            document.querySelectorAll('.frame-thumb').forEach(el => el.classList.remove('selected'));
            wrapper.classList.add('selected');
            showFrameInfo(i, inputLabel, state);
        });

        strip.appendChild(wrapper);
    });

    const thumbs = strip.querySelectorAll('.frame-thumb');
    if (thumbs.length) {
        thumbs[thumbs.length - 1].classList.add('selected');
        const last = states[states.length - 1];
        const lastInput = inputs.length ? inputsToString([inputs[inputs.length - 1]]) : '-';
        showFrameInfo(states.length - 1, lastInput, last);
    }
}


let solverFrameInfoOpen = false;

document.addEventListener('DOMContentLoaded', () => {
    const summaryEl = document.getElementById('s_frameInfoSummary');
    if (summaryEl) {
        summaryEl.addEventListener('click', () => {
            solverFrameInfoOpen = !solverFrameInfoOpen;
            const exp = document.getElementById('s_frameInfoExpanded');
            const tog = document.getElementById('s_frameInfoToggle');
            if (exp) exp.classList.toggle('open', solverFrameInfoOpen);
            if (tog) tog.textContent = solverFrameInfoOpen ? '[ collapse ]' : '[ expand state ]';
        });
    }
});

function fmt(v) {
    if (v === null) return 'null';
    if (v === true) return 'true';
    if (v === false) return 'false';
    if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(4);
    return String(v);
}

function valClass(key, v) {
    if (key === 'PLAYER_DEATH' && v) return 'dead';
    if (key === 'wasInSpikeTileLastFrame' && v) return 'warn';
    if (key === 'is_falling' && v > 10) return 'warn';
    return '';
}

function showFrameInfo(frameIdx, inputLabel, state) {
    const summary = document.getElementById('s_frameInfoSummary');
    const exp = document.getElementById('s_frameInfoExpanded');

    if (!summary) return;

    summary.innerHTML = `Frame <span>${frameIdx}</span> | Input: <span>${inputLabel}</span> | X: <span>${state.x.toFixed(2)}</span> | Y: <span>${state.y.toFixed(2)}</span> | SX: <span>${state.sx.toFixed(2)}</span> | SY: <span>${state.sy.toFixed(2)}</span><span id="s_frameInfoToggle" style="color:#444;font-size:10px;margin-left:auto">${solverFrameInfoOpen ? '[ collapse ]' : '[ expand state ]'}</span>`;

    document.getElementById('s_frameInfoToggle').addEventListener('click', (e) => {
        e.stopPropagation();
        solverFrameInfoOpen = !solverFrameInfoOpen;
        if (exp) exp.classList.toggle('open', solverFrameInfoOpen);
        const tog = document.getElementById('s_frameInfoToggle');
        if (tog) tog.textContent = solverFrameInfoOpen ? '[ collapse ]' : '[ expand state ]';
    });

    if (!exp) return;

    const sections = {
        'Position & Velocity': ['PLAYER_X','PLAYER_Y','PLAYER_SX','PLAYER_SY'],
        'Player State': ['player_state','player_wall','flipped','PLAYER_DIR','direction'],
        'Jump & Fall': ['is_jumping','is_falling','KEY_UP'],
        'Flags': ['PLAYER_DEATH','wasInSpikeTileLastFrame'],
        'Friction': ['friction','friction_dx','friction_dy'],
        'Keys': ['KEY_LEFT', 'KEY_RIGHT', 'KEY_UP', 'KEY_DOWN'],
        'Hitbox (PSZ)': ['PSZ'],
    };

    let html = '<div class="state-grid">';
    for (const [section, keys] of Object.entries(sections)) {
        html += `<div class="state-section">${section}</div>`;
        for (const key of keys) {
            if (!(key in state)) continue;
            const v = state[key];
            const display = Array.isArray(v) ? '[' + v.join(', ') + ']' : fmt(v);
            const cls = valClass(key, v);
            html += `<div class="state-row"><span class="state-key">${key}</span><span class="state-val ${cls}">${display}</span></div>`;
        }
    }
    html += '</div>';
    exp.innerHTML = html;
}

// [manual replay removed]
function _unused_parseInputSequence(str) {
    return str.split(',').map(token => {
        const t = token.trim().toUpperCase();
        let mask = 0;
        if (t.includes('W')) mask |= 8;
        if (t.includes('A')) mask |= 2;
        if (t.includes('S')) mask |= 4;
        if (t.includes('D')) mask |= 1;
        return mask;
    });
}

async function _unused_runManualReplay() {
    const errEl = document.getElementById('s_replayError');
    errEl.textContent = '';

    const levelCode = document.getElementById('levelCode').value;
    const stateStr  = document.getElementById('s_playerState').value;
    const seqStr    = document.getElementById('s_replayInput').value.trim();

    if (!levelCode) { errEl.textContent = 'Error: No level code.'; return; }
    if (!stateStr)  { errEl.textContent = 'Error: No player state. Click "Get Current Player State" first.'; return; }
    if (!seqStr)    { errEl.textContent = 'Error: Input sequence is empty.'; return; }

    if (!frameRendererReady) initFrameRenderer(levelCode);

    let levelData, physics, startState, originalMAP;
    try {
        levelData  = LevelRenderer.getDataFromCode(levelCode);
        physics    = new AppelPhysics(levelData.map, levelData.rotations, levelData.MAP_DATA, levelData.size_x);
        startState = JSON.parse(stateStr);
    } catch (e) {
        errEl.textContent = 'Error: ' + e.message;
        return;
    }

    if (physics.touching && physics.touching.loadPromise) {
        errEl.textContent = 'Waiting for spike data to load...';
        try { await physics.touching.loadPromise; } catch(e) {}
        errEl.textContent = '';
    }

    if (physics.touching && physics.touching.bakeForLevel) {
        physics.touching.bakeForLevel(physics);
    }

    startState.mapChangesEmpty = true;
    startState.mapChanges = {};
    if (physics.MAP) {
        originalMAP = [...physics.MAP];
    }

    if (!startState.activeIdx) startState.activeIdx = [];
    if (!startState.activeTyp) startState.activeTyp = [];
    if (!startState.activeFrame) startState.activeFrame = [];
    if (!startState.activeIdxSpawn) startState.activeIdxSpawn = [];

    const inputMasks = parseInputSequence(seqStr);

    const states = [];
    let state = JSON.parse(JSON.stringify(startState));

    const snap = s => ({
        x: s.PLAYER_X, y: s.PLAYER_Y,
        sx: s.PLAYER_SX, sy: s.PLAYER_SY,
        death: s.PLAYER_DEATH,
        PLAYER_X: s.PLAYER_X, PLAYER_Y: s.PLAYER_Y,
        PLAYER_SX: s.PLAYER_SX, PLAYER_SY: s.PLAYER_SY,
        PLAYER_DEATH: s.PLAYER_DEATH,
        PLAYER_DIR: s.PLAYER_DIR,
        direction: s.direction || 0,
        player_state: s.player_state,
        player_wall:  s.player_wall,
        flipped: s.flipped,
        is_jumping: s.is_jumping,
        is_falling: s.is_falling,
        KEY_UP: s.KEY_UP,
        KEY_LEFT: s.KEY_LEFT,
        KEY_RIGHT: s.KEY_RIGHT,
        KEY_DOWN: s.KEY_DOWN,
        wasInSpikeTileLastFrame: s.wasInSpikeTileLastFrame,
        friction: s.friction,
        friction_dx: s.friction_dx,
        friction_dy: s.friction_dy,
        PSZ: s.PSZ ? [...s.PSZ] : null,
    });

    states.push(snap(state));
    for (const mask of inputMasks) {
        const nextState = JSON.parse(JSON.stringify(state));

        if (!nextState.mapChanges) nextState.mapChanges = {};

        if (nextState.mapChangesEmpty === false) {
            for (const idxStr in nextState.mapChanges) {
                physics.MAP[+idxStr] = nextState.mapChanges[idxStr];
            }
        }

        physics.tick(nextState, mask);
        state = nextState;

        if (state.mapChangesEmpty === false && originalMAP) {
            const mc = state.mapChanges;
            for (const idxStr in mc) {
                physics.MAP[+idxStr] = originalMAP[+idxStr];
            }
        }

        states.push(snap(state));
    }

    renderFrameStrip(inputMasks, states);
}


/**
 * Reads the player state from the TAS editor at its current frame and
 * fills the solver's player state textarea with the JSON.
 */
function getCurrentPlayerState() {
    if (typeof tasEditor === 'undefined' || !tasEditor || !tasEditor.game || !tasEditor.game.playerState) {
        alert('TAS editor not ready. Load a level and let it initialise first.');
        return;
    }
    const state = tasEditor.game.playerState;
    document.getElementById('s_playerState').value = JSON.stringify(state, null, 2);
}

async function startSolver() {
    // levelCode is the shared TAS editor input
    const levelCode = document.getElementById('levelCode').value;
    const stateStr  = document.getElementById('s_playerState').value;
    const depth     = parseInt(document.getElementById('s_depth').value);
    const goalExpr  = document.getElementById('s_goalExpr').value.trim() || 'PLAYER_X';
    const goalDir   = document.getElementById('s_goalDir').value;

    if (!stateStr) return alert('Please provide a player state. Click "Get Current Player State" first.');

    const statusEl = document.getElementById('s_statusText');
    const timeEl   = document.getElementById('s_solveTime');

    statusEl.innerText = 'Loading...';
    statusEl.style.color = '#ffaa00';
    timeEl.innerText = '0.00s';

    if (!frameRendererReady) {
        initFrameRenderer(levelCode);
    }

    await solver.init(levelCode, stateStr);

    statusEl.innerText = 'Running...';
    statusEl.style.color = '#00ff55';

    const killZone  = document.getElementById('s_killZone').value;
    const framePins = parseFramePins(document.getElementById('s_framePins').value);

    const comboMaxFrames = comboMaxFramesData.some(v => v !== null) ? comboMaxFramesData : null;

    const startTime = performance.now();

    solver.solve(depth, goalExpr, goalDir, (data) => {
        document.getElementById('s_iterCount').innerText = data.iterations.toLocaleString();

        const elapsed = (performance.now() - startTime) / 1000;
        timeEl.innerText = elapsed.toFixed(2) + 's';

        if (data.foundNew) {
            document.getElementById('s_bestScore').innerText = data.score.toFixed(2);
            renderFrameStrip(data.inputs, data.states);
        }

        if (data.done) {
            statusEl.innerText = 'Completed';
            statusEl.style.color = '#ffff00';
            const finalElapsed = (performance.now() - startTime) / 1000;
            timeEl.innerText = finalElapsed.toFixed(2) + 's';
        }
    }, killZone, comboEnabled, framePins, comboMaxFrames);
}

function setGoal(expr, dir) {
    document.getElementById('s_goalExpr').value = expr;
    document.getElementById('s_goalDir').value = dir;
}

/**
 * Parse a single pin key string into a structured pin object.
 *
 * Supported formats (case-insensitive):
 *   "WD"     -> exact: only W+D pressed (backward compatible)
 *   ""       -> exact: no keys pressed
 *   "+W"     -> require W to be held (other keys don't matter)
 *   "-D"     -> D must NOT be held (other keys don't matter)
 *   "+W-D"   -> W must be held AND D must not be held
 *   "!WD"    -> anything except exactly W+D
 */
function parsePinKeys(keys) {
    const k = (keys || '').trim().toUpperCase();

    if (k.startsWith('!')) {
        let mask = 0;
        const rest = k.slice(1);
        if (rest.includes('W')) mask |= 8;
        if (rest.includes('A')) mask |= 2;
        if (rest.includes('S')) mask |= 4;
        if (rest.includes('D')) mask |= 1;
        return { type: 'exclude', mask };
    }

    if (k.includes('+') || k.includes('-')) {
        let mustSet = 0, mustClear = 0;
        const KEY_BITS = { W: 8, A: 2, S: 4, D: 1 };
        for (let i = 0; i < k.length - 1; i++) {
            const sign = k[i];
            if (sign !== '+' && sign !== '-') continue;
            const bit = KEY_BITS[k[i + 1]] || 0;
            if (sign === '+') mustSet   |= bit;
            else              mustClear |= bit;
            i++;
        }
        return { type: 'constraint', mustSet, mustClear };
    }

    let mask = 0;
    if (k.includes('W')) mask |= 8;
    if (k.includes('A')) mask |= 2;
    if (k.includes('S')) mask |= 4;
    if (k.includes('D')) mask |= 1;
    return { type: 'exact', mask };
}

/**
 * Parse frame-pin string like "1:WD, 3:+W-D, 5:!A, 7:" into a map of
 * frame -> pin object. Keys are 1-based frame indices.
 *
 *   "1:WD"     exact W+D
 *   "2:+W"     W must be held
 *   "3:-D"     D must NOT be held
 *   "4:+W-D"   W held AND D not held
 *   "5:!WD"    anything except exactly W+D
 *   "6:"       no keys at all (exact)
 */
function parseFramePins(str) {
    if (!str || !str.trim()) return null;
    const result = {};
    for (const token of str.split(',')) {
        const t = token.trim();
        if (!t) continue;
        const colon = t.indexOf(':');
        if (colon === -1) continue;
        const frameNum = parseInt(t.slice(0, colon).trim(), 10);
        if (isNaN(frameNum) || frameNum < 1) continue;
        result[frameNum] = parsePinKeys(t.slice(colon + 1));
    }
    return Object.keys(result).length ? result : null;
}