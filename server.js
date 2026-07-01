const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const multer = require("multer");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, "public")));

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, path.join(__dirname, "public/uploads"));
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
        
        if (socket.currentRoom === "global") {
            data.room = "global";
            globalHistory.push(data);
            io.to("global").emit("chat message", data);
        } else {
            data.room = socket.currentRoom; // compound key like "A-B"
            if (!dmHistories[socket.currentRoom]) dmHistories[socket.currentRoom] = [];
            dmHistories[socket.currentRoom].push(data);
            
            // CRITICAL FIX: Dono participants ko directly emit taaki sync instant ho
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
        io.to(socket.currentRoom).emit("reaction update", {
            messageId: data.messageId,
            reactions: { [data.emoji]: [socket.username] }
        });
    });

    socket.on("edit message", (data) => {
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