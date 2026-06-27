const sqlite3 = require("sqlite3").verbose();

const db = new sqlite3.Database("chat.db", (err) => {
    if (err) {
        console.log("SQLite Error:", err.message);
    } else {
        console.log("SQLite Connected");
    }
});

db.serialize(() => {

    db.run(`
        CREATE TABLE IF NOT EXISTS messages (
            id TEXT PRIMARY KEY,
            user TEXT,
            text TEXT,
            image TEXT,
            audio TEXT,
            time INTEGER,
            reply TEXT
        )
    `);

});

module.exports = db;