const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

io.on('connection', (socket) => {
    // US2: Join room baserað á sessiónskotu
    socket.on('join-session', (roomCode) => {
        socket.join(roomCode);
        console.log(`Brúkari fór inn í sessión: ${roomCode}`);
    });

    // US1: Stream tekst til øll í rúminum
    socket.on('text-update', ({ roomCode, text }) => {
        socket.to(roomCode).emit('text-receive', text);
    });

    // US7: Steðga sessión
    socket.on('stop-session', (roomCode) => {
        io.to(roomCode).emit('session-ended');
        console.log(`Sessión ${roomCode} endað`);
    });
});

const PORT = 3000;
server.listen(PORT, () => {
    console.log(`Server koyrir á http://localhost:${PORT}`);
});