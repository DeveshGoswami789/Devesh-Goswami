const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const multer = require("multer");
const fs = require("fs");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

const PORT = process.env.PORT || 3000;

// 📂 Public files serve karna
app.use(express.static(path.join(__dirname, "public")));

// 📂 Auto Create Uploads Directory if it doesn't exist
const uploadDir = path.join(__dirname, "public", "uploads");
if (!fs.existsSync(uploadDir)){
    fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        cb(null, Date.now() + "-" + file.originalname.replace(/\s+/g, '-'));
    }
});
const upload = multer({ 
    storage: storage,
    limits: { fileSize: 10 * 1024 * 1024 } 
});

app.post("/upload", upload.single("file"), (req, res) => {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });
    const fileUrl = `/uploads/${req.file.filename}`;
    res.json({ url: fileUrl });
});

let onlineUsers = {}; 
let allVisitedUsers = new Set(); 
let globalHistory = []; 
let dmHistories = {}; 
let pinnedMessages = {}; 

// 👑 CUSTOM ADMIN CONFIGURATION KEY
// Bhai yahan tu "Devesh Goswami" ki jagah jo bhi naam rakhega, wahi secret admin ban jayega!
const SECRET_ADMIN_KEY = "Devesh Goswami";

function getDMKey(user1, user2) {
    return [user1, user2].sort().join("-");
}

function broadcastUserLists() {
    io.emit("update user lists", {
        online: Object.values(onlineUsers),
        allVisited: Array.from(allVisitedUsers)
    });
}

io.on("connection", (socket) => {
    
    // 🔒 USERNAME AVAILABILITY CHECK HANDLER
    socket.on("check username", (requestedName, callback) => {
        const nameLower = requestedName.trim().toLowerCase();
        
        // Check if username is already in use by any online socket connection
        const isTaken = Object.values(onlineUsers).some(
            existingUser => existingUser.toLowerCase() === nameLower
        );
        
        if (isTaken) {
            callback({ available: false });
        } else {
            callback({ available: true });
        }
    });

    socket.on("new user", (username) => {
        socket.username = username;
        socket.currentRoom = "global";
        socket.join("global");
        
        onlineUsers[socket.id] = username;
        allVisitedUsers.add(username);
        
        socket.to("global").emit("system", `${username} joined the chat`);
        broadcastUserLists();
        
        socket.emit("chat history", globalHistory);
        if (pinnedMessages["global"]) {
            socket.emit("pin message", pinnedMessages["global"]);
        }
    });

    socket.on("switch room", (target) => {
        socket.leave(socket.currentRoom);
        
        if (target === "global") {
            socket.currentRoom = "global";
            socket.join("global");
            socket.emit("chat history", globalHistory);
        } else {
            const dmKey = getDMKey(socket.username, target);
            socket.currentRoom = dmKey;
            socket.join(dmKey);
            
            if (!dmHistories[dmKey]) dmHistories[dmKey] = [];
            socket.emit("chat history", dmHistories[dmKey]);
        }
        
        if (pinnedMessages[socket.currentRoom]) {
            socket.emit("pin message", pinnedMessages[socket.currentRoom]);
        } else {
            socket.emit("unpin message");
        }
    });

    socket.on("chat message", (data) => {
        data.user = socket.username;
        data.reactions = {}; 
        
        if (socket.currentRoom === "global") {
            data.room = "global";
            globalHistory.push(data);
            io.to("global").emit("chat message", data);
        } else {
            data.room = socket.currentRoom; 
            if (!dmHistories[socket.currentRoom]) dmHistories[socket.currentRoom] = [];
            dmHistories[socket.currentRoom].push(data);
            io.to(socket.currentRoom).emit("chat message", data);
        }
    });

    socket.on("typing", (user) => {
        socket.to(socket.currentRoom).emit("typing", user);
    });

    socket.on("message seen", (data) => {
        socket.to(socket.currentRoom).emit("message seen", {
            messageId: data.messageId,
            users: [data.user]
        });
    });

    socket.on("reaction", (data) => {
        let msgTarget = null;
        if (socket.currentRoom === "global") {
            msgTarget = globalHistory.find(m => m.id == data.messageId);
        } else {
            if (dmHistories[socket.currentRoom]) {
                msgTarget = dmHistories[socket.currentRoom].find(m => m.id == data.messageId);
            }
        }

        if (msgTarget) {
            if (!msgTarget.reactions) msgTarget.reactions = {};
            if (!msgTarget.reactions[data.emoji]) {
                msgTarget.reactions[data.emoji] = [];
            }
            
            if (msgTarget.reactions[data.emoji].includes(socket.username)) {
                msgTarget.reactions[data.emoji] = msgTarget.reactions[data.emoji].filter(u => u !== socket.username);
            } else {
                msgTarget.reactions[data.emoji].push(socket.username);
            }
            
            io.to(socket.currentRoom).emit("reaction update", {
                messageId: data.messageId,
                reactions: msgTarget.reactions
            });
        }
    });

    socket.on("edit message", (data) => {
        let msgTarget = null;
        if (socket.currentRoom === "global") {
            msgTarget = globalHistory.find(m => m.id == data.id);
        } else if (dmHistories[socket.currentRoom]) {
            msgTarget = dmHistories[socket.currentRoom].find(m => m.id == data.id);
        }
        if(msgTarget) msgTarget.text = data.text;

        io.to(socket.currentRoom).emit("edit message", data);
    });

    socket.on("pin message", (data) => {
        let pinPayload = { text: "", id: "" };
        
        if (data && typeof data === 'object') {
            pinPayload.text = data.text;
            pinPayload.id = data.id;
        } else {
            pinPayload.text = data;
            let msgTarget = null;
            if (socket.currentRoom === "global") {
                msgTarget = globalHistory.find(m => m.text === data);
            } else if (dmHistories[socket.currentRoom]) {
                msgTarget = dmHistories[socket.currentRoom].find(m => m.text === data);
            }
            if (msgTarget) pinPayload.id = msgTarget.id;
        }

        pinnedMessages[socket.currentRoom] = pinPayload;
        io.to(socket.currentRoom).emit("pin message", pinPayload);
    });
    
    socket.on("unpin message", () => {
        delete pinnedMessages[socket.currentRoom];
        io.to(socket.currentRoom).emit("unpin message");
    });

    socket.on("delete message", (id) => {
        if (socket.currentRoom === "global") {
            globalHistory = globalHistory.filter(m => m.id != id);
        } else if (dmHistories[socket.currentRoom]) {
            dmHistories[socket.currentRoom] = dmHistories[socket.currentRoom].filter(m => m.id != id);
        }
        io.to(socket.currentRoom).emit("delete message", id);
    });

    // 📢 ADMIN FEATURE: Broadcast Alert Event
    socket.on("send broadcast alert", (alertText) => {
        if (socket.username === SECRET_ADMIN_KEY) {
            io.emit("receive broadcast alert", alertText);
        }
    });

    // 👥 ADMIN FEATURE: Active Users Details Event
    socket.on("get active users list", () => {
        if (socket.username === SECRET_ADMIN_KEY) {
            const list = Object.keys(onlineUsers).map(id => ({
                username: onlineUsers[id],
                socketId: id
            }));
            socket.emit("active users list res", list);
        }
    });

    // 🧹 ADMIN FEATURE: Purge Chats (Delete everything)
    socket.on("purge all chats", () => {
        if (socket.username === SECRET_ADMIN_KEY) {
            globalHistory = [];
            dmHistories = {};
            pinnedMessages = {};
            io.emit("chats purged");
        }
    });

    // 🛡️ ADMIN FEATURE: Force Delete Message Moderation
    socket.on("admin delete message", (id) => {
        if (socket.username === SECRET_ADMIN_KEY) {
            globalHistory = globalHistory.filter(m => m.id != id);
            for (let roomKey in dmHistories) {
                dmHistories[roomKey] = dmHistories[roomKey].filter(m => m.id != id);
            }
            io.to(socket.currentRoom).emit("delete message", id);
        }
    });

    socket.on("disconnect", () => {
        if (socket.username) {
            socket.to("global").emit("system", `${socket.username} left the chat`);
            delete onlineUsers[socket.id];
            broadcastUserLists();
        }
    });
});

server.listen(PORT, () => {
    console.log(`Server running safely on port ${PORT}`);
});