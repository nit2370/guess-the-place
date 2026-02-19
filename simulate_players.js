const io = require('socket.io-client');

const ROOM_ID = process.argv[2];
const SERVER_URL = process.argv[3] || 'https://guess-the-place.onrender.com';
const NUM_PLAYERS = 40;

if (!ROOM_ID) {
    console.error("Usage: node simulate_players.js <ROOM_ID> [SERVER_URL]");
    process.exit(1);
}

console.log(`Connecting ${NUM_PLAYERS} bots to ${SERVER_URL} for room ${ROOM_ID}...`);

const bots = [];

for (let i = 0; i < NUM_PLAYERS; i++) {
    // Stagger connections slightly
    setTimeout(() => {
        const socket = io(SERVER_URL, {
            transports: ['websocket', 'polling'], // Allow polling fallbacks for stability
            reconnection: true,
            forceNew: true // Ensure distinct connections
        });

        const name = `Bot_${i + 1}`;

        socket.on('connect', () => {
            // Join room
            socket.emit('player-join', { roomId: ROOM_ID, playerName: name });
        });

        socket.on('room-joined', () => {
            console.log(`${name} joined!`);
        });

        socket.on('round-start', (data) => {
            // Determine behavior for this round
            const isCorrect = Math.random() < 0.6; // 60% get it right
            const isClose = !isCorrect && Math.random() < 0.5; // 20% close

            const delay = Math.random() * (data.totalTime * 0.8) + 1000; // Random delay within 80% time

            setTimeout(() => {
                if (isCorrect) {
                    socket.emit('submit-guess', { roomId: ROOM_ID, guess: '##CORRECT##' });
                    console.log(`✅ ${name} guessing CORRECT`);
                } else if (isClose) {
                    // Just send a random string for now, unless I know the answer? 
                    // Since I don't know the answer, close/partial is hard to fake without the answer.
                    // I'll skip partial simulation for now and just do correct vs wrong.
                    socket.emit('submit-guess', { roomId: ROOM_ID, guess: 'wrong_guess' });
                    console.log(`❌ ${name} guessing WRONG`);
                } else {
                    // Do nothing (timeout)
                    console.log(`zzz ${name} sleeping this round`);
                }
            }, delay);
        });

        socket.on('disconnect', () => {
            console.log(`${name} disconnected`);
        });

        bots.push(socket);
    }, i * 100); // 100ms stagger between bots
}

// Keep process alive
setInterval(() => { }, 10000);
