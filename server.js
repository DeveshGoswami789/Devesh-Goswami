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

// 📂 Auto Create Uploads Directory if it doesn't exist (Render Storage Friendly)
const uploadDir = path.join(__dirname, "public", "uploads");
if (!fs.existsSync(uploadDir)){
    fs.mkdirSync(uploadDir, { recursive: true });
}

// 🔐 File-Based Database logic for User Authentication
const usersFile = path.join(__dirname, "users.json");
let dbUsers = {}; // Stores { username: password }
if (fs.existsSync(usersFile)) {
    try {
        dbUsers = JSON.parse(fs.readFileSync(usersFile, "utf8"));
    } catch(e) {
        dbUsers = {};
    }
}

function saveUsersToDB() {
    fs.writeFileSync(usersFile, JSON.stringify(dbUsers, null, 2), "utf8");
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
    limits: { fileSize: 10 * 1024 * 1024 } // 10MB Limit for Render
});

app.post("/upload", upload.single("file"), (req, res) => {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });
    const fileUrl = `/uploads/${req.file.filename}`;
    res.json({ url: fileUrl });
});

let onlineUsers = {}; 
let allVisitedUsers = new Set(Object.keys(dbUsers)); 
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
    
    // 🛡️ Auth Logic Handler
    socket.on("auth user", (data) => {
        const { username, password, isLogin } = data;
        
        if (!username || !password) {
            socket.emit("auth response", { success: false, message: "Username & Password are required!" });
            return;
        }

        if (isLogin) {
            // Login Logic
            if (dbUsers[username] && dbUsers[username] === password) {
                proceedUserSession(socket, username, password);
            } else {
                socket.emit("auth response", { success: false, message: "Wrong username or password!" });
            }
        } else {
            // Signup Logic
            if (dbUsers[username]) {
                socket.emit("auth response", { success: false, message: "Username already exists!" });
            } else {
                dbUsers[username] = password;
                saveUsersToDB();
                allVisitedUsers.add(username);
                proceedUserSession(socket, username, password);
            }
        }
    });

    function proceedUserSession(socket, username, password) {
        socket.username = username;
        socket.currentRoom = "global";
        socket.join("global");
        
        onlineUsers[socket.id] = username;
        allVisitedUsers.add(username);
        
        socket.emit("auth response", { success: true, username: username, password: password });
        socket.to("global").emit("system", `${username} joined the chat`);
        broadcastUserLists();
        
        socket.emit("chat history", globalHistory);
        if (pinnedMessages["global"]) {
            socket.emit("pin message", pinnedMessages["global"]);
        }
    }

    // 👤 Realtime Profile Edit Handler
    socket.on("update profile", (data) => {
        const { oldName, newName, newPassword } = data;
        if (!socket.username || socket.username !== oldName) return;

        if (newName !== oldName && dbUsers[newName]) {
            socket.emit("profile response", { success: false, message: "This username is already taken!" });
            return;
        }

        const passwordToSave = newPassword ? newPassword : dbUsers[oldName];

        if (newName !== oldName) {
            dbUsers[newName] = passwordToSave;
            delete dbUsers[oldName];
            allVisitedUsers.delete(oldName);
            allVisitedUsers.add(newName);
            
            onlineUsers[socket.id] = newName;
            socket.username = newName;
        } else {
            dbUsers[oldName] = passwordToSave;
        }

        saveUsersToDB();
        socket.emit("profile response", { success: true, username: newName, password: passwordToSave });
        broadcastUserLists();
    });

    socket.on("switch room", (target) => {
        if (!socket.username) return;
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
        if (!socket.username) return;
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