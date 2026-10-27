"use strict";

const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const db = require("../../config/db");

const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || "1h";

function passwordVersion(hash) {
    return crypto
        .createHash("sha256")
        .update(hash)
        .digest("hex");
}

function cookieOptions(token) {
    return {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "strict",
        maxAge: Math.max(
            0,
            jwt.decode(token).exp * 1000 - Date.now()
        )
    };
}

function clearTokenCookie(res) {
    res.clearCookie("token", {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "strict"
    });
}

// LOGIN
exports.login = async (req, res) => {
    try {
        const { email, password, role } = req.body || {};

        if (
            typeof email !== "string" ||
            !email.trim() ||
            typeof password !== "string" ||
            !password
        ) {
            return res.status(400).json({
                message: "Email and password are required."
            });
        }

        const [rows] = await db.execute(
            `SELECT id, name, email, role, password,
                    must_change_password
             FROM users
             WHERE email = ?
             LIMIT 1`,
            [email.trim().toLowerCase()]
        );

        const user = rows[0];

        if (
            !user ||
            !(await bcrypt.compare(password, user.password))
        ) {
            return res.status(401).json({
                message: "Invalid credentials."
            });
        }

        if (
            role &&
            role !== user.role &&
            user.role !== "super_admin"
        ) {
            return res.status(403).json({
                message: "This account cannot access the selected role."
            });
        }

        const mustChangePassword =
            Number(user.must_change_password) === 1;

        const token = jwt.sign(
            {
                id: user.id,
                email: user.email,
                role: user.role,
                purpose: mustChangePassword
                    ? "password_change"
                    : "access",
                pwdv: passwordVersion(user.password)
            },
            JWT_SECRET,
            {
                expiresIn: mustChangePassword
                    ? "15m"
                    : JWT_EXPIRES_IN
            }
        );

        res.cookie("token", token, cookieOptions(token));

        return res.status(200).json({
            message: mustChangePassword
                ? "Password change required."
                : "Login successful.",
            token,
            mustChangePassword,
            user: {
                id: user.id,
                name: user.name,
                email: user.email,
                role: user.role
            }
        });

    } catch (error) {
        console.error("LOGIN ERROR:", error);

        return res.status(500).json({
            message: "Internal server error."
        });
    }
};

// FIRST-TIME PASSWORD CHANGE
exports.changeFirstPassword = async (req, res) => {
    try {
        if (req.user?.purpose !== "password_change") {
            return res.status(403).json({
                message: "Password-change session required."
            });
        }

        const { newPassword, confirmPassword } = req.body || {};

        if (
            typeof newPassword !== "string" ||
            newPassword.length < 12 ||
            newPassword.length > 128 ||
            Buffer.byteLength(newPassword, "utf8") > 72
        ) {
            return res.status(400).json({
                message: "New password must be 12–128 characters and at most 72 UTF-8 bytes."
            });
        }

        if (newPassword !== confirmPassword) {
            return res.status(400).json({
                message: "Passwords do not match."
            });
        }

        const [rows] = await db.execute(
            `SELECT password, must_change_password
             FROM users
             WHERE id = ?
             LIMIT 1`,
            [req.user.id]
        );

        const user = rows[0];

        if (
            !user ||
            Number(user.must_change_password) !== 1 ||
            passwordVersion(user.password) !== req.user.pwdv
        ) {
            return res.status(403).json({
                message: "Password-change session expired. Please log in again."
            });
        }

        const samePassword = await bcrypt.compare(
            newPassword,
            user.password
        );

        if (samePassword) {
            return res.status(400).json({
                message: "Choose a different password from your temporary password."
            });
        }

        const hashedPassword = await bcrypt.hash(
            newPassword,
            12
        );

        const [result] = await db.execute(
            `UPDATE users
             SET password = ?,
                 must_change_password = 0
             WHERE id = ?
             AND password = ?
             AND must_change_password = 1`,
            [
                hashedPassword,
                req.user.id,
                user.password
            ]
        );

        if (!result.affectedRows) {
            return res.status(409).json({
                message: "Password changed in another session. Please log in again."
            });
        }

        clearTokenCookie(res);

        return res.json({
            message: "Password updated. Please log in using your new password."
        });

    } catch (error) {
        console.error("PASSWORD CHANGE ERROR:", error);

        return res.status(500).json({
            message: "Unable to change password."
        });
    }
};

// LOGOUT
exports.logout = (req, res) => {
    clearTokenCookie(res);

    return res.json({
        message: "Logged out successfully."
    });
};

// CURRENT USER
exports.me = (req, res) => {
    return res.json({
        user: req.user
    });
};
