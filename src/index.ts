import express from "express";
import { WebSocketServer } from "ws";
import { Room } from "./Room";
import { v4 as uuidv4 } from "uuid";
import { parse } from "url";

const app = express();
app.use(express.json());
app.use(express.static("public"));

const port = Number(process.env.PORT) || 3000;
const server = app.listen(port, () => console.log(`http://localhost:${port}`));

const rooms = new Map<string, Room>();

// Health check endpoint
app.get("/health", (req, res) => {
    res.status(200).send("OK");
});

app.get("/api/rooms", (req, res) => {
    const roomList = Array.from(rooms.values()).map(room => room.getInfo());
    res.json(roomList);
});

app.post("/api/rooms", (req, res) => {
    const { language, turnDuration = 30 } = req.body;
    if (language !== "English" && language !== "Turkish") {
        return res.status(400).json({ error: "Invalid language" });
    }
    if (typeof turnDuration !== 'number' || turnDuration < 10 || turnDuration > 120) {
        return res.status(400).json({ error: "Invalid turn duration (must be 10-120 seconds)." });
    }

    const id = uuidv4();
    const room = new Room(id, language, turnDuration, () => {
        rooms.delete(id);
        console.log(`Room ${id} deleted.`);
    });
    rooms.set(id, room);
    res.json(room.getInfo());
});

app.post("/api/find-room", (req, res) => {
    const { language } = req.body;
    
    for (const room of rooms.values()) {
        if (room.language === language && room.getActivePlayers().length < 10 && room.gameState === 'waiting') {
            return res.json({ roomId: room.id });
        }
    }

    const id = uuidv4();
    const turnDuration = 60;
    const newRoom = new Room(id, language, turnDuration, () => {
        rooms.delete(id);
        console.log(`Room ${id} created automatically.`);
    });
    rooms.set(id, newRoom);
    res.json({ roomId: newRoom.id });
});


const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (request, socket, head) => {
    const { pathname, query } = parse(request.url!, true);
    const roomId = pathname?.split("/").pop();

    if (!roomId || !rooms.has(roomId)) {
        socket.destroy();
        return;
    }

    const room = rooms.get(roomId)!;

    wss.handleUpgrade(request, socket, head, (ws) => {
        const { name, playerId, avatar } = query;

        if (typeof playerId === 'string' && room.reconnectPlayer(ws, playerId)) {
            const player = room.players.get(playerId)!;
            ws.send(JSON.stringify({
                type: "RECONNECT_SUCCESS",
                payload: {
                    playerId: player.id,
                    name: player.name,
                    avatar: player.avatar || '1', // Ensure avatar exists
                    isModerator: player.isModerator,
                    players: room.getPlayersInfo(),
                    gameState: room.gameState,
                }
            }));
        } else if (typeof name === 'string' && typeof avatar === 'string') {
            const player = room.addPlayer(ws, name, avatar);
            ws.send(JSON.stringify({
                type: "CONNECT_SUCCESS",
                payload: {
                    playerId: player.id,
                    name: player.name,
                    avatar: player.avatar,
                    isModerator: player.isModerator,
                }
            }));
        } else {
            ws.close(1008, "Name, avatar, or playerId is required");
        }
    });
});
