const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

// Her goyma vit yvirlit yvir virknar sessiónir og hvør eigur tær
const activeSessions = new Map(); 

io.on('connection', (socket) => {
    
    // US2: Stovna sessión (bara fyri skribentar)
    socket.on('create-session', (roomCode) => {
        if (activeSessions.has(roomCode)) {
            // Kotan er upptikin
            socket.emit('session-error', 'Henda sessiónskotan er longu í brúk. Vinarliga vel eina aðra.');
        } else {
            activeSessions.set(roomCode, socket.id); // Bind kotuna til socket ID hjá skribentinum
            socket.join(roomCode);
            socket.emit('session-created', roomCode);
            console.log(`Sessión stovnað: ${roomCode}`);
        }
    });

    // US3: Join sessión (fyri lesarar)
    socket.on('join-session', (roomCode) => {
        if (activeSessions.has(roomCode)) {
            socket.join(roomCode);
            socket.emit('session-joined', roomCode);
        } else {
            socket.emit('session-error', 'Sessiónin varð ikki funnin. Bíða til skribenturin hevur stovnað hana.');
        }
    });

    // US1: Stream tekstur
    socket.on('text-update', ({ roomCode, text }) => {
        // Tryggja at bara eigarin av sessiónini kann senda tekst
        if (activeSessions.get(roomCode) === socket.id) {
            socket.to(roomCode).emit('text-receive', text);
        }
    });

    // US7: Steðga sessión
    socket.on('stop-session', (roomCode) => {
        if (activeSessions.get(roomCode) === socket.id) {
            io.to(roomCode).emit('session-ended');
            activeSessions.delete(roomCode);
            console.log(`Sessión ${roomCode} endað og strikað.`);
        }
    });

    // Reinsa upp um skribenturin missir sambandið
    socket.on('disconnect', () => {
        for (let [roomCode, ownerId] of activeSessions.entries()) {
            if (ownerId === socket.id) {
                io.to(roomCode).emit('session-ended');
                activeSessions.delete(roomCode);
                console.log(`Skribentur fór offline. Sessión ${roomCode} strikað.`);
            }
        }
    });
});

// Brúka portina frá Render, ella 3000 lokalt
const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
    console.log(`Serverin koyrir á portur ${PORT}`);
});