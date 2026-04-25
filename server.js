const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

app.use(express.static('public'));

const activeSessions = new Map(); 
const disconnectTimeouts = new Map();

function updateReaderCount(roomCode) {
    const clients = io.sockets.adapter.rooms.get(roomCode);
    const count = clients ? clients.size - 1 : 0;
    io.to(roomCode).emit('reader-count', Math.max(0, count));
}

io.on('connection', (socket) => {
    socket.on('client-error', (errorInfo) => {
        console.error(`🔴 [BROWSER FEILUR] Frá ${socket.id}:`, JSON.stringify(errorInfo, null, 2));
    });

    socket.on('create-session', (roomCode) => {
        if (activeSessions.has(roomCode)) {
            socket.emit('session-error', 'Henda sessiónskotan er longu í brúk.');
        } else {
            activeSessions.set(roomCode, socket.id);
            socket.join(roomCode);
            socket.emit('session-created', roomCode);
        }
    });

    socket.on('join-session', (roomCode) => {
        if (activeSessions.has(roomCode)) {
            socket.join(roomCode);
            socket.emit('session-joined', roomCode);
            updateReaderCount(roomCode);
        } else {
            socket.emit('session-error', 'Sessiónin finst ikki.');
        }
    });

    socket.on('reclaim-session', (roomCode) => {
        if (activeSessions.has(roomCode)) {
            activeSessions.set(roomCode, socket.id);
            socket.join(roomCode);
            if (disconnectTimeouts.has(roomCode)) {
                clearTimeout(disconnectTimeouts.get(roomCode));
                disconnectTimeouts.delete(roomCode);
            }
            updateReaderCount(roomCode);
        }
    });

    socket.on('text-delta', ({ roomCode, delta }) => {
        if (activeSessions.get(roomCode) === socket.id) {
            socket.to(roomCode).emit('text-delta', delta);
        }
    });

    socket.on('text-reset', ({ roomCode }) => {
        if (activeSessions.get(roomCode) === socket.id) {
            socket.to(roomCode).emit('text-reset');
        }
    });

    socket.on('stop-session', (roomCode) => {
        if (activeSessions.get(roomCode) === socket.id) {
            io.to(roomCode).emit('session-ended');
            activeSessions.delete(roomCode);
        }
    });

    socket.on('disconnecting', () => {
        for (const roomCode of socket.rooms) {
            if (activeSessions.has(roomCode)) {
                setTimeout(() => updateReaderCount(roomCode), 100);
            }
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