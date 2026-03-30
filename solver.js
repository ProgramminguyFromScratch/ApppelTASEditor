class BruteForceSolver {
    constructor() {
        this.running = false;
        this.bestScore = -Infinity;
        this.bestInputs = [];
        this.bestStateSequence = [];
        this.iterations = 0;

        this.depth = 5;
        this.levelData = null;
        this.startState = null;
        this.physics = null;

        this.statePool = [];
        this.inputStack = new Int8Array(100);
        this.pathBuffer = new Uint8Array(100);

        // Per-depth visited sets for duplicate state pruning
        this.visitedAtDepth = [];
    }

    async init(levelCode, playerStateJson) {
        if (!levelCode || !playerStateJson) return;
        this.levelData = LevelRenderer.getDataFromCode(levelCode);
        this.physics = new AppelPhysicsSimple(
            this.levelData.map,
            this.levelData.rotations,
            this.levelData.MAP_DATA,
            this.levelData.size_x
        );

        if (this.physics.touching?.loadPromise) {
            await this.physics.touching.loadPromise;
            this.physics.touching.bakeForLevel(this.physics);
        }

        this.startState = JSON.parse(playerStateJson);
    }

    copyState(src, dest) {
        dest.PLAYER_X              = src.PLAYER_X;
        dest.PLAYER_Y              = src.PLAYER_Y;
        dest.PLAYER_SX             = src.PLAYER_SX;
        dest.PLAYER_SY             = src.PLAYER_SY;
        dest.PLAYER_DEATH          = src.PLAYER_DEATH;
        dest.PLAYER_DIR            = src.PLAYER_DIR;
        dest.is_jumping            = src.is_jumping;
        dest.is_falling            = src.is_falling;
        dest.KEY_UP                = src.KEY_UP;
        dest.flipped               = src.flipped;
        dest.player_state          = src.player_state;
        dest.player_wall           = src.player_wall;
        dest.direction             = src.direction;
        dest.friction_dx           = src.friction_dx;
        dest.friction_dy           = src.friction_dy;
        dest.friction              = src.friction;
        dest.KEY_DOWN              = src.KEY_DOWN;
        dest.KEY_LEFT              = src.KEY_LEFT;
        dest.KEY_RIGHT             = src.KEY_RIGHT;
        dest.PLAYER_NO_SLOW        = src.PLAYER_NO_SLOW;
        dest.has_key               = src.has_key;
        dest.wasInSpikeTileLastFrame = src.wasInSpikeTileLastFrame;
        const sp = src.PSZ, dp = dest.PSZ;
        if (sp && dp) {
            const len = sp.length;
            for (let i = 0; i < len; i++) dp[i] = sp[i];
        }
        if (src?.activeIdx?.length) dest.activeIdx = src.activeIdx.slice(); 
        else dest.activeIdx = [];

        if (src?.activeTyp?.length) dest.activeTyp = src.activeTyp.slice(); 
        else dest.activeTyp = [];

        if (src?.activeFrame?.length) dest.activeFrame = src.activeFrame.slice(); 
        else dest.activeFrame = [];

        dest.activeIdxSpawn = (src.activeIdxSpawn && src.activeIdxSpawn.length) ? src.activeIdxSpawn.slice(): [];
    }

    stateKey(s) {
        let res = s.PLAYER_X + "|" + s.PLAYER_Y + "|" + s.PLAYER_SX + "|" + s.PLAYER_SY + "|" + 
                s.is_falling + "|" + s.is_jumping + "|" + 
                (s.PLAYER_DIR + (s.player_state << 2) + (s.flipped << 6) + (s.KEY_UP << 8));
        
        // Only add activeIdx if needed
        if (s.activeIdx.length > 0) res += "S" + s.activeIdx + s.activeFrame; 
        return res;
    }

    compileKillZone(expr) {
        if (!expr || !expr.trim()) return null;
        try {

            return new Function('s', 'frame', `
                const {
                    PLAYER_X, PLAYER_Y, PLAYER_SX, PLAYER_SY,
                    PLAYER_DEATH, PLAYER_DIR,
                    is_jumping, is_falling,
                    KEY_UP, flipped,
                    player_state, player_wall, direction,
                    last_tick_keys,
                    friction_dx, friction_dy, friction
                } = s;
                return !!(${expr});
            `);
        } catch (e) {
            console.warn('BruteForceSolver: invalid kill-zone expression:', e.message);
            return null;
        }
    }

    compileScoreExpr(expr) {
        if (!expr || !expr.trim()) expr = 'PLAYER_X';
        try {
            return new Function('s', 'frame', `
                const {
                    PLAYER_X, PLAYER_Y, PLAYER_SX, PLAYER_SY,
                    PLAYER_DEATH, PLAYER_DIR,
                    is_jumping, is_falling,
                    KEY_UP, flipped,
                    player_state, player_wall, direction,
                    last_tick_keys,
                    friction_dx, friction_dy, friction
                } = s;
                return (${expr});
            `);
        } catch (e) {
            console.warn('BruteForceSolver: invalid score expression:', e.message);
            return (s) => s.PLAYER_X;
        }
    }

    async solve(depth, goalExpr, goalDir, updateCallback, killZoneExpr, enabledMasks, framePins, comboMaxFrames) {
        if (!this.startState) return;

        this.depth = depth;
        this.running = true;
        this.iterations = 0;
        this.bestScore = -Infinity;

        const allowedMoves = [];
        for (let m = 0; m < 16; m++) {
            if (!enabledMasks || enabledMasks[m]) allowedMoves.push(m);
        }

        const frameAllowedMoves = Array.from({ length: depth + 1 }, (_, i) => {
            const frame = i + 1; // currentDepth i -> frame i+1
            if (framePins && framePins[frame] !== undefined) {
                const pin = framePins[frame];
                if (!pin || typeof pin !== 'object') {
                    // Legacy: raw mask (backward compat)
                    return [pin];
                }
                if (pin.type === 'exact') {
                    // Only this specific combo (if it's enabled)
                    return allowedMoves.includes(pin.mask) ? [pin.mask] : [pin.mask];
                }
                if (pin.type === 'exclude') {
                    // Anything except this exact combo
                    return allowedMoves.filter(m => m !== pin.mask);
                }
                if (pin.type === 'constraint') {
                    // mustSet bits must all be set; mustClear bits must all be clear
                    return allowedMoves.filter(m =>
                        (m & pin.mustSet) === pin.mustSet &&
                        (m & pin.mustClear) === 0
                    );
                }
            }
            return allowedMoves;
        });

        const scoreExpr = this.compileScoreExpr(goalExpr);
        const maximize  = (goalDir !== 'min');

        const killZone = this.compileKillZone(killZoneExpr);

        
        this.statePool = Array.from({ length: depth + 1 }, () =>
            structuredClone(this.startState)
        );

        this.visitedAtDepth = Array.from({ length: depth + 1 }, () => new Set());

        this.copyState(this.startState, this.statePool[0]);
        let currentDepth = 0;
        this.inputStack.fill(-1);
        this.pathBuffer.fill(255);

        this.visitedAtDepth[0].add(this.stateKey(this.statePool[0]));

        const countsAtDepth = Array.from({ length: depth + 2 }, () => new Int32Array(16));

        // You might want to change this depending on how fast your computer is
        const CHUNK_SIZE = 100000;

        const processChunk = () => {
            if (!this.running) return;

            for (let ci = 0; ci < CHUNK_SIZE; ci++) {
                this.inputStack[currentDepth]++;

                const movesHere = frameAllowedMoves[currentDepth];
                if (this.inputStack[currentDepth] >= movesHere.length) {
                    currentDepth--;
                    if (currentDepth < 0) {
                        this.running = false;
                        updateCallback({ done: true, iterations: this.iterations });
                        return;
                    }
                    continue;
                }

                const move = movesHere[this.inputStack[currentDepth]];

                if (comboMaxFrames && comboMaxFrames[move] !== null && comboMaxFrames[move] !== undefined) {
                    if (countsAtDepth[currentDepth][move] >= comboMaxFrames[move]) continue;
                }

                const prevState = this.statePool[currentDepth];
                const nextState = this.statePool[currentDepth + 1];

                this.copyState(prevState, nextState);

                this.physics.tick(nextState, move);
                
                this.pathBuffer[currentDepth] = move;

                if (nextState.PLAYER_DEATH) {
                    continue;
                }

                if (killZone && killZone(nextState, currentDepth + 1)) {
                    continue;
                }

                const nextDepth = currentDepth + 1;

                if (nextDepth === this.depth) {
                    this.iterations++;

                    const rawScore = scoreExpr(nextState, nextDepth);
                    const score    = maximize ? rawScore : -rawScore;

                    if (score > this.bestScore) {
                        this.bestScore = score;
                        this.bestInputs = Array.from(this.pathBuffer.slice(0, this.depth));

                        this.bestStateSequence = this.statePool.slice(0, this.depth + 1).map(s => ({
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
                            last_tick_keys: s.last_tick_keys,
                            friction: s.friction,
                            friction_dx: s.friction_dx,
                            friction_dy: s.friction_dy,
                            wasInSpikeTileLastFrame: s.wasInSpikeTileLastFrame,
                            PSZ: s.PSZ ? [...s.PSZ] : null,
                        }));

                        updateCallback({
                            foundNew:   true,
                            score:      rawScore,
                            inputs:     this.bestInputs,
                            states:     this.bestStateSequence,
                            iterations: this.iterations
                        });
                    }
                } else {
                    const key = this.stateKey(nextState);
                    const visited = this.visitedAtDepth[nextDepth];
                    if (visited.has(key)) {
                        continue;
                    }
                    visited.add(key);

                    countsAtDepth[nextDepth].set(countsAtDepth[currentDepth]);
                    countsAtDepth[nextDepth][move]++;

                    currentDepth++;
                    this.inputStack[currentDepth] = -1;
                }
            }

            updateCallback({ iterations: this.iterations });
            setTimeout(processChunk, 0);
        };

        processChunk();
    }

    stop() { this.running = false; }
}

function inputsToString(inputs) {
    if (!inputs || !inputs.length) return "-";
    return inputs.map(mask => {
        let s = "";
        if (mask & 8) s += "W";
        if (mask & 2) s += "A";
        if (mask & 4) s += "S";
        if (mask & 1) s += "D";
        return s || "-";
    }).join(", ");
}
/**
 * Convert an array of input masks to the TAS input-editor format,
 * run-length encoding consecutive identical inputs.
 * e.g. [9, 9, 1, 0, 0, 2] -> "WD2 D _2 A"  (no-key runs use _)
 */
function inputsToTASFormat(inputs) {
    if (!inputs || !inputs.length) return "";
    const tokens = [];
    let i = 0;
    while (i < inputs.length) {
        const mask = inputs[i];
        let count = 1;
        while (i + count < inputs.length && inputs[i + count] === mask) count++;
        let keys = "";
        if (mask & 8) keys += "W";
        if (mask & 2) keys += "A";
        if (mask & 4) keys += "S";
        if (mask & 1) keys += "D";
        if (!keys) keys = "_";
        tokens.push(count === 1 ? keys : keys + count);
        i += count;
    }
    return tokens.join(" ");
}