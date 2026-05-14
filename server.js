require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { GoogleGenerativeAI } = require("@google/generative-ai");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// Gemini Uppseting
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-3.1-flash-lite-preview" });

app.get('/ping', (req, res) => {
    console.log('Ping mót tikið - heldur sessiónini á lívi.');
    res.status(200).send('pong');
});

app.use(express.static('public'));

const activeSessions = new Map(); // roomCode -> socket.id hjá skribenti
const disconnectTimeouts = new Map(); // roomCode -> timeout-ID

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

    // Skribentur reclaim'ar sína sessión
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

    // --- NÝTT: AI BEHANDLING ---
    socket.on('process-ai-text', async ({ roomCode, text }) => {
        if (activeSessions.get(roomCode) === socket.id) {
            try {
                // Promptin til Gemini (kann tillagast eftir tørvi)
                const prompt = `Tú ert ein málsligur hjálpari fyri deyv og tunghoyrd. Dikteringin fer fram á møti, og tú rættar dikteringina til, áðrenn hon verður víst teimum ið lesa. Umset henda føroyska tekstin (sum er talu-til-tekst) til tjekkiskt, og set teknseting (komma, punktum osfr.), so hann er lættur at lesa. Kemur okkurt orð skeivt fyri, rætta so orðið soleiðis at tað passar í kontextin. Fjerna ískotin orð, so sum 'Øhh', og óneyðugar endurtøkur. Varðveit meiningina og málburðin. Goym kontekstin, og brúka hann til at gera dikteringina rættari og rættari, so hvørt sum tað verður talað. Svara BARA við rættaða tekstinum, onki annað: "${text}"`
                //const prompt = `Tú ert ein málsligur hjálpari fyri deyv og tunghoyrd. Dikteringin fer fram á møti, og tú rættar dikteringina til, áðrenn hon verður víst teimum ið lesa. Evni er oftast andaligt og grunda á bíbliuna og kristnu trúnna - Tað kann koma fyri at vit tosa um annað, so sum lýsingar og hvat hendir í samfelagnum og í salinum gjøgnum vikuna. Rætta henda føroyska tekstin (sum er talu-til-tekst) fyri stavivillur og set teknseting (komma, punktum osfr.), so hann er lættur at lesa. Kemur okkurt orð skeivt fyri, rætta so orðið soleiðis at tað passar í kontextin. Fjerna ískotin orð, so sum 'Øhh', og óneyðugar endurtøkur. Varðveit meiningina og málburðin. Goym kontekstin, og brúka hann til at gera dikteringina rættari og rættari, so hvørt sum tað verður talað á møtinum. Svara BARA við rættaða tekstinum, onki annað: "${text}"`;
    
                
                const result = await model.generateContent(prompt);
                const correctedText = result.response.text();
                
                socket.emit('ai-text-result', correctedText);
            } catch (error) {
                console.error("Gemini Feilur:", error);
                // Um AI feilar (t.d. manglandi API lykil), senda vit bara "raw" tekstin
                socket.emit('ai-text-result', text);
            }
        }
    });

    // Delta sending: Sendir bara nýggja tekstbrotin víðari til lesararnar
    socket.on('text-delta', ({ roomCode, delta }) => {
        if (activeSessions.get(roomCode) === socket.id) {
            socket.to(roomCode).emit('text-delta', delta);
        }
    });

    // Reinsa skermin hjá lesarum
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
