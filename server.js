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

// HER ERU REGLURNAR HJÁ AI AGENTINUM (SYSTEM INSTRUCTION)
const systemPrompt = `Tú ert ein málsligur hjálpari fyri deyv og tunghoyrd. 
Dikteringin fer fram á møti, og tú rættar dikteringina til, áðrenn hon verður víst teimum ið lesa. 

REGLUR OG KONTEKSTUR:
1. Evnið er oftast andaligt og grundað á Bíbliuna og kristnu trúnna. Tað kann tó koma fyri, at vit tosa um annað, so sum lýsingar, samfelagið og hvat hendir í salinum.
2. Rætta henda føroyska tekstin (sum er talu-til-tekst) fyri stavivillur og set teknseting (komma, punktum osfr.).
3. Kemur okkurt orð skeivt fyri, rætta so orðið soleiðis at tað passar í kontextin (t.d. andalig orð ið STT hevur mistikið).
4. Fjerna ískotin orð, so sum 'Øhh', og óneyðugar endurtøkur.
5. Varðveit meiningina og málburðin.
6. Brúka kjak-kontekstin til at gera dikteringina rættari og rættari, so hvørt sum tað verður talað á møtinum.
7. Svara BARA við rættaða/umsetta tekstinum, onki annað.`;

const model = genAI.getGenerativeModel({ 
    model: "gemini-3.1-flash-lite",
    systemInstruction: systemPrompt
});

app.get('/ping', (req, res) => {
    res.status(200).send('pong');
});

app.use(express.static('public'));

const activeSessions = new Map(); // roomCode -> { ownerId, chatSession }
const disconnectTimeouts = new Map(); // roomCode -> timeout-ID

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
            // Stovna nýggja chat-sessión við Gemini
            const chat = model.startChat({
                history: [],
                generationConfig: { maxOutputTokens: 1000 },
            });

            activeSessions.set(roomCode, { 
                ownerId: socket.id, 
                chatSession: chat 
            });

            socket.join(roomCode);
            socket.emit('session-created', roomCode);
            console.log(`Sessión stovnað: ${roomCode}`);
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
        const session = activeSessions.get(roomCode);
        if (session) {
            session.ownerId = socket.id;
            socket.join(roomCode);
            if (disconnectTimeouts.has(roomCode)) {
                clearTimeout(disconnectTimeouts.get(roomCode));
                disconnectTimeouts.delete(roomCode);
                console.log(`Skribentur reclaimaði sessión: ${roomCode}`);
            }
            updateReaderCount(roomCode);
        }
    });

    socket.on('process-ai-text', async ({ roomCode, text, targetLang }) => {
        const session = activeSessions.get(roomCode);
        if (session && session.ownerId === socket.id) {
            try {
                // Legg mál-instruksjónina afturat um tað skal umsetast
                let instruction = (targetLang && targetLang !== 'fo') 
                    ? `Umset henda tekstin til ${targetLang} og rætta málsliga.` 
                    : `Rætta henda tekstin á føroyskum.`;

                const result = await session.chatSession.sendMessage(`${instruction}\n\nTekstur: "${text}"`);
                const correctedText = result.response.text();
                
                socket.emit('ai-text-result', correctedText);
            } catch (error) {
                console.error("Gemini Feilur:", error);
                socket.emit('ai-text-result', text);
            }
        }
    });

    socket.on('text-delta', ({ roomCode, delta }) => {
        const session = activeSessions.get(roomCode);
        if (session && session.ownerId === socket.id) {
            socket.to(roomCode).emit('text-delta', delta);
        }
    });

    socket.on('text-reset', ({ roomCode }) => {
        const session = activeSessions.get(roomCode);
        if (session && session.ownerId === socket.id) {
            socket.to(roomCode).emit('text-reset');
        }
    });

    socket.on('stop-session', (roomCode) => {
        const session = activeSessions.get(roomCode);
        if (session && session.ownerId === socket.id) {
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
        for (let [roomCode, session] of activeSessions.entries()) {
            if (session.ownerId === socket.id) {
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
