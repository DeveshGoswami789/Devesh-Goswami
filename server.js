const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static("public"));

let users = 0;
let onlineUsers = [];

io.on("connection", (socket) => {
    users++;
    io.emit("users count", users);

    console.log("User connected");

    socket.on("new user", (username) => {
    socket.username = username;

    onlineUsers.push(username);

    io.emit("online users", onlineUsers);

    io.emit("system", username + " joined the chat");
});

    socket.on("chat message", (data) => {
        io.emit("chat message", data);
    });

    socket.on("disconnect", () => {
        users--;
        io.emit("users count", users);

        if (socket.username) {

    onlineUsers =
    onlineUsers.filter(
        user => user !== socket.username
    );

    io.emit(
        "online users",
        onlineUsers
    );

    io.emit(
        "system",
        socket.username + " left the chat"
    );
}
    });
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});