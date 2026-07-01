const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const multer = require("multer");
const path = require("path");
const fs = require("fs");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static("public"));

if (!fs.existsSync("uploads")) {
    fs.mkdirSync("uploads");
}
app.use("/uploads", express.static("uploads"));

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, "uploads/"),
    filename: (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname))
});
const upload = multer({ storage });

// Core Data Structures
let allVisitedUsers = new Set(); // Jo log kabhi bhi visit kar chuke hain
let onlineUsers = {}; // { socketId: username }
let messagesByRoom = { "global": [] }; // Room wise chat history {"global": [...], "user1_user2": [...]}
let seenData = {};
let reactions = {};
let pinnedMessages = {}; // Room wise pin message

app.post("/upload", upload.single("file"), (req, res) => {
    if (!req.file) return res.status(400).json({ error: "No file" });
    res.json({ url: "/uploads/" + req.file.filename });
});

io.on("connection", (socket) => {
    console.log("A user connected");

    socket.on("new user", (username) => {
        socket.username = username;
        onlineUsers[socket.id] = username;
        allVisitedUsers.add(username); // Add to permanent list

        // Default sabhi ko pehle global room me daalenge
        socket.join("global");
        socket.currentRoom = "global";

        // Sabhi ko updated users list bhejna
        io.emit("update user lists", {
            online: Object.values(onlineUsers),
            allVisited: Array.from(allVisitedUsers)
        });

        io.to("global").emit("system", `${username} joined the chat`);
        
        // Initial history for global
        socket.emit("chat history", messagesByRoom["global"] || []);
        if (pinnedMessages["global"]) {
            socket.emit("pin message", pinnedMessages["global"]);
        }
    });

    // Room Switch Logic (Global <-> Private DM)
    socket.on("switch room", (targetUser) => {
        // Purane room ko chodo
        if (socket.currentRoom) {
            socket.leave(socket.currentRoom);
        }

        if (targetUser === "global") {
            socket.currentRoom = "global";
        } else {
            // Private Room ID unique honi chahiye, isliye alphabetical order me sort karenge
            // Agar Devesh aur Amit chat kar rahe hain toh room hamesha "Amit_Devesh" banega
            const roomID = [socket.username, targetUser].sort().join("_");
            socket.currentRoom = roomID;
        }

        socket.join(socket.currentRoom);

        // Naye room ki history bhejna
        if (!messagesByRoom[socket.currentRoom]) {
            messagesByRoom[socket.currentRoom] = [];
        }
        socket.emit("chat history", messagesByRoom[socket.currentRoom]);
        
        // Pin message handle karna naye room ka
        if (pinnedMessages[socket.currentRoom]) {
            socket.emit("pin message", pinnedMessages[socket.currentRoom]);
        } else {
            socket.emit("unpin message");
        }
    });

    socket.on("chat message", (data) => {
        const currentRoom = socket.currentRoom || "global";
        
        const msgData = {
            ...data,
            user: socket.username,
            room: currentRoom
        };

        if (!messagesByRoom[currentRoom]) {
            messagesByRoom[currentRoom] = [];
        }
        messagesByRoom[currentRoom].push(msgData);

        // Sirf usi room ke logo ko message bhejna
        io.to(currentRoom).emit("chat message", msgData);
    });

    socket.on("message seen", (data) => {
        if (!seenData[data.messageId]) seenData[data.messageId] = [];
        if (!seenData[data.messageId].includes(data.user)) {
            seenData[data.messageId].push(data.user);
        }
        io.to(socket.currentRoom).emit("message seen", {
            messageId: data.messageId,
            users: seenData[data.messageId]
        });
    });

    socket.on("delete message", (messageId) => {
        const room = socket.currentRoom;
        if (messagesByRoom[room]) {
            messagesByRoom[room] = messagesByRoom[room].filter(m => {
                if (m.id === messageId && m.user === socket.username) {
                    return false;
                }
                return true;
            });
            io.to(room).emit("delete message", messageId);
        }
    });

    socket.on("reaction", (data) => {
        const { messageId, emoji } = data;
        if (!reactions[messageId]) reactions[messageId] = {};
        if (!reactions[messageId][emoji]) reactions[messageId][emoji] = [];

        const usersList = reactions[messageId][emoji];
        const index = usersList.indexOf(socket.username);

        if (index > -1) usersList.splice(index, 1);
        else usersList.push(socket.username);

        io.to(socket.currentRoom).emit("reaction update", {
            messageId,
            reactions: reactions[messageId]
        });
    });

    socket.on("edit message", (data) => {
        const room = socket.currentRoom;
        if (messagesByRoom[room]) {
            const msg = messagesByRoom[room].find(m => m.id === data.id);
            if (msg && msg.user === socket.username) {
                msg.text = data.text;
                io.to(room).emit("edit message", data);
            }
        }
    });

    socket.on("typing", (username) => {
        socket.broadcast.to(socket.currentRoom).emit("typing", username);
    });

    socket.on("pin message", (text) => {
        const room = socket.currentRoom || "global";
        pinnedMessages[room] = text;
        io.to(room).emit("pin message", text);
    });

    socket.on("unpin message", () => {
        const room = socket.currentRoom || "global";
        pinnedMessages[room] = "";
        io.to(room).emit("unpin message");
    });

    socket.on("disconnect", () => {
        const username = onlineUsers[socket.id];
        delete onlineUsers[socket.id];

        io.emit("update user lists", {
            online: Object.values(onlineUsers),
            allVisited: Array.from(allVisitedUsers)
        });

        if (username) {
            io.to("global").emit("system", username + " left the chat");
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));