class Game {
    constructor(canvasId) {
        this.canvas = document.getElementById(canvasId);
        this.ctx = this.canvas.getContext('2d');
        
        this.canvas.width = 960;
        this.canvas.height = 540;

        this.renderer = new LevelRenderer(this.canvas);
        this.levelData = null;
        this.physics = null;
        this.playerState = null;
        
        this.camera = { x: 0, y: 0, zoom: 1.25};
        this.keys = {};
        this.tick = 0;
        this.gameState = "LOADING";

        this.profiler = new PerformanceMonitor();

        this.assetsLoadedCount = 0;
        this.totalAssets = 201; // 172 tiles + 2 player + 1 bg + 1 json + 24 wall + 1 dynamic

        if (typeof replayCode !== 'undefined' && replayCode) {
            this.decodedReplayCode = decodeReplayCode(replayCode);
        }

        window.addEventListener('keydown', e => {
            this.keys[e.code] = true;
        });
        window.addEventListener('keyup', e => {
            this.keys[e.code] = false;
        });
    }

    init(levelCode) {
        this.levelData = LevelRenderer.getDataFromCode(levelCode);
        
        this.physics = new AppelPhysics(
            this.levelData.map, 
            this.levelData.rotations,
            this.levelData.MAP_DATA,
            this.levelData.size_x
        );
        
        this.playerState = this.physics.createDefaultGameState(this.physics.spawnOBJ(this.levelData));

        // this.physics.tickObj(this.playerState);
        
        if (this.physics.touching && this.physics.touching.loadPromise) {
            this.physics.touching.loadPromise.then(() => {
                this.assetsLoadedCount++;
            });
        } else {
            this.assetsLoadedCount++;
        }

        this.renderer.loadAssets(() => {
            this.assetsLoadedCount++;
        });

        const fps = 30;
        const frameDuration = 1000 / fps;
        let lastFrameTime = performance.now(); 

        setInterval(() => {
            const now = performance.now();
            const delta = now - lastFrameTime;
            if (delta >= frameDuration - 1) {
                lastFrameTime = now;

                if (this.gameState === "LOADING") {
                    this.checkLoadStatus();
                    this.drawLoadingScreen();
                } else {
                    this.gameLoop();
                }
            }
        }, 1);
    }

    checkLoadStatus() {
        if (this.assetsLoadedCount >= this.totalAssets) {
            this.gameState = "PLAY";
            console.log("All assets loaded. Starting game.");
        }
    }

    drawLoadingScreen() {
        this.ctx.fillStyle = "#111";
        this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

        const width = 300;
        const height = 20;
        const x = (this.canvas.width - width) / 2;
        const y = (this.canvas.height - height) / 2;
        
        const progress = Math.min(1, this.assetsLoadedCount / this.totalAssets);

        // Draw Border
        this.ctx.strokeStyle = "#FFF";
        this.ctx.lineWidth = 2;
        this.ctx.strokeRect(x, y, width, height);

        // Draw Bar
        this.ctx.fillStyle = "#0077ff";
        this.ctx.fillRect(x + 2, y + 2, (width - 4) * progress, height - 4);

        // Draw Text
        this.ctx.fillStyle = "#FFF";
        this.ctx.font = "16px Arial";
        this.ctx.textAlign = "center";
        this.ctx.fillText(`Loading... ${Math.floor(progress * 100)}%`, this.canvas.width / 2, y - 10);
    }

    getInputKeys() {
        if (this.gameState === "WIN") {return ""}
        let keys = '';


        if (this.decodedReplayCode) {
            keys = this.decodedReplayCode[this.tick];
        }
        
        if (this.keys['KeyD'] || this.keys['ArrowRight'] || this.keys['KeyL']) {
            keys += 'D';
        }
        if (this.keys['KeyA'] || this.keys['ArrowLeft'] || this.keys['KeyJ']) {
            keys += 'A';
        }
        if (this.keys['KeyS'] || this.keys['ArrowDown'] || this.keys['KeyK']) {
            keys += 'S';
        }
        if (this.keys['KeyW'] || this.keys['ArrowUp'] || this.keys['KeyI']) {
            keys += 'W';
        }
        
        return keys;
    }

    update() {
        if (!this.physics || !this.playerState) return;
        
        const inputKeys = this.getInputKeys();
        
        this.playerState = this.physics.tick(this.playerState, inputKeys);
        
        const targetCameraX = this.playerState.PLAYER_X
        const targetCameraY = this.playerState.PLAYER_Y;
        
        this.camera.x += (targetCameraX - this.camera.x) * 0.2;
        this.camera.y += ((targetCameraY - this.camera.y) + 8) * 0.2;

        if (this.playerState.PLAYER_DEATH) {
            console.log("Player died!");
            this.playerState = this.physics.createDefaultGameState(this.playerState.OBJ);
        }
        
        if (this.physics.isFlagAt(this.playerState.PLAYER_X, this.playerState.PLAYER_Y)) {
            console.log("Player won!");
            this.gameState = "WIN";
        }
    }

    drawEntities() {
        if (!this.playerState) return;
        
        const playerPos = {
            x: this.playerState.PLAYER_X,
            y: this.playerState.PLAYER_Y,
            angle: this.playerState.direction,
            crouched: this.playerState.player_state === 2,
            onWall: this.playerState.player_wall != null,
            dir: this.playerState.PLAYER_DIR
        };
        
        this.renderer.renderPlayer(playerPos, this.camera);
        this.renderer.renderDynamic(this.playerState.OBJ, this.camera);
    }

    debugKillZones() {
        const step = 2; // Increased step to 4 to prevent severe frame drops
        this.ctx.fillStyle = "rgba(255, 0, 0, 0.5)";

        for (let x = 0; x < this.canvas.width; x += step) {
            for (let y = 0; y < this.canvas.height; y += step) {
                // 1. Correctly reverse the renderer's Camera Zoom and Translation
                const worldX = (x - this.canvas.width / 2) / this.camera.zoom + this.camera.x;
                const worldY = this.camera.y - (y - this.canvas.height / 2) / this.camera.zoom;

                // 2. Calculate the 1D map array index (Appel tiles are 60x60)
                const tx = Math.floor(worldX / 60);
                const ty = Math.floor(worldY / 60);
                const idx = tx + ty * this.physics.LSX;

                // 3. Prevent checking out-of-bounds map data
                if (idx >= 0 && idx < this.physics.MAP.length) {
                    
                    // Pass the corrected world coordinates (worldY is no longer negated)
                    if (this.physics.touching.is_pixel_on_spike(worldX, worldY, this.physics) ||
                        this.physics.touching.is_pixel_on_player(worldX, worldY, this.playerState)) {
                        
                        // Draw exactly at the screen pixel we are sampling
                        this.ctx.fillRect(x, y, step, step);
                    }
                }
            }
        }
    }

    gameLoop() {
        this.profiler.start('Total Frame');
        this.profiler.tick();

        this.profiler.start('Physics');
        this.update();
        this.profiler.end('Physics');

        if (this.levelData) {
            this.profiler.start('Render: Level');
            this.renderer.render(this.levelData, this.camera);
            this.profiler.end('Render: Level');
        }

        this.profiler.start('Render: Player');
        this.drawEntities();
        this.profiler.end('Render: Player');

        this.tick += 1;

        this.debugKillZones()

        this.profiler.draw(this.ctx);

        this.profiler.end('Total Frame');
    }
}