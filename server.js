const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static("public"));

let users = 0;
let onlineUsers = [];
let reactions = {};
let messages = {};

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

    messages[data.id] = {
        user: socket.username,
        text: data.text
    };

    io.emit(
        "chat message",
        data
    );
});

socket.on(
    "delete message",
    (messageId) => {

        if(
            messages[messageId] &&
            messages[messageId].user === socket.username
        ){

            delete messages[messageId];

            io.emit(
                "delete message",
                messageId
            );
        }
    }
);
socket.on(
    "reaction",
    (data) => {

        const {
            messageId,
            emoji
        } = data;

        if(
            !reactions[messageId]
        ){
            reactions[messageId] = {};
        }

        if(
            !reactions[messageId][emoji]
        ){
            reactions[messageId][emoji] = [];
        }

        const users =
        reactions[messageId][emoji];

        const index =
        users.indexOf(
            socket.username
        );

        if(index > -1){

            users.splice(
                index,
                1
            );

        }else{

            users.push(
                socket.username
            );
        }

        io.emit(
            "reaction update",
            {
                messageId,
                reactions:
                reactions[messageId]
            }
        );
    }
);

socket.on(
    "edit message",
    (data) => {

        if(
            messages[data.id] &&
            messages[data.id].user === socket.username
        ){

            messages[data.id].text =
            data.text;

            io.emit(
                "edit message",
                data
            );
        }
    }
);

socket.on("typing", (username) => {

    socket.broadcast.emit(
        "typing",
        username
    );
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