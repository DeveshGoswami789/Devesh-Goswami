const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const multer = require("multer");
const fs = require("fs");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, "public")));

// 📂 Auto Create Uploads Directory if it doesn't exist
const uploadDir = path.join(__dirname, "public/uploads");
if (!fs.existsSync(uploadDir)){
    fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        cb(null, Date.now() + "-" + file.originalname);
    }
});
const upload = multer({ storage: storage });

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
        data.reactions = {}; // Initialize reactions object for every new message
        
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

    // 🌟 REACTION FIX: Save reaction directly into history arrays
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
            
            // Toggle or clear reaction logic: if same user reacts same emoji, remove it.
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

    socket.on("pin message", (text) => {
        pinnedMessages[socket.currentRoom] = text;
        io.to(socket.currentRoom).emit("pin message", text);
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