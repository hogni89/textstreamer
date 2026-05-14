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

// System Promptin ið stýrir hvussu Gemini rættar tekstin
const systemPrompt = `Tú ert ein málsligur hjálpari fyri deyv og tunghoyrd. 
Dikteringin fer fram á møti, og tú rættar dikteringina til, áðrenn hon verður víst teimum ið lesa. 
Evnið er oftast andaligt og grundað á Bíbliuna og kristnu trúnna, men tað kann eisini vera um samfelagsviðurskifti.

REGLUR:
1. Rætta stavivillur og set teknseting (komma, punktum osfr.).
2. Um tvey orð ljóða líka, brúka so kontekstin frá tí, sum er sagt fyrr í møtinum, at velja tað rætta.
3. Fjerna ískotin orð (øhh, hm) og óneyðugar endurtøkur.
4. Varðveit meiningina og málburðin.
5. Svara BARA við rættaða tekstinum, onki annað.`;

const model = genAI.getGenerativeModel({ 
    model: "gemini-1.5-flash",
    systemInstruction: systemPrompt
});

app.get('/ping', (req, res) => {
    res.status(200).send('pong');
});

app.use(express.static('public'));

// activeSessions goymir nú { ownerId, chatSession }
const activeSessions = new Map(); 
const disconnectTimeouts = new Map(); 

function updateReaderCount(roomCode) {
    const clients = io.sockets.adapter.rooms.get(roomCode);
    const count = clients ? clients.size - 1 : 0;
    io.to(roomCode).emit('reader-count', Math.max(0, count));
}

io.on('connection', (socket) => {
    
    socket.on('client-error', (errorInfo) => {
        console.error(`🔴 [BROWSER FEILUR] ${socket.id}:`, JSON.stringify(errorInfo, null, 2));
    });

    // Skribentur stovnar nýggja sessión
    socket.on('create-session', (roomCode) => {
        if (activeSessions.has(roomCode)) {
            socket.emit('session-error', 'Henda sessiónskotan er longu í brúk.');
        } else {
            // STOVNA AI CHAT SESSIÓN HER
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
            console.log(`Sessión stovnað við AI-minni: ${roomCode}`);
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

    // Skribentur reclaim'ar sína sessión (t.d. eftir refresh)
    socket.on('reclaim-session', (roomCode) => {
        const session = activeSessions.get(roomCode);
        if (session) {
            session.ownerId = socket.id; // Uppdatera socket ID
            socket.join(roomCode);
            if (disconnectTimeouts.has(roomCode)) {
                clearTimeout(disconnectTimeouts.get(roomCode));
                disconnectTimeouts.delete(roomCode);
                console.log(`Skribentur reclaimaði sessión: ${roomCode}`);
            }
            updateReaderCount(roomCode);
        }
    });

    // --- AI BEHANDLING VIÐ MINNI ---
    socket.on('process-ai-text', async ({ roomCode, text }) => {
        const session = activeSessions.get(roomCode);
        
        if (session && session.ownerId === socket.id) {
            try {
                // Vit brúka sendMessage í staðin fyri generateContent fyri at varðveita søguna
                const result = await session.chatSession.sendMessage(text);
                const correctedText = result.response.text();
                
                socket.emit('ai-text-result', correctedText);
            } catch (error) {
                console.error("Gemini Feilur:", error);
                // Um AI feilar, senda vit bara upprunaliga tekstin víðari
                socket.emit('ai-text-result', text);
            }
        }
    });

    // Sendir nýggja tekstbrotin víðari til lesararnar
    socket.on('text-delta', ({ roomCode, delta }) => {
        const session = activeSessions.get(roomCode);
        if (session && session.ownerId === socket.id) {
            socket.to(roomCode).emit('text-delta', delta);
        }
    });

    // Reinsa skermin hjá lesarum
    socket.on('text-reset', ({ roomCode }) => {
        const session = activeSessions.get(roomCode);
        if (session && session.ownerId === socket.id) {
            socket.to(roomCode).emit('text-reset');
        }
    });

    // Skribenturin endar sessiónina manuelt
    socket.on('stop-session', (roomCode) => {
        const session = activeSessions.get(roomCode);
        if (session && session.ownerId === socket.id) {
            io.to(roomCode).emit('session-ended');
            activeSessions.delete(roomCode);
            console.log(`Sessión endað manuelt: ${roomCode}`);
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
                    console.log(`Sessión stongd eftir timeout: ${roomCode}`);
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
