class TASSaveState {
    constructor(tick) {
        this.tick = tick;
    }
}

class TAEditor {
    constructor(game) {
        this.game        = game;
        this.paused      = false;
        this.frameStepMode  = false;
        this.stepNextFrame  = false;
        this.currentFPS     = 30;
        this.baseFrameDuration = 1000 / this.currentFPS;
        this.gameLoopInterval  = null;

        this.inputFrames  = [];
        this.breakFrames  = new Set();
        this.frameTokenMap = {};

        this.savestates = { 1: null, 2: null, 3: null };

        this.frameStates = [];

        this.pxPerFrame = 4;

        this.cameraOffset = { x: 0, y: 0 };
        this._isPanning   = false;
        this._panLast     = { x: 0, y: 0 };

        this.setupEventListeners();
        this.setupCameraPan();
        this.setupTimelineEvents();
        this.updateInputDisplay();
        this.updateReplayCode();
    }

    resimulate() {
        if (!this.game.physics || !this.game.levelData) return;

        const physics = this.game.physics;

        const levelData = this.levelData = LevelRenderer.getDataFromCode(levelCode);
        this.game.physics.MAP = levelData.map;

        this.frameStates = [];

        let state  = physics.createDefaultGameState(physics.spawnOBJ(levelData));
        let camera = { x: state.PLAYER_X, y: state.PLAYER_Y, zoom: 1.25 };

        this.frameStates[0] = {
            playerState: JSON.parse(JSON.stringify(state)),
            camera:      { ...camera },
            physicsMap:  physics.MAP.slice()
        };

        const totalFrames = this.inputFrames.length;

        for (let i = 0; i < totalFrames; i++) {
            const input = this.inputFrames[i] || '';
            state = physics.tick(state, input);

            camera.x += (state.PLAYER_X - camera.x) * 0.2;
            camera.y += ((state.PLAYER_Y - camera.y) + 8) * 0.2;

            if (state.PLAYER_DEATH) {
                state = physics.createDefaultGameState(state.OBJ);
            }

            this.frameStates[i + 1] = {
                playerState: JSON.parse(JSON.stringify(state)),
                camera:      { ...camera },
                physicsMap:  physics.MAP.slice()
            };
        }

        const maxTick = this.frameStates.length - 1;
        if (this.game.tick > maxTick) {
            this.game.tick = maxTick;
        }

        const curFrame = this.frameStates[this.game.tick];
        if (curFrame) {
            this.game.playerState = Object.assign({}, curFrame.playerState);
            this.game.camera      = { ...curFrame.camera };
        }

        this.drawTimeline();
        this.updateTimelinePlayhead();
        this.updatePlayerStateDisplay();
        this.updateStatus();
    }

    seekToFrame(tick) {
        if (!this.frameStates || this.frameStates.length === 0) return;

        tick = Math.max(0, Math.min(tick, this.frameStates.length - 1));
        this.game.tick = tick;

        const frame = this.frameStates[tick];
        if (frame) {
            this.game.playerState = Object.assign({}, frame.playerState);
            this.game.camera      = { ...frame.camera };
            if (frame.physicsMap && this.game.physics) {
                const saved = frame.physicsMap;

                const physMap = this.game.physics.MAP;
                for (let i = 0; i < saved.length; i++) physMap[i] = saved[i];

                const ldMap = this.game.levelData && this.game.levelData.map;
                if (ldMap && ldMap !== physMap) {
                    for (let i = 0; i < saved.length; i++) ldMap[i] = saved[i];
                }
            }
        }

        this.updateTimelinePlayhead();
        this.updatePlayerStateDisplay();
        this.updateStatus();
    }

    applyFPS(fps) {
        this.currentFPS        = fps;
        this.baseFrameDuration = 1000 / fps;
        document.getElementById('fpsInput').value = fps;

        if (this.gameLoopInterval) clearInterval(this.gameLoopInterval);

        this.gameLoopInterval = window.setInterval(() => {
            if (this.game && typeof this.game.gameLoop === 'function') {
                this.game.gameLoop();
            }
        }, this.baseFrameDuration);
    }

    update() {
        if (!this.frameStates || this.frameStates.length === 0) return;

        if (this.frameStepMode) {
            if (this.stepNextFrame) {
                this.seekToFrame(this.game.tick + 1);
                this.stepNextFrame = false;
            }
            return;
        }

        if (!this.paused) {
            const next = this.game.tick + 1;

            if (next >= this.frameStates.length) {
                this.paused        = true;
                this.frameStepMode = true;
                this.updateStatus();
                return;
            }

            this.seekToFrame(next);

            if (this.breakFrames.has(this.game.tick)) {
                this.paused        = true;
                this.frameStepMode = true;
            }
        }
    }

    modifyGameLoop(gameInstance) {
        gameInstance.gameLoop = () => {
            gameInstance.profiler.start('Total Frame');
            gameInstance.profiler.tick();

            gameInstance.profiler.start('Physics');
            this.update();
            gameInstance.profiler.end('Physics');

            const simCam = gameInstance.camera;
            const renderCam = {
                x:    simCam.x    + this.cameraOffset.x,
                y:    simCam.y    + this.cameraOffset.y,
                zoom: simCam.zoom,
            };

            if (gameInstance.levelData) {
                gameInstance.profiler.start('Render: Level');
                gameInstance.renderer.render(gameInstance.levelData, renderCam);
                gameInstance.profiler.end('Render: Level');
            }

            const savedCam = gameInstance.camera;
            gameInstance.camera = renderCam;
            gameInstance.profiler.start('Render: Player');
            gameInstance.drawEntities();
            gameInstance.profiler.end('Render: Player');
            gameInstance.camera = savedCam;

            gameInstance.profiler.draw(gameInstance.ctx);
            gameInstance.profiler.end('Total Frame');
        };
    }

    setupCameraPan() {
        const PAN_SENSITIVITY = 1.25;

        const init = () => {
            const canvas = document.getElementById('gameCanvas');
            if (!canvas) { setTimeout(init, 100); return; }

            canvas.style.cursor = 'grab';

            canvas.addEventListener('mousedown', (e) => {
                if (e.button !== 0) return;
                document.getElementById('inputEditor').blur();
                this._isPanning = true;
                this._panLast   = { x: e.clientX, y: e.clientY };
                canvas.style.cursor = 'grabbing';
                e.preventDefault();
            });

            window.addEventListener('mousemove', (e) => {
                if (!this._isPanning) return;
                const dx = e.clientX - this._panLast.x;
                const dy = e.clientY - this._panLast.y;
                this._panLast = { x: e.clientX, y: e.clientY };

                this.cameraOffset.x -= dx / PAN_SENSITIVITY;
                this.cameraOffset.y += dy / PAN_SENSITIVITY;
            });

            window.addEventListener('mouseup', () => {
                if (this._isPanning) {
                    this._isPanning = false;
                    canvas.style.cursor = 'grab';
                }
            });

            canvas.addEventListener('dblclick', () => {
                this.cameraOffset = { x: 0, y: 0 };
            });
        };

        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', init);
        } else {
            init();
        }
    }

    overrideGetInputKeys() {
        this.game.getInputKeys = () => {
            if (this.game.gameState === 'WIN') return '';
            return this.inputFrames[this.game.tick] || '';
        };
    }

    wrapGameInit() {
        const tasEditor = this;
        const originalInit = this.game.init.bind(this.game);
        let isWrapped = false;

        const originalCheckLoadStatus = this.game.checkLoadStatus.bind(this.game);
        this.game.checkLoadStatus = function () {
            const wasLoading = this.gameState !== 'PLAY';
            originalCheckLoadStatus();
            if (wasLoading && this.gameState === 'PLAY') {
                tasEditor.resimulate();
                tasEditor.seekToFrame(0);
            }
        };

        this.game.init = function (levelCode) {
            tasEditor.frameStates = [];

            if (tasEditor.gameLoopInterval) {
                clearInterval(tasEditor.gameLoopInterval);
                tasEditor.gameLoopInterval = null;
            }

            if (!isWrapped) {
                const originalSetInterval = window.setInterval;
                window.setInterval = function (...args) {
                    const id = originalSetInterval.apply(window, args);
                    tasEditor.gameLoopInterval = id;
                    return id;
                };
                isWrapped = true;
            }

            originalInit(levelCode);
        };
    }

    getInputColor(input) {
        const w = input.includes('W');
        const a = input.includes('A');
        const s = input.includes('S');
        const d = input.includes('D');

        if (!w && !a && !s && !d) return '#141414';

        let r = 0, g = 0, b = 0, cnt = 0;
        if (d) { r +=  0; g += 255; b += 0; cnt++; }
        if (a) { r += 255; g += 0; b +=   0; cnt++; }
        if (w) { r +=   0; g += 0; b +=  255; cnt++; }
        if (s) { r += 255; g +=   255; b +=  255; cnt++; } 

        return `rgb(${Math.round(r / cnt)},${Math.round(g / cnt)},${Math.round(b / cnt)})`;
    }

    drawTimeline() {
        const canvas = document.getElementById('timelineCanvas');
        const track  = document.getElementById('timeline-track');
        if (!canvas || !track) return;

        const total = this.frameStates.length;
        if (total === 0) return;

        const px     = this.pxPerFrame;
        const trackH = track.clientHeight || 58;
        const totalW = Math.max(total * px, track.clientWidth);

        canvas.width  = totalW;
        canvas.height = trackH;

        const ctx = canvas.getContext('2d');

        ctx.fillStyle = '#0a0a0a';
        ctx.fillRect(0, 0, totalW, trackH);

        const barH     = Math.floor(trackH * 0.60);
        const tickTop  = barH + 2;
        const labelY   = trackH - 2;

        for (let i = 0; i < total; i++) {
            ctx.fillStyle = this.getInputColor(this.inputFrames[i] || '');
            const w = px > 2 ? px - 1 : px;
            ctx.fillRect(i * px, 0, w, barH);
        }

        ctx.fillStyle = '#2a2a2a';
        ctx.fillRect(0, barH, totalW, 1);

        ctx.font      = '9px monospace';
        ctx.textAlign = 'left';

        for (let i = 0; i < total; i++) {
            const x = i * px;

            if (i % 30 === 0) {
                ctx.fillStyle = '#555';
                ctx.fillRect(x, tickTop, 1, 10);
                ctx.fillStyle = '#888';
                ctx.fillText(`${(i / 30).toFixed(1)}s`, x + 2, labelY);
            } else if (i % 5 === 0 && px >= 3) {
                ctx.fillStyle = '#2c2c2c';
                ctx.fillRect(x, tickTop, 1, 5);
            }
        }

        this.updateTimelinePlayhead();
    }

    updateTimelinePlayhead() {
        const playhead = document.getElementById('timeline-playhead');
        const track    = document.getElementById('timeline-track');
        const timeEl   = document.getElementById('timeline-time');

        const tick = this.game ? this.game.tick - 1 : 0;
        const x    = Math.max(0, tick) * this.pxPerFrame;

        if (playhead) {
            playhead.style.transform = `translateX(${x}px)`;
        }

        if (timeEl) {
            timeEl.textContent = `${(tick / 30).toFixed(3)}s  |  Frame ${tick}`;
        }

        if (track) {
            const tw = track.clientWidth;
            const sl = track.scrollLeft;
            const margin = 60;
            if (x < sl + margin || x > sl + tw - margin) {
                track.scrollLeft = x - tw / 2;
            }
        }
    }

    setupTimelineEvents() {
        const init = () => {
            const track    = document.getElementById('timeline-track');
            const canvas   = document.getElementById('timelineCanvas');
            const zoomCtrl = document.getElementById('timelineZoom');

            if (!track || !canvas) { setTimeout(init, 100); return; }

            let dragging = false;

            const frameFromPointer = (e) => {
                const rect = canvas.getBoundingClientRect();
                const x = e.clientX - rect.left;
                return Math.floor(x / this.pxPerFrame);
            };

            canvas.addEventListener('mousedown', (e) => {
                e.preventDefault();
                dragging = true;
                this.seekToFrame(frameFromPointer(e));
            });

            window.addEventListener('mousemove', (e) => {
                if (!dragging) return;
                this.seekToFrame(frameFromPointer(e));
            });

            window.addEventListener('mouseup', () => { dragging = false; });

            if (zoomCtrl) {
                zoomCtrl.addEventListener('input', (e) => {
                    this.pxPerFrame = parseInt(e.target.value, 10);
                    this.drawTimeline();
                });
            }
        };

        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', init);
        } else {
            init();
        }
    }

    compressReplayArray(frames) {
        if (!frames || frames.length === 0) return '';
        let result = '';
        let cur   = frames[0] === '' ? '_' : frames[0];
        let count = 0;

        for (let i = 0; i < frames.length; i++) {
            const inp = frames[i] === '' ? '_' : frames[i];
            if (inp === cur) {
                count++;
            } else {
                result += cur + count + '\n';
                cur   = inp;
                count = 1;
            }
        }
        if (count > 0) result += cur + count + '\n';
        return result;
    }

    parseInputs() {
        this.inputFrames   = [];
        this.breakFrames.clear();
        this.frameTokenMap = {};

        const text = document.getElementById('inputEditor').value;
        let currentFrame = 0;

        const parseRange = (startPos, endPos) => {
            let pos = startPos;

            while (pos < endPos) {
                const c = text[pos];

                if (/\s/.test(c)) { pos++; continue; }

                if (c === '/' && pos + 1 < endPos && text[pos + 1] === '/') {
                    while (pos < endPos && text[pos] !== '\n') pos++;
                    continue;
                }

                if (text.slice(pos, pos + 5).toLowerCase() === 'break' &&
                    (pos + 5 >= endPos || /\W/.test(text[pos + 5]))) {
                    this.breakFrames.add(currentFrame);
                    while (pos < endPos && text[pos] !== '\n') pos++;
                    continue;
                }

                if (c === '(') {
                    const innerStart = pos + 1;
                    pos++;
                    let depth = 1;
                    while (pos < endPos && depth > 0) {
                        if      (text[pos] === '(') depth++;
                        else if (text[pos] === ')') depth--;
                        pos++;
                    }
                    const innerEnd = pos - 1;

                    const countMatch = /^\d+/.exec(text.slice(pos));
                    let repeatCount = 1;
                    if (countMatch) {
                        repeatCount = parseInt(countMatch[0], 10);
                        pos += countMatch[0].length;
                    }

                    for (let r = 0; r < repeatCount; r++) {
                        parseRange(innerStart, innerEnd);
                    }
                    continue;
                }

                const tokenMatch = /^([wsad_\-]*?)(\d+)/i.exec(text.slice(pos));
                if (tokenMatch) {
                    const absStart = pos;
                    const absEnd   = pos + tokenMatch[0].length;

                    const inputs = tokenMatch[1]
                        .toUpperCase()
                        .replace(/[_\-\s]/g, '')
                        .split('')
                        .filter((v, i, a) => a.indexOf(v) === i)
                        .join('');

                    const duration       = parseInt(tokenMatch[2], 10);
                    const tokenStartFrame = currentFrame;

                    for (let i = 0; i < duration; i++) {
                        this.inputFrames[currentFrame + i] = inputs;
                        this.frameTokenMap[currentFrame + i] = {
                            absStart,
                            absEnd,
                            tokenStartFrame,
                            tokenDuration: duration
                        };
                    }
                    currentFrame += duration;
                    pos = absEnd;
                    continue;
                }

                pos++;
            }
        };

        parseRange(0, text.length);

        for (let i = 0; i < this.inputFrames.length; i++) {
            if (this.inputFrames[i] === undefined) this.inputFrames[i] = '';
        }
    }

    encodeReplayCode() {
        const username = 'TAS';
        const level    = '12';
        const keyMap   = { D: 1, A: 2, S: 4, W: 8 };
        const parts    = [];

        let lastCode = -1;
        for (let f = 0; f < this.inputFrames.length; f++) {
            let code = 0;
            for (const ch of (this.inputFrames[f] || '')) {
                if (keyMap[ch]) code += keyMap[ch];
            }
            if (code !== lastCode) {
                parts.push((f + 1).toString(), code.toString());
                lastCode = code;
            }
        }
        parts.push(this.inputFrames.length.toString());

        const data = username + 'ǇǇ' + level + 'Ǉ0Ǉ' + parts.join('Ǉ');
        return (12345678 + data.length).toString() + data;
    }

    updateReplayCode() {
        document.getElementById('replayCode').value = this.encodeReplayCode();
    }

    updateInputDisplay() {}

    highlightCurrentInput() {
        const overlay  = document.getElementById('inputHighlightOverlay');
        const textarea = document.getElementById('inputEditor');
        if (!overlay || !textarea) return;

        const text        = textarea.value;
        const displayText = text.endsWith('\n') ? text + ' ' : text;
        const len         = displayText.length;

        const tick      = this.game ? this.game.tick : 0;
        const tokenInfo = this.frameTokenMap && this.frameTokenMap[tick - 1];
        const absStart  = tokenInfo ? tokenInfo.absStart : -1;
        const absEnd    = tokenInfo ? tokenInfo.absEnd   : -1;

        const charType = new Uint8Array(len);

        let pos = 0;
        while (pos < text.length) {
            if (text[pos] === '(') {
                charType[pos] = 2; pos++;
            } else if (text[pos] === ')') {
                charType[pos] = 2; pos++;
                const m = /^\d+/.exec(text.slice(pos));
                if (m) {
                    for (let i = 0; i < m[0].length; i++) charType[pos + i] = 2;
                    pos += m[0].length;
                }
            } else { pos++; }
        }

        if (tokenInfo) {
            for (let i = absStart; i < absEnd && i < len; i++) charType[i] = 1;
        }

        const esc = (ch) => {
            if (ch === '&') return '&amp;';
            if (ch === '<') return '&lt;';
            if (ch === '>') return '&gt;';
            return ch;
        };

        const spanOpen = ['', '<span class="current-token">', '<span class="paren-syntax">'];
        let html = '', curType = -1;
        for (let i = 0; i < len; i++) {
            const t = charType[i];
            if (t !== curType) {
                if (curType > 0) html += '</span>';
                if (t > 0)       html += spanOpen[t];
                curType = t;
            }
            html += esc(displayText[i]);
        }
        if (curType > 0) html += '</span>';

        overlay.innerHTML = html;

        if (tokenInfo && document.activeElement !== textarea) {
            const lineNum   = (text.substring(0, absStart).match(/\n/g) || []).length;
            const lineH     = 20;
            const target    = lineNum * lineH - textarea.clientHeight / 2 + lineH;
            textarea.scrollTop = Math.max(0, target);
        }

        overlay.scrollTop  = textarea.scrollTop;
        overlay.scrollLeft = textarea.scrollLeft;
    }

    setupEventListeners() {
        const inputEditor = document.getElementById('inputEditor');
        const levelCodeBox   = document.getElementById('levelCode');
        const fpsInput    = document.getElementById('fpsInput');
        const importBtn   = document.getElementById('importReplayBtn');

        levelCodeBox.addEventListener('change', () => {
            levelCode = levelCodeBox.value.trim();
            if (levelCode) {
                this.game.init(levelCode);
                this.resimulate();
                setTimeout(() => this.applyFPS(this.currentFPS), 50);
            }
        });

        inputEditor.addEventListener('input', () => {
            this.parseInputs();
            this.resimulate();
            this.updateReplayCode();
            this.highlightCurrentInput();
        });

        inputEditor.addEventListener('scroll', () => {
            const overlay = document.getElementById('inputHighlightOverlay');
            if (overlay) {
                overlay.scrollTop  = inputEditor.scrollTop;
                overlay.scrollLeft = inputEditor.scrollLeft;
            }
        });

        fpsInput.addEventListener('change', (e) => {
            const val = parseInt(e.target.value, 10);
            if (!isNaN(val) && val > 0) {
                this.applyFPS(val);
            } else {
                e.target.value = this.currentFPS;
            }
        });

        importBtn.addEventListener('click', () => {
            if (!confirm('WARNING: Importing a replay will OVERWRITE your current frame inputs. Continue?')) return;
            const code = prompt('Paste your replay code here:');
            if (!code) return;
            try {
                const frames = decodeReplayCode(code);
                if (!Array.isArray(frames)) { alert('Invalid replay code structure.'); return; }
                document.getElementById('inputEditor').value = this.compressReplayArray(frames);
                this.parseInputs();
                this.resimulate();
                this.updateReplayCode();
                alert('Replay imported successfully!');
            } catch (err) {
                alert('Failed to decode replay code: ' + err.message);
                console.error(err);
            }
        });

        window.addEventListener('keydown', (e) => {
            const el = document.activeElement;
            if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') return;

            switch (e.code) {
                case 'KeyQ':    e.preventDefault(); this.restartTAS();  break;
                case 'KeyV':    e.preventDefault(); this.togglePause(); break;
                case 'KeyB':    e.preventDefault(); this.resetFPS();    break;
                case 'KeyC':    e.preventDefault(); this.stepBack();    break;
                case 'Digit1': case 'Numpad1': e.preventDefault(); this.saveState(1); break;
                case 'Digit2': case 'Numpad2': e.preventDefault(); this.saveState(2); break;
                case 'Digit3': case 'Numpad3': e.preventDefault(); this.saveState(3); break;
                case 'Digit4': case 'Numpad4': e.preventDefault(); this.loadState(1); break;
                case 'Digit5': case 'Numpad5': e.preventDefault(); this.loadState(2); break;
                case 'Digit6': case 'Numpad6': e.preventDefault(); this.loadState(3); break;
            }
        });
    }

    togglePause() {
        if (!this.frameStepMode) {
            this.paused        = true;
            this.frameStepMode = true;
        } else {
            this.stepNextFrame = true;
        }
        this.updateStatus();
    }

    stepBack() {
        if (!this.frameStepMode) {
            this.paused        = true;
            this.frameStepMode = true;
        }
        this.seekToFrame(this.game.tick - 1);
    }

    resetFPS() {
        const fpsInput = document.getElementById('fpsInput');
        let fps = parseInt(fpsInput.value, 10);
        if (isNaN(fps) || fps <= 0) fps = 30;

        this.applyFPS(fps);
        this.paused        = false;
        this.frameStepMode = false;
        this.stepNextFrame = false;
        this.updateStatus();
        this.cameraOffset = { x: 0, y: 0 };
    }

    restartTAS() {
        this.paused        = false;
        this.frameStepMode = false;
        this.stepNextFrame = false;
        this.cameraOffset  = { x: 0, y: 0 };

        this.seekToFrame(0);
        this.applyFPS(this.currentFPS);

        this.updatePlayerStateDisplay();
        this.updateStatus();
    }

    saveState(slot) {
        if (!this.frameStates || this.frameStates.length === 0) {
            alert('Game not loaded yet — nothing to save.');
            return;
        }
        this.savestates[slot] = this.game.tick;
        console.log(`[TAS] State ${slot} saved at frame ${this.game.tick}`);
    }

    loadState(slot) {
        const tick = this.savestates[slot];
        if (tick === null || tick === undefined) {
            alert('No savestate in slot ' + slot);
            return;
        }
        this.seekToFrame(tick);
    }

    updatePlayerStateDisplay() {
        const state = this.game.playerState;
        if (!state) {
            document.getElementById('playerState').innerHTML =
                '<div class="state-section">Waiting for game to load...</div>';
            return;
        }

        const mainStates = {
            PLAYER_X: state.PLAYER_X,
            PLAYER_Y: state.PLAYER_Y,
            PLAYER_SX: state.PLAYER_SX,
            PLAYER_SY: state.PLAYER_SY,
            is_falling: state.is_falling
        };

        const otherStates = {
            PLAYER_DEATH: state.PLAYER_DEATH,
            PSZ: JSON.stringify(state.PSZ),
            is_jumping: state.is_jumping,
            flipped: state.flipped,
            player_state: state.player_state,
            player_wall: state.player_wall,
            direction: state.direction,
            PLAYER_DIR: state.PLAYER_DIR,
            wasInSpikeTileLastFrame: state.wasInSpikeTileLastFrame,
            friction_dx: state.friction_dx,
            friction_dy: state.friction_dy,
            friction: state.friction,
            PLAYER_NO_SLOW: state.PLAYER_NO_SLOW,
            KEY_LEFT: state.KEY_LEFT,
            KEY_RIGHT: state.KEY_RIGHT,
            KEY_DOWN: state.KEY_DOWN,
            KEY_UP: state.KEY_UP,
            has_key: state.has_key
        };

        let html = '<div class="state-section"><strong style="color:#ffff00">Primary States</strong><br>';
        for (const [k, v] of Object.entries(mainStates)) {
            html += `<span class="state-key">${k}:</span> <span class="state-value">${v}</span><br>`;
        }
        html += '</div><div class="state-section"><strong style="color:#ffff00">Other States</strong><br>';
        for (const [k, v] of Object.entries(otherStates)) {
            html += `<span class="state-key">${k}:</span> <span class="state-value">${v}</span><br>`;
        }
        html += '</div>';

        document.getElementById('playerState').innerHTML = html;
    }

    updateStatus() {
        const status = this.frameStepMode
            ? 'Frame Step'
            : (this.paused ? 'Paused' : 'Playing');

        document.getElementById('statusDisplay').textContent = status;
        document.getElementById('frameCounter').textContent  = this.game.tick;

        const tokenInfo = this.frameTokenMap && this.frameTokenMap[this.game.tick - 1];
        const progressEl = document.getElementById('inputProgress');

        if (tokenInfo) {
            const inToken = (this.game.tick - 1) - tokenInfo.tokenStartFrame + 1;
            progressEl.textContent = `${inToken}/${tokenInfo.tokenDuration}`;
        } else {
            progressEl.textContent = '- / -';
        }

        this.highlightCurrentInput();
    }
}

const params = new URLSearchParams(window.location.search);
let levelCode = params.get('level');
if (!levelCode) {
    levelCode = '1234606196Z2Z588Z1Z37828ZZ1Z38416ZZZZ67Z1e6767';
}

const game = new Game('gameCanvas');
const tasEditor = new TAEditor(game);

document.getElementById('levelCode').value = levelCode;

tasEditor.wrapGameInit();
tasEditor.overrideGetInputKeys();
tasEditor.modifyGameLoop(game);

game.init(levelCode);