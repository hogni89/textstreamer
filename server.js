const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

app.use(express.static('public'));

const activeSessions = new Map(); 
const disconnectTimeouts = new Map();

io.on('connection', (socket) => {
    
    // NÝTT: Lurtar eftir feilum frá browserinum og loggar teir í Render
    socket.on('client-error', (errorInfo) => {
        console.error(`🔴 [BROWSER FEILUR] Frá ${socket.id}:`, JSON.stringify(errorInfo, null, 2));
    });

    // US2: Skribentur stovnar sessión
    socket.on('create-session', (roomCode) => {
        if (activeSessions.has(roomCode)) {
            socket.emit('session-error', 'Henda sessiónskotan er longu í brúk.');
        } else {
            activeSessions.set(roomCode, socket.id);
            socket.join(roomCode);
            socket.emit('session-created', roomCode);
            console.log(`Sessión stovnað: ${roomCode}`);
        }
    });

    // US3: Lesari kemur inn
    socket.on('join-session', (roomCode) => {
        if (activeSessions.has(roomCode)) {
            socket.join(roomCode);
            socket.emit('session-joined', roomCode);
        } else {
            socket.emit('session-error', 'Sessiónin finst ikki. Bíða eftir skribentinum.');
        }
    });

    // Reclaim session (iOS fix)
    socket.on('reclaim-session', (roomCode) => {
        if (activeSessions.has(roomCode)) {
            activeSessions.set(roomCode, socket.id);
            if (disconnectTimeouts.has(roomCode)) {
                clearTimeout(disconnectTimeouts.get(roomCode));
                disconnectTimeouts.delete(roomCode);
                console.log(`Skribentur kom aftur: ${roomCode}`);
            }
        }
    });

    // US1: Stream tekstur
    socket.on('text-update', ({ roomCode, text }) => {
        if (activeSessions.get(roomCode) === socket.id) {
            socket.to(roomCode).emit('text-receive', text);
        }
    });

    // US7: Steðga sessión
    socket.on('stop-session', (roomCode) => {
        if (activeSessions.get(roomCode) === socket.id) {
            io.to(roomCode).emit('session-ended');
            activeSessions.delete(roomCode);
        }
    });

    socket.on('disconnect', () => {
        for (let [roomCode, ownerId] of activeSessions.entries()) {
            if (ownerId === socket.id) {
                const timeout = setTimeout(() => {
                    io.to(roomCode).emit('session-ended');
                    activeSessions.delete(roomCode);
                    disconnectTimeouts.delete(roomCode);
                }, 60000);
                disconnectTimeouts.set(roomCode, timeout);
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Serverin koyrir á portur ${PORT}`);
});