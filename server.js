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

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const systemPrompt = `Tú ert ein málsligur hjálpari fyri deyv og tunghoyrd. 
Dikteringin fer fram á møti, og tú rættar dikteringina til, áðrenn hon verður víst teimum ið lesa. Dikteringin fer fram við einum software, sum hevur 10-15% word error rate.

REGLUR OG KONTEKSTUR:
1. Evnið er oftast andaligt og grundað á Bíbliuna og kristnu trúnna. Tað kann tó koma fyri, at vit tosa um annað, so sum lýsingar, samfelagið og hvat hendir í salinum.
2. Rætta føroyska tekstin fyri stavivillur og set teknseting.
3. Kemur okkurt orð skeivt fyri, rætta so orðið soleiðis at tað passar í kontextin (t.d. andalig orð ið STT hevur mistikið).
4. Fjerna ískotin orð, so sum 'Øhh', og óneyðugar endurtøkur.
5. Ivast tú í onkrum, ella rættar tú okkurt tú ikki ert vísur í, skriva tekstin í fýrkandaðar klombur, so lesarin sær at talan er um giting. Dømi: Hann segði: Gangi niðan til [Getsemane] og sigi teimum frá...
6. Svara BARA við rættaða ella umsetta tekstinum, og onki annað. Ongar viðmerkingar.`;

// Sløkk fyri trygdarfiltrum, so andalig orð ikki verða blokerað
const safetySettings = [
    { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
    { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
    { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
    { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' }
];

const model = genAI.getGenerativeModel({ 
    model: "gemini-3.1-flash-lite-preview",
    systemInstruction: systemPrompt,
    safetySettings: safetySettings
});

app.get('/ping', (req, res) => res.status(200).send('pong'));

app.use(express.static('public'));

const activeSessions = new Map(); // roomCode -> { ownerId, chatSession, ttsAllowed }
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
            const chat = model.startChat({
                history: [],
                generationConfig: { maxOutputTokens: 1000 },
            });

            activeSessions.set(roomCode, { 
                ownerId: socket.id, 
                chatSession: chat,
                ttsAllowed: false // Standard: Upplestur er sløktur í byrjanini
            });
            
            socket.join(roomCode);
            socket.emit('session-created', roomCode);
            console.log(`Sessión stovnað: ${roomCode}`);
        }
    });

    socket.on('join-session', (roomCode) => {
        const session = activeSessions.get(roomCode);
        if (session) {
            socket.join(roomCode);
            // Send bæði kotu og TTS-støðu til lesaran
            socket.emit('session-joined', { roomCode: roomCode, ttsAllowed: session.ttsAllowed });
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
            if (disconnectTimeouts.has(roomCode)) clearTimeout(disconnectTimeouts.get(roomCode));
            updateReaderCount(roomCode);
        }
    });

    // Skribentur broytir TTS loyvið
    socket.on('set-tts-state', ({ roomCode, state }) => {
        const session = activeSessions.get(roomCode);
        if (session && session.ownerId === socket.id) {
            session.ttsAllowed = state;
            io.to(roomCode).emit('tts-state-changed', state);
        }
    });

    socket.on('process-ai-text', async ({ roomCode, text, targetLang }) => {
        const session = activeSessions.get(roomCode);
        if (session && session.ownerId === socket.id) {
            try {
                let instruction = "";
                if (targetLang && targetLang !== 'fo') {
                    instruction = `[UMSETINGSKRAV: TÚ SKALT UMSETA HETTA TEKSTBROTIÐ TIL ${targetLang.toUpperCase()}. SVARA BARA VIÐ UMSETINGINI.]\n\n`;
                } else {
                    instruction = `[KRAV: RÆTTA HETTA TEKSTBROTIÐ Á FØROYSKUM. SVARA BARA VIÐ RÆTTAÐA TEKSTINUM.]\n\n`;
                }

                const result = await session.chatSession.sendMessage(instruction + `Tekstur at viðgera: "${text}"`);
                let correctedText = result.response.text().trim();
                
                if (!correctedText) correctedText = text;

                socket.emit('ai-text-result', correctedText);
            } catch (error) {
                console.error("🔴 Gemini Feilur:", error.message);
                if (targetLang && targetLang !== 'fo') {
                    socket.emit('ai-text-result', `[Tøkniligur steðgur] `);
                } else {
                    socket.emit('ai-text-result', text);
                }
            }
        }
    });

    socket.on('text-delta', (payload) => {
        const session = activeSessions.get(payload.roomCode);
        if (session && session.ownerId === socket.id) {
            // Sendir alt objektid við delta og lang víðari
            socket.to(payload.roomCode).emit('text-delta', { 
                delta: payload.delta, 
                lang: payload.lang 
            });
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
            if (activeSessions.has(roomCode)) setTimeout(() => updateReaderCount(roomCode), 100);
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
server.listen(PORT, '0.0.0.0', () => console.log(`Serverin koyrir á portur ${PORT}`));
