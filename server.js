const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const multer = require("multer");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

// Static files (Frontend) serve karne ke liye
app.use(express.static(path.join(__dirname, "public")));

// File/Images/Voice upload karne ke liye Multer Storage Setup
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, path.join(__dirname, "public/uploads"));
    },
    filename: (req, file, cb) => {
        cb(null, Date.now() + "-" + file.originalname);
    }
});
const upload = multer({ storage: storage });

// Upload API route
app.post("/upload", upload.single("file"), (req, file) => {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });
    const fileUrl = `/uploads/${req.file.filename}`;
    res.json({ url: fileUrl });
});

// In-memory Database / States
let onlineUsers = {}; // socket.id -> username
let allVisitedUsers = new Set(); // Stores history of all logged in users
let globalHistory = []; // Stores global room messages
let dmHistories = {}; // roomKey -> messageArray (e.g., "user1-user2")
let pinnedMessages = {}; // room -> pinnedText

// Helper function to get private DM room key alphabet-wise (e.g., "aman-devesh")
function getDMKey(user1, user2) {
    return [user1, user2].sort().join("-");
}

// Global User List Sync Broadcast Helper
function broadcastUserLists() {
    io.emit("update user lists", {
        online: Object.values(onlineUsers),
        allVisited: Array.from(allVisitedUsers)
    });
}

// Socket.io Core Engine Logic
io.on("connection", (socket) => {
    
    // 1. New User Joins
    socket.on("new user", (username) => {
        socket.username = username;
        socket.currentRoom = "global"; // Default room is global
        socket.join("global");
        
        onlineUsers[socket.id] = username;
        allVisitedUsers.add(username);
        
        // Broadcast System Alert & Refresh User Lists
        socket.to("global").emit("system", ` can joined the chat`);
        broadcastUserLists();
        
        // Send initial history of global chat to the user
        socket.emit("chat history", globalHistory);
        if (pinnedMessages["global"]) {
            socket.emit("pin message", pinnedMessages["global"]);
        }
    });

    // 2. Room/DM Switch Engine
    socket.on("switch room", (target) => {
        // Purana room leave karo
        socket.leave(socket.currentRoom);
        
        if (target === "global") {
            socket.currentRoom = "global";
            socket.join("global");
            socket.emit("chat history", globalHistory);
            if (pinnedMessages["global"]) {
                socket.emit("pin message", pinnedMessages["global"]);
            } else {
                socket.emit("unpin message");
            }
        } else {
            // Private DM target logic
            const dmKey = getDMKey(socket.username, target);
            socket.currentRoom = dmKey;
            socket.join(dmKey);
            
            if (!dmHistories[dmKey]) dmHistories[dmKey] = [];
            socket.emit("chat history", dmHistories[dmKey]);
            
            if (pinnedMessages[dmKey]) {
                socket.emit("pin message", pinnedMessages[dmKey]);
            } else {
                socket.emit("unpin message");
            }
        }
    });

    // 3. Main Chat Message Handler (Fixed Room Bug)
    socket.on("chat message", (data) => {
        data.user = socket.username;
        
        // Capture context dynamic origin info
        if (socket.currentRoom === "global") {
            data.room = "global";
            globalHistory.push(data);
            io.to("global").emit("chat message", data);
        } else {
            data.room = socket.currentRoom; // custom compound dynamic string key
            if (!dmHistories[socket.currentRoom]) dmHistories[socket.currentRoom] = [];
            dmHistories[socket.currentRoom].push(data);
            
            // Broadcast straight inside target DM room box pipeline
            io.to(socket.currentRoom).emit("chat message", data);
        }
    });

    // 4. Typing State Tracker
    socket.on("typing", (user) => {
        socket.to(socket.currentRoom).emit("typing", user);
    });

    // 5. Message Seen Status Feature
    socket.on("message seen", (data) => {
        // Broadcast acknowledgement downstream inside identical active pool
        socket.to(socket.currentRoom).emit("message seen", {
            messageId: data.messageId,
            users: [data.user]
        });
    });

    // 6. Message Reactions Engine
    socket.on("reaction", (data) => {
        // Inject inside running stream
        io.to(socket.currentRoom).emit("reaction update", {
            messageId: data.messageId,
            reactions: {
                [data.emoji]: [socket.username]
            }
        });
    });

    // 7. Edit Message Engine
    socket.on("edit message", (data) => {
        io.to(socket.currentRoom).emit("edit message", data);
    });

    // 8. Pin/Unpin Message System
    socket.on("pin message", (text) => {
        pinnedMessages[socket.currentRoom] = text;
        io.to(socket.currentRoom).emit("pin message", text);
    });
    socket.on("unpin message", () => {
        delete pinnedMessages[socket.currentRoom];
        io.to(socket.currentRoom).emit("unpin message");
    });

    // 9. Delete Message Handler
    socket.on("delete message", (id) => {
        io.to(socket.currentRoom).emit("delete message", id);
    });

    // 10. Disconnect Network Handler
    socket.on("disconnect", () => {
        if (socket.username) {
            socket.to("global").emit("system", `${socket.username} left the chat`);
            delete onlineUsers[socket.id];
            broadcastUserLists();
        }
    });
});

// Server Fire Up Ignition
server.listen(PORT, () => {
    console.log(`Server is running smoothly on http://localhost:${PORT}`);
});