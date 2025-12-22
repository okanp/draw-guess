import { WebSocket } from "ws";
import { v4 as uuidv4 } from "uuid";

interface Player {
    id: string;
    name: string;
    avatar: string;
    score: number;
    turnScore: number; // Points earned in the current turn
    ws: WebSocket | null;
    isModerator: boolean;
    reconnectionTimeout?: NodeJS.Timeout;
}

export class Room {
    id: string;
    language: "English" | "Turkish";
    turnDuration: number;
    players = new Map<string, Player>();
    gameState: "waiting" | "playing" | "turn_summary" | "game_over" | "between_turns" = "waiting";
    totalRounds = 0;
    currentRound = 0;

    private words = {
        English: ["apple", "banana", "car", "dog", "cat", "house", "tree", "sun", "moon", "star", "computer", "keyboard"],
        Turkish: ["elma", "muz", "araba", "köpek", "kedi", "ev", "ağaç", "güneş", "ay", "yıldız", "bilgisayar", "klavye"],
    };
    private currentWord = "";
    private hintWord = "";
    private revealedIndices = new Set<number>();
    private isUnderscoreHintShown = false;
    private drawingPlayerId: string | null = null;
    private correctGuessers = new Set<string>();
    
    private turnTimeout: NodeJS.Timeout | null = null;
    private turnTimerInterval: NodeJS.Timeout | null = null;
    private hintTimeouts: NodeJS.Timeout[] = [];
    private onEmpty: () => void;

    constructor(id: string, language: "English" | "Turkish", turnDuration: number, onEmpty: () => void) {
        this.id = id;
        this.language = language;
        this.turnDuration = turnDuration;
        this.onEmpty = onEmpty;
    }

    addPlayer(ws: WebSocket, name: string, avatar: string): Player {
        const playerId = uuidv4();
        const isFirstPlayer = this.players.size === 0;
        const player: Player = { id: playerId, name, avatar, score: 0, turnScore: 0, ws, isModerator: isFirstPlayer };

        this.players.set(playerId, player);
        ws.on("message", (message) => this.handleMessage(ws, playerId, message));
        ws.on("close", () => this.disconnectPlayer(playerId));

        this.broadcastPlayerList();
        this.broadcastGameState();
        return player;
    }

    reconnectPlayer(ws: WebSocket, playerId: string): Player | null {
        const player = this.players.get(playerId);
        if (player && !player.ws) {
            if (player.reconnectionTimeout) clearTimeout(player.reconnectionTimeout);
            player.reconnectionTimeout = undefined;
            player.ws = ws;

            ws.on("message", (message) => this.handleMessage(ws, playerId, message));
            ws.on("close", () => this.disconnectPlayer(playerId));

            this.broadcast({ type: "CHAT", payload: { name: "System", message: `${player.name} has reconnected.` } });
            this.broadcastPlayerList();
            this.broadcastGameState();
            if (this.gameState === 'playing' && this.isUnderscoreHintShown) {
                ws.send(JSON.stringify({ type: "HINT_REVEALED", payload: { hint: this.hintWord } }));
            }
            return player;
        }
        return null;
    }

    private disconnectPlayer(playerId: string) {
        const player = this.players.get(playerId);
        if (!player) return;

        player.ws = null;
        this.broadcast({ type: "CHAT", payload: { name: "System", message: `${player.name} has disconnected.` } });
        this.broadcastPlayerList();

        if (playerId === this.drawingPlayerId && this.gameState === 'playing') {
            this.broadcast({ type: "CHAT", payload: { name: "System", message: `${player.name} (the drawer) has disconnected. Ending turn.` } });
            this.showTurnSummary();
        }

        if (player.reconnectionTimeout) clearTimeout(player.reconnectionTimeout);
        player.reconnectionTimeout = setTimeout(() => {
            this.removePlayer(playerId);
        }, 60000);
    }

    private removePlayer(playerId: string) {
        const player = this.players.get(playerId);
        if (!player || player.ws) return;

        this.players.delete(playerId);
        this.broadcast({ type: "PLAYER_LEFT", payload: { name: player.name } });
        this.broadcastPlayerList();

        if (player.isModerator) this.assignNewModerator();

        if (this.players.size === 0) {
            this.clearAllTimers();
            this.onEmpty();
            return;
        }

        if (this.getActivePlayers().length < 2 && this.gameState === "playing") {
            this.endGame("Not enough players to continue.");
        }
        this.broadcastGameState();
    }

    private assignNewModerator() {
        const nextModerator = this.getActivePlayers()[0];
        if (nextModerator) {
            nextModerator.isModerator = true;
            nextModerator.ws?.send(JSON.stringify({ type: "SET_MODERATOR", payload: { isModerator: true } }));
        }
    }

    private handleMessage(ws: WebSocket, playerId: string, message: any) {
        const player = this.players.get(playerId);
        if (!player) return;
        const data = JSON.parse(message);

        switch (data.type) {
            case "START_GAME":
                if (player.isModerator) this.restartGame();
                break;
            case "CHAT":
                this.handleChat(player, data.payload);
                break;
            case "DRAW":
                if (playerId === this.drawingPlayerId) this.handleDraw(data.payload, ws);
                break;
        }
    }

    private restartGame() {
        if (this.getActivePlayers().length < 2) {
            this.endGame("Not enough players to start.");
            return;
        }
        if (this.gameState === "playing") return;

        this.gameState = "playing";
        this.totalRounds = this.getActivePlayers().length;
        this.currentRound = 0;
        this.players.forEach(p => p.score = 0);
        this.broadcastPlayerList();
        this.broadcast({ type: "GAME_STARTED" });
        this.startNextTurn();
    }

    private handleChat(player: Player, message: string) {
        if (player.id === this.drawingPlayerId || this.correctGuessers.has(player.id)) {
            this.broadcast({ type: "CHAT", payload: { name: player.name, message } });
            return;
        }

        if (this.gameState === "playing" && this.currentWord && message.toLowerCase() === this.currentWord.toLowerCase()) {
            const drawer = this.players.get(this.drawingPlayerId!);
            const activePlayersCount = this.getActivePlayers().length;

            const points = activePlayersCount - this.correctGuessers.size;
            player.score += points;
            player.turnScore = points;

            if (drawer) {
                const drawerPoints = this.correctGuessers.size === 0 ? activePlayersCount : 1;
                drawer.score += drawerPoints;
                drawer.turnScore += drawerPoints;
            }
            
            this.correctGuessers.add(player.id);
            this.broadcast({ type: "CORRECT_GUESS", payload: { name: player.name, myId: player.id } });
            this.broadcastPlayerList();

            if (this.correctGuessers.size >= activePlayersCount - 1) {
                this.showTurnSummary();
            }
        } else {
            this.broadcast({ type: "CHAT", payload: { name: player.name, message } });
        }
    }

    private handleDraw(data: any, excludeWs: WebSocket) {
        this.broadcast({ type: "DRAW", payload: data }, excludeWs);
    }

    private showTurnSummary() {
        this.clearAllTimers();
        this.gameState = "turn_summary";
        this.broadcastGameState();

        const turnScores = this.getPlayersInfo().map(p => ({ name: p.name, turnScore: this.players.get(p.id)?.turnScore || 0 }));

        this.broadcast({
            type: "TURN_SUMMARY",
            payload: {
                word: this.currentWord,
                scores: turnScores,
            }
        });

        this.turnTimeout = setTimeout(() => this.startNextTurn(), 5000);
    }

    private startNextTurn() {
        this.clearAllTimers();
        this.broadcast({ type: "CLEAR_BOARD" });
        this.players.forEach(p => p.turnScore = 0);
        this.isUnderscoreHintShown = false;

        this.currentRound++;
        if (this.currentRound > this.totalRounds) {
            this.endGame();
            return;
        }

        const activePlayers = this.getActivePlayers();
        if (activePlayers.length < 2) {
            this.endGame("Not enough players to continue.");
            return;
        }

        this.gameState = "between_turns";
        this.correctGuessers.clear();
        const currentIndex = this.drawingPlayerId ? activePlayers.findIndex(p => p.id === this.drawingPlayerId) : -1;
        const nextDrawer = activePlayers[(currentIndex + 1) % activePlayers.length];
        this.drawingPlayerId = nextDrawer.id;

        const wordList = this.words[this.language];
        this.currentWord = wordList[Math.floor(Math.random() * wordList.length)];
        this.revealedIndices.clear();
        this.hintWord = this.currentWord.replace(/[a-zA-Z]/g, "_");

        this.broadcastGameState();
        this.broadcast({ type: "TURN_PREVIEW", payload: { drawerName: nextDrawer.name, duration: 5 } });

        this.turnTimeout = setTimeout(() => this.beginDrawingPhase(), 5000);
    }

    private beginDrawingPhase() {
        this.gameState = "playing";
        this.broadcastGameState();

        const drawer = this.players.get(this.drawingPlayerId!);
        drawer?.ws?.send(JSON.stringify({ type: "YOUR_TURN", payload: { word: this.currentWord } }));

        const underscoreHintDelay = this.turnDuration * (1 - 0.4) * 1000;
        this.hintTimeouts.push(setTimeout(() => {
            this.isUnderscoreHintShown = true;
            this.broadcast({ type: "HINT_REVEALED", payload: { hint: this.hintWord } });
        }, underscoreHintDelay));

        const letterHintPercentages = this.currentWord.length > 4 ? [0.3, 0.2, 0.1] : [0.2];
        letterHintPercentages.forEach(percent => {
            const delay = this.turnDuration * (1 - percent) * 1000;
            this.hintTimeouts.push(setTimeout(() => this.revealHint(), delay));
        });

        let timeLeft = this.turnDuration;
        this.broadcast({ type: "TIMER_TICK", payload: { timeLeft } });
        this.turnTimerInterval = setInterval(() => {
            timeLeft--;
            this.broadcast({ type: "TIMER_TICK", payload: { timeLeft } });
        }, 1000);

        this.turnTimeout = setTimeout(() => this.showTurnSummary(), this.turnDuration * 1000);
    }

    private revealHint() {
        if (!this.isUnderscoreHintShown) {
            this.isUnderscoreHintShown = true;
            this.broadcast({ type: "HINT_REVEALED", payload: { hint: this.hintWord } });
        }

        const unrevealed = [...Array(this.currentWord.length).keys()].filter(i => !this.revealedIndices.has(i) && this.currentWord[i] !== ' ');
        if (unrevealed.length === 0) return;

        const randomIndex = unrevealed[Math.floor(Math.random() * unrevealed.length)];
        this.revealedIndices.add(randomIndex);

        let newHint = "";
        for (let i = 0; i < this.currentWord.length; i++) {
            newHint += this.revealedIndices.has(i) ? this.currentWord[i] : "_";
        }
        this.hintWord = newHint;
        this.broadcast({ type: "HINT_REVEALED", payload: { hint: this.hintWord } });
    }

    private endGame(reason: string = "All rounds completed!") {
        this.clearAllTimers();
        this.gameState = "game_over";
        this.broadcastGameState();
        
        const finalScores = this.getPlayersInfo().sort((a, b) => b.score - a.score);
        const restartDelay = 10;
        this.broadcast({ type: "GAME_OVER", payload: { reason, finalScores, restartDelay } });

        this.turnTimeout = setTimeout(() => this.restartGame(), restartDelay * 1000);
    }

    private clearAllTimers() {
        if (this.turnTimeout) clearTimeout(this.turnTimeout);
        if (this.turnTimerInterval) clearInterval(this.turnTimerInterval);
        this.hintTimeouts.forEach(t => clearTimeout(t));
        this.turnTimeout = null;
        this.turnTimerInterval = null;
        this.hintTimeouts = [];
    }

    private broadcast(message: any, excludeWs?: WebSocket) {
        const data = JSON.stringify(message);
        this.getActivePlayers().forEach(p => {
            if (p.ws && p.ws !== excludeWs) p.ws.send(data);
        });
    }

    private broadcastPlayerList() {
        this.broadcast({ type: "UPDATE_PLAYER_LIST", payload: { players: this.getPlayersInfo() } });
    }

    private broadcastGameState() {
        const moderator = Array.from(this.players.values()).find(p => p.isModerator);
        const drawer = this.drawingPlayerId ? this.players.get(this.drawingPlayerId) : null;
        const payload = {
            gameState: this.gameState,
            playerCount: this.getActivePlayers().length,
            moderatorName: moderator?.name || null,
            currentRound: this.currentRound,
            totalRounds: this.totalRounds,
            drawerName: drawer?.name || null,
        };
        this.broadcast({ type: "GAME_STATE_UPDATE", payload });
    }

    public getActivePlayers(): Player[] {
        return Array.from(this.players.values()).filter(p => p.ws);
    }

    getPlayersInfo() {
        return Array.from(this.players.values()).map(({ id, name, avatar, score, ws, isModerator }) => ({
            id, name, avatar: avatar || '1', score, isModerator, isConnected: !!ws,
        }));
    }

    getInfo() {
        return {
            id: this.id,
            language: this.language,
            playerCount: this.getActivePlayers().length,
            turnDuration: this.turnDuration,
        };
    }
}
