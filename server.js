const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// In-memory room storage
const rooms = new Map();
const ROOM_EXPIRY_TIME = 10 * 60 * 1000; // 10 minutes in milliseconds

// Set to store used room codes to ensure uniqueness
const usedCodes = new Set();

// Set to store user sessions to prevent rejoining after leaving
const userSessions = new Map(); // Maps socket.id to room codes they've joined
const usernameSessions = new Map(); // Maps username to room codes they've joined

// Function to generate a unique 4-digit room code
function generateUniqueRoomCode() {
  let code;
  let attempts = 0;
  const maxAttempts = 100; // Prevent infinite loop
  
  do {
    code = Math.floor(Math.random() * 10000).toString().padStart(4, '0');
    attempts++;
  } while (usedCodes.has(code) && attempts < maxAttempts);
  
  if (attempts >= maxAttempts) {
    // If we've tried too many times, try a different approach
    // This is extremely unlikely but good to have as a fallback
    let fallbackCode;
    do {
      fallbackCode = Math.floor(Math.random() * 10000).toString().padStart(4, '0');
    } while (rooms.has(fallbackCode));
    code = fallbackCode;
  }
  
  usedCodes.add(code);
  return code;
}

// Clean up expired rooms
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms.entries()) {
    if (now > room.expiresAt) {
      // Notify users before cleanup
      io.to(code).emit('roomExpired');
      rooms.delete(code);
      usedCodes.delete(code); // Remove from used codes set
      console.log(`Room ${code} expired and cleaned up`);
    }
  }
}, 30000); // Check every 30 seconds

// Socket connection handling
io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  // Handle room creation/joining
  socket.on('joinRoom', (data) => {
    const { code, username } = data;
    
    // Validate 4-digit code
    if (!/^\d{4}$/.test(code)) {
      socket.emit('error', { message: 'Invalid code. Please enter exactly 4 digits.' });
      return;
    }

    // Check if room exists
    if (!rooms.has(code)) {
      // Room doesn't exist - only allow joining if it's a valid used code
      // This prevents random code entry from creating new rooms
      socket.emit('error', { message: 'Room not found. Please check the code or create a new room.' });
      return;
    }

    const room = rooms.get(code);

    // Check if room is full (max 2 users)
    if (room.users.length >= 2) {
      socket.emit('roomFull');
      return;
    }

    // Check if user already in room (prevent duplicates)
    if (room.users.find(user => user.socketId === socket.id)) {
      socket.emit('error', { message: 'You are already in this room.' });
      return;
    }

    // Check if user has already left this room (prevent rejoining)
    const userSessionKey = `${socket.id}-${code}`;
    const usernameSessionKey = `${username || 'anonymous'}-${code}`;
    if (userSessions.has(userSessionKey) || usernameSessions.has(usernameSessionKey)) {
      socket.emit('error', { message: 'You cannot rejoin a room you have left. Please create a new room or use a different code.' });
      return;
    }

    // Add user to room
    const user = {
      socketId: socket.id,
      username: username || `User${Math.floor(Math.random() * 1000)}`,
      joinedAt: Date.now()
    };

    room.users.push(user);
    room.lastActivity = Date.now();
    room.expiresAt = Date.now() + ROOM_EXPIRY_TIME; // Reset expiry

    // Join socket room
    socket.join(code);
    socket.roomCode = code;

    // Notify user of successful join
    socket.emit('joinedRoom', {
      code,
      username: user.username,
      userCount: room.users.length,
      messages: room.messages
    });

    // Notify other users in room
    socket.to(code).emit('userJoined', {
      username: user.username,
      userCount: room.users.length
    });

    console.log(`User ${user.username} joined room ${code}`);
  });

  // Handle room creation with unique code
  socket.on('createRoom', (data) => {
    const { username } = data;
    
    // Generate a unique room code
    const code = generateUniqueRoomCode();
    
    // Create new room
    rooms.set(code, {
      users: [],
      messages: [],
      createdAt: Date.now(),
      expiresAt: Date.now() + ROOM_EXPIRY_TIME,
      lastActivity: Date.now()
    });
    
    const room = rooms.get(code);
    console.log(`Room ${code} created`);

    // Add user to room
    const user = {
      socketId: socket.id,
      username: username || `User${Math.floor(Math.random() * 1000)}`,
      joinedAt: Date.now()
    };

    room.users.push(user);
    room.lastActivity = Date.now();
    room.expiresAt = Date.now() + ROOM_EXPIRY_TIME; // Reset expiry

    // Join socket room
    socket.join(code);
    socket.roomCode = code;

    // Notify user of successful creation
    socket.emit('joinedRoom', {
      code,
      username: user.username,
      userCount: room.users.length,
      messages: room.messages
    });

    console.log(`User ${user.username} created and joined room ${code}`);
  });

  // Handle sending messages
  socket.on('sendMessage', (data) => {
    const { message } = data;
    const roomCode = socket.roomCode;

    if (!roomCode || !rooms.has(roomCode)) {
      socket.emit('error', { message: 'You are not in a valid room.' });
      return;
    }

    const room = rooms.get(roomCode);
    const user = room.users.find(u => u.socketId === socket.id);

    if (!user) {
      socket.emit('error', { message: 'User not found in room.' });
      return;
    }

    // Create message object
    const messageObj = {
      id: Date.now() + Math.random(),
      username: user.username,
      message: message.trim(),
      timestamp: Date.now(),
      socketId: socket.id
    };

    // Add to room messages
    room.messages.push(messageObj);
    room.lastActivity = Date.now();
    room.expiresAt = Date.now() + ROOM_EXPIRY_TIME; // Reset expiry

    // Broadcast message to all users in room
    io.to(roomCode).emit('newMessage', messageObj);

    console.log(`Message sent in room ${roomCode}: ${message}`);
  });

  // Handle typing indicator
  socket.on('typing', (data) => {
    const roomCode = socket.roomCode;
    if (roomCode) {
      socket.to(roomCode).emit('userTyping', {
        username: data.username,
        isTyping: data.isTyping
      });
    }
  });

  // Handle disconnect
  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
    
    const roomCode = socket.roomCode;
    if (roomCode && rooms.has(roomCode)) {
      const room = rooms.get(roomCode);
      const userIndex = room.users.findIndex(u => u.socketId === socket.id);
      
      if (userIndex !== -1) {
        const user = room.users[userIndex];
        room.users.splice(userIndex, 1);
        
        // Track that this user has left this room (prevent rejoining)
        const userSessionKey = `${socket.id}-${roomCode}`;
        const usernameSessionKey = `${user.username}-${roomCode}`;
        userSessions.set(userSessionKey, true);
        usernameSessions.set(usernameSessionKey, true);
        
        // Notify remaining users
        socket.to(roomCode).emit('userLeft', {
          username: user.username,
          userCount: room.users.length
        });

        console.log(`User ${user.username} left room ${roomCode}`);

        // Clean up empty rooms and their messages
        if (room.users.length === 0) {
          // Clear messages when room is empty
          room.messages = [];
          rooms.delete(roomCode);
          usedCodes.delete(roomCode); // Remove from used codes set
          console.log(`Empty room ${roomCode} cleaned up`);
        }
      }
    }
  });

  // Handle manual leave room
  socket.on('leaveRoom', () => {
    const roomCode = socket.roomCode;
    if (roomCode && rooms.has(roomCode)) {
      const room = rooms.get(roomCode);
      const userIndex = room.users.findIndex(u => u.socketId === socket.id);
      
      if (userIndex !== -1) {
        const user = room.users[userIndex];
        room.users.splice(userIndex, 1);
        
        socket.leave(roomCode);
        socket.roomCode = null;
        
        // Track that this user has left this room (prevent rejoining)
        const userSessionKey = `${socket.id}-${roomCode}`;
        const usernameSessionKey = `${user.username}-${roomCode}`;
        userSessions.set(userSessionKey, true);
        usernameSessions.set(usernameSessionKey, true);
        
        // Notify remaining users
        socket.to(roomCode).emit('userLeft', {
          username: user.username,
          userCount: room.users.length
        });

        socket.emit('leftRoom');

        // Clean up empty rooms and their messages
        if (room.users.length === 0) {
          // Clear messages when room is empty
          room.messages = [];
          rooms.delete(roomCode);
          usedCodes.delete(roomCode); // Remove from used codes set
          console.log(`Empty room ${roomCode} cleaned up`);
        }
      }
    }
  });

  // WebRTC Signaling Events for Voice Chat
  socket.on('voiceChatOffer', (data) => {
    const roomCode = socket.roomCode;
    if (roomCode && rooms.has(roomCode)) {
      socket.to(roomCode).emit('voiceChatOffer', data);
    }
  });

  socket.on('voiceChatAnswer', (data) => {
    const roomCode = socket.roomCode;
    if (roomCode && rooms.has(roomCode)) {
      socket.to(roomCode).emit('voiceChatAnswer', data);
    }
  });

  socket.on('iceCandidate', (data) => {
    const roomCode = socket.roomCode;
    if (roomCode && rooms.has(roomCode)) {
      socket.to(roomCode).emit('iceCandidate', data);
    }
  });

  socket.on('startVoiceChat', () => {
    const roomCode = socket.roomCode;
    if (roomCode && rooms.has(roomCode)) {
      // Update room state to indicate voice chat is active
      const room = rooms.get(roomCode);
      room.inVoiceChat = true;
      socket.to(roomCode).emit('voiceChatStarted');
    }
  });

  socket.on('endVoiceChat', () => {
    const roomCode = socket.roomCode;
    if (roomCode && rooms.has(roomCode)) {
      // Update room state to indicate voice chat is inactive
      const room = rooms.get(roomCode);
      room.inVoiceChat = false;
      socket.to(roomCode).emit('voiceChatEnded');
    }
  });
});

// Root route
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Endpoint to generate a unique room code
app.get('/generateRoomCode', (req, res) => {
  const code = generateUniqueRoomCode();
  res.json({ code });
});

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Ephemeral Chat Server running on port ${PORT}`);
  console.log(`📱 Open http://localhost:${PORT} to start chatting`);
});
