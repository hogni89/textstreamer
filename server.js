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

const activeSessions = new Map(); // roomCode -> socket.id hjá skribenti
const disconnectTimeouts = new Map(); // roomCode -> timeout-ID

/**
 * Sendir dagført tal av lesarum til øll í rúminum.
 * Skribenturin verður drigin frá, so vit bara telja tey, ið lurta/lesa.
 */
function updateReaderCount(roomCode) {
    const clients = io.sockets.adapter.rooms.get(roomCode);
    const count = clients ? clients.size - 1 : 0;
    io.to(roomCode).emit('reader-count', Math.max(0, count));
}

io.on('connection', (socket) => {
    
    // Logga feilir frá browserum til Render Logs fyri betri feilfinning
    socket.on('client-error', (errorInfo) => {
        console.error(`🔴 [BROWSER FEILUR] Frá ${socket.id}:`, JSON.stringify(errorInfo, null, 2));
    });

    // Skribentur stovnar nýggja sessión
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

    // Lesari kemur inn í sessión
    socket.on('join-session', (roomCode) => {
        if (activeSessions.has(roomCode)) {
            socket.join(roomCode);
            socket.emit('session-joined', roomCode);
            updateReaderCount(roomCode);
        } else {
            socket.emit('session-error', 'Sessiónin finst ikki.');
        }
    });

    // Skribentur reclaim'ar sína sessión (t.d. um iPhone fer í sleep ella netið hoppar)
    socket.on('reclaim-session', (roomCode) => {
        if (activeSessions.has(roomCode)) {
            activeSessions.set(roomCode, socket.id);
            socket.join(roomCode);
            if (disconnectTimeouts.has(roomCode)) {
                clearTimeout(disconnectTimeouts.get(roomCode));
                disconnectTimeouts.delete(roomCode);
                console.log(`Skribentur reclaimaði sessión: ${roomCode}`);
            }
            updateReaderCount(roomCode);
        }
    });

    // Delta sending: Sendir bara nýggja tekstbrotin víðari til lesararnar
    socket.on('text-delta', ({ roomCode, delta }) => {
        if (activeSessions.get(roomCode) === socket.id) {
            socket.to(roomCode).emit('text-delta', delta);
        }
    });

    // Reinsa skermin hjá lesarum (um skribenturin slettar alt í textarea)
    socket.on('text-reset', ({ roomCode }) => {
        if (activeSessions.get(roomCode) === socket.id) {
            socket.to(roomCode).emit('text-reset');
        }
    });

    // Skribenturin endar sessiónina manuelt
    socket.on('stop-session', (roomCode) => {
        if (activeSessions.get(roomCode) === socket.id) {
            io.to(roomCode).emit('session-ended');
            activeSessions.delete(roomCode);
            console.log(`Sessión endað manuelt: ${roomCode}`);
        }
    });

    // Uppdatera lesara-teljaran tá onkur fer út
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
                // Skribenturin misti sambandið - vit bíða í 60 sek áðrenn vit sletta alt,
                // so hann hevur kjans at reclaim'a (t.d. við reclaim-session).
                const timeout = setTimeout(() => {
                    io.to(roomCode).emit('session-ended');
                    activeSessions.delete(roomCode);
                    disconnectTimeouts.delete(roomCode);
                    console.log(`Sessión rundað av eftir timeout: ${roomCode}`);
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