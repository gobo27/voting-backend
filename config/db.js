
"use strict";

const mysql = require("mysql2");
require("dotenv").config();

const pool = mysql.createPool({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,

    waitForConnections: true,
    connectionLimit: 3,
    maxIdle: 2,
    idleTimeout: 30000,
    queueLimit: 0,

    connectTimeout: 20000,
    enableKeepAlive: true,
    keepAliveInitialDelay: 10000
});

const promisePool = pool.promise();

// Test database connection when backend starts.
async function testConnection() {
    try {
        const [rows] = await promisePool.query(
            "SELECT DATABASE() AS db, @@hostname AS host"
        );

        console.log("CONNECTED DATABASE:", rows[0]);

    } catch (error) {
        console.error("MySQL connection failed:", {
            code: error.code,
            message: error.message
        });
    }
}

testConnection();

// Preserve existing export format.
module.exports = promisePool;
