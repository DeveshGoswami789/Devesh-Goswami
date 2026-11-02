require("dotenv").config();

const { createClient } = require("@libsql/client/web");

const db = createClient({
    url: process.env.TURSO_DATABASE_URL,
    authToken: process.env.TURSO_AUTH_TOKEN
});
async function initializeDatabase() {
    await db.execute(`
        CREATE TABLE IF NOT EXISTS users (
            username TEXT PRIMARY KEY,
            password TEXT NOT NULL
        )
    `);

    await db.execute(`
        CREATE TABLE IF NOT EXISTS messages (
            id TEXT PRIMARY KEY,
            room TEXT NOT NULL,
            user TEXT NOT NULL,
            text TEXT,
            data TEXT NOT NULL,
            created_at INTEGER DEFAULT (unixepoch())
        )
    `);

    await db.execute(`
        CREATE TABLE IF NOT EXISTS pinned_messages (
            room TEXT PRIMARY KEY,
            data TEXT NOT NULL
        )
    `);
const result = await db.execute(
    "SELECT room, data FROM messages ORDER BY created_at ASC"
);

for (const row of result.rows) {
    try {
        const message = JSON.parse(row.data);

        if (row.room === "global") {
            globalHistory.push(message);
        } else {
            if (!dmHistories[row.room]) {
                dmHistories[row.room] = [];
            }

            dmHistories[row.room].push(message);
        }
    } catch (error) {
        console.error("Message loading failed:", error.message);
    }
}
const usersResult = await db.execute("SELECT username, password FROM users");

for (const row of usersResult.rows) {
    dbUsers[row.username] = row.password;
}

console.log("Users loaded from Turso!");
const pinnedResult = await db.execute(
    "SELECT room, data FROM pinned_messages"
);

for (const row of pinnedResult.rows) {
    try {
        pinnedMessages[row.room] = JSON.parse(row.data);
    } catch (error) {
        console.error("Pinned message loading failed:", error.message);
    }
}
    console.log("Turso tables created successfully!");
}
async function saveMessageToTurso(data) {
    await db.execute({
        sql: `
            INSERT INTO messages (id, room, user, text, data)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                room = excluded.room,
                user = excluded.user,
                text = excluded.text,
                data = excluded.data
        `,
        args: [
            String(data.id),
            data.room,
            data.user,
            data.text || "",
            JSON.stringify(data)
        ]
    });
}
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

// 唐 Public files serve karna
app.use(express.static(path.join(__dirname, "public")));

// 唐 Auto Create Uploads Directory if it doesn't exist (Render Storage Friendly)
const uploadDir = path.join(__dirname, "public", "uploads");
if (!fs.existsSync(uploadDir)){
    fs.mkdirSync(uploadDir, { recursive: true });
}

// 柏 File-Based Database logic for User Authentication
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
async function saveUserToTurso(username, password) {
    await db.execute({
        sql: `
            INSERT INTO users (username, password)
            VALUES (?, ?)
            ON CONFLICT(username) DO UPDATE SET
                password = excluded.password
        `,
        args: [username, password]
    });
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
    
    // 孱ｸAuth Logic Handler
    socket.on("auth user", async (data) => {
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
await saveUserToTurso(username, password);
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

    // 👑 ADMIN CONTROLS ENGINE LISTENERS
    socket.on("admin delete all chats", async () => {
    try {
        // Delete all chat messages from Turso
        await db.execute("DELETE FROM messages");

        // Delete all pinned messages from Turso
        await db.execute("DELETE FROM pinned_messages");

        // Clear in-memory chat histories
        globalHistory = [];
        dmHistories = {};
        pinnedMessages = {};

        // Notify all connected users
        io.emit("chat history", []);
        io.emit("unpin message");
        io.emit("system", "👑 Admin has wiped all conversations history.");

        console.log("Admin cleared all chats from Turso!");

    } catch (error) {
        console.error("Admin delete all chats failed:", error.message);
    }
});

    socket.on("admin broadcast announcement", (msgText) => {
        io.emit("system", `📢 ADMIN ANNOUNCEMENT: ${msgText}`);
    });

    socket.on("admin get users credentials", () => {
        socket.emit("admin users list response", dbUsers);
    });

 socket.on("admin delete single message", async (data) => {
    const { id, room } = data || {};

    if (!id || !room) return;

    try {
        // Delete message from Turso
        await db.execute({
            sql: "DELETE FROM messages WHERE id = ? AND room = ?",
            args: [String(id), room]
        });

        // Remove pin if this message was pinned
        if (
            pinnedMessages[room] &&
            String(pinnedMessages[room].id) === String(id)
        ) {
            await db.execute({
                sql: "DELETE FROM pinned_messages WHERE room = ?",
                args: [room]
            });

            delete pinnedMessages[room];
            io.to(room).emit("unpin message");
        }

        // Update in-memory history
        if (room === "global") {
            globalHistory = globalHistory.filter(
                m => String(m.id) !== String(id)
            );
        } else if (dmHistories[room]) {
            dmHistories[room] = dmHistories[room].filter(
                m => String(m.id) !== String(id)
            );
        }

        // Notify users in that room
        io.to(room).emit("delete message", id);

        console.log("Admin deleted message from Turso:", id);

    } catch (error) {
        console.error("Admin message delete failed:", error.message);
    }
});

    // 側 Realtime Profile Edit Handler
    socket.on("update profile", async (data) => {
    const { oldName, newName, newPassword } = data;

    if (!socket.username || socket.username !== oldName) return;

    if (newName !== oldName && dbUsers[newName]) {
        socket.emit("profile response", {
            success: false,
            message: "This username is already taken!"
        });
        return;
    }

    const passwordToSave = newPassword
        ? newPassword
        : dbUsers[oldName];

    try {
        await db.execute({
            sql: `INSERT INTO users (username, password)
                  VALUES (?, ?)
                  ON CONFLICT(username)
                  DO UPDATE SET password = excluded.password`,
            args: [newName, passwordToSave]
        });

        if (newName !== oldName) {
            await db.execute({
                sql: "DELETE FROM users WHERE username = ?",
                args: [oldName]
            });

            delete dbUsers[oldName];

            allVisitedUsers.delete(oldName);
            allVisitedUsers.add(newName);

            onlineUsers[socket.id] = newName;
            socket.username = newName;
        }

        dbUsers[newName] = passwordToSave;

        socket.emit("profile response", {
            success: true,
            username: newName,
            password: passwordToSave
        });

        broadcastUserLists();

    } catch (error) {
        console.error("Profile update failed:", error.message);

        socket.emit("profile response", {
            success: false,
            message: "Profile update failed. Please try again."
        });
    }
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

    socket.on("chat message", async (data) => {
    if (!socket.username) return;

    data.user = socket.username;
    data.reactions = {};

    if (socket.currentRoom === "global") {
        data.room = "global";
    } else {
        data.room = socket.currentRoom;
    }

    try {
        await saveMessageToTurso(data);
    } catch (error) {
        console.error("Message save failed:", error.message);
    }

    if (socket.currentRoom === "global") {
        globalHistory.push(data);
        io.to("global").emit("chat message", data);
    } else {
        if (!dmHistories[socket.currentRoom]) {
            dmHistories[socket.currentRoom] = [];
        }

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

   socket.on("reaction", async (data) => {
    if (!socket.username) return;

    let msgTarget = null;

    if (socket.currentRoom === "global") {
        msgTarget = globalHistory.find(m => m.id == data.messageId);
    } else {
        if (dmHistories[socket.currentRoom]) {
            msgTarget = dmHistories[socket.currentRoom].find(
                m => m.id == data.messageId
            );
        }
    }

    if (!msgTarget) return;

    if (!msgTarget.reactions) {
        msgTarget.reactions = {};
    }

    if (!msgTarget.reactions[data.emoji]) {
        msgTarget.reactions[data.emoji] = [];
    }

    if (msgTarget.reactions[data.emoji].includes(socket.username)) {
        msgTarget.reactions[data.emoji] =
            msgTarget.reactions[data.emoji].filter(
                u => u !== socket.username
            );
    } else {
        msgTarget.reactions[data.emoji].push(socket.username);
    }

    try {
        await saveMessageToTurso(msgTarget);
    } catch (error) {
        console.error("Reaction save failed:", error.message);
    }

    io.to(socket.currentRoom).emit("reaction update", {
        messageId: data.messageId,
        reactions: msgTarget.reactions
    });
});

   socket.on("edit message", async (data) => {
    if (!socket.username) return;

    let msgTarget = null;

    if (socket.currentRoom === "global") {
        msgTarget = globalHistory.find(m => m.id == data.id);
    } else if (dmHistories[socket.currentRoom]) {
        msgTarget = dmHistories[socket.currentRoom].find(m => m.id == data.id);
    }

    if (!msgTarget) return;

    msgTarget.text = data.text;

    try {
        await saveMessageToTurso(msgTarget);
    } catch (error) {
        console.error("Message edit save failed:", error.message);
        return;
    }

    io.to(socket.currentRoom).emit("edit message", data);
});

   socket.on("pin message", async (data) => {
    let pinPayload = { text: "", id: "" };

    if (data && typeof data === "object") {
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

    try {
        await db.execute({
            sql: `INSERT INTO pinned_messages (room, data)
                  VALUES (?, ?)
                  ON CONFLICT(room)
                  DO UPDATE SET data = excluded.data`,
            args: [socket.currentRoom, JSON.stringify(pinPayload)]
        });

        pinnedMessages[socket.currentRoom] = pinPayload;
        io.to(socket.currentRoom).emit("pin message", pinPayload);

    } catch (error) {
        console.error("Pin save failed:", error.message);
    }
});

socket.on("unpin message", async () => {
    try {
        await db.execute({
            sql: "DELETE FROM pinned_messages WHERE room = ?",
            args: [socket.currentRoom]
        });

        delete pinnedMessages[socket.currentRoom];
        io.to(socket.currentRoom).emit("unpin message");

    } catch (error) {
        console.error("Unpin failed:", error.message);
    }
});
    socket.on("delete message", async (id) => {
    if (!socket.username) return;

    const room = socket.currentRoom;

    try {
        // Delete message from Turso
        await db.execute({
            sql: "DELETE FROM messages WHERE id = ?",
            args: [String(id)]
        });

        // If this message is pinned, remove its pin too
        if (
            pinnedMessages[room] &&
            String(pinnedMessages[room].id) === String(id)
        ) {
            await db.execute({
                sql: "DELETE FROM pinned_messages WHERE room = ?",
                args: [room]
            });

            delete pinnedMessages[room];
            io.to(room).emit("unpin message");
        }

        // Update in-memory history
        if (room === "global") {
            globalHistory = globalHistory.filter(m => m.id != id);
        } else if (dmHistories[room]) {
            dmHistories[room] = dmHistories[room].filter(m => m.id != id);
        }

        // Notify everyone in the room
        io.to(room).emit("delete message", id);

    } catch (error) {
        console.error("Message delete failed:", error.message);
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

async function startServer() {
    try {
        await initializeDatabase();

        console.log("Turso database connected successfully!");

        server.listen(PORT, "0.0.0.0", () => {
            console.log(`Server running safely on port ${PORT}`);
        });

    } catch (error) {
        console.error("Turso connection failed:", error.message);
        process.exit(1);
    }
}

startServer();